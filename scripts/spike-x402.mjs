// Spike x402 (hora 1): UN pago real en stellar:testnet.
//
// - Servidor Express con GET /paid (0.01 USDC) protegido por @x402/express.
// - Facilitador LOCAL en el mismo proceso (ExactStellarScheme de
//   @x402/stellar/exact/facilitator) firmando y pagando fees con FACILITATOR_SECRET.
//   No usa OZ Channels: su API key sale de un formulario web y no se puede automatizar.
// - Cliente @x402/fetch con firmante ed25519 (cuenta G, PAYER_SECRET) o con
//   PassportAccountExactScheme (cuenta contrato C..., clave AGENT_SECRET).
//
// Uso:
//   node scripts/spike-x402.mjs                      # pagador G, 1 pago
//   node scripts/spike-x402.mjs --payer=account      # PassportAccount, 6 pagos (tope 0.05 => el 6to falla)
//   node scripts/spike-x402.mjs --payer=account --count=0 --concurrent=2
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createEd25519Signer, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { ExactStellarScheme as ServerScheme } from "@x402/stellar/exact/server";
import { ExactStellarScheme as ClientScheme } from "@x402/stellar/exact/client";
import { ExactStellarScheme as FacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { PassportAccountExactScheme } from "../agent/src/passport-account-scheme.mjs";

process.loadEnvFile(new URL("../.env", import.meta.url));
const NETWORK = process.env.X402_NETWORK ?? "stellar:testnet";

// --- facilitador local ------------------------------------------------------
const facilitator = new x402Facilitator().register(
  NETWORK,
  new FacilitatorScheme([createEd25519Signer(process.env.FACILITATOR_SECRET, NETWORK)], {
    // El default (50_000 stroops) rechaza hasta un transfer simple de la SAC en testnet
    // (invalid_exact_stellar_payload_fee_exceeds_maximum): un pago normal cuesta ~86k stroops
    // y el PRIMER pago desde una PassportAccount costo ~3.46 XLM en testnet (oct 2026). Techo: 10 XLM.
    maxTransactionFeeStroops: Number(process.env.FACILITATOR_MAX_FEE_STROOPS ?? 100_000_000),
  }),
);
// x402ResourceServer espera un FacilitatorClient con getSupported async.
const localFacilitatorClient = {
  verify: (p, r) => facilitator.verify(p, r),
  settle: (p, r) => facilitator.settle(p, r),
  getSupported: async () => facilitator.getSupported(),
};

// --- servidor ---------------------------------------------------------------
const resourceServer = new x402ResourceServer(localFacilitatorClient).register(
  NETWORK,
  new ServerScheme(),
);
const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /paid": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network: NETWORK,
          payTo: process.env.MERCHANT_PUBLIC,
        },
        description: "Passport Pay spike: recurso pago",
      },
    },
    resourceServer,
  ),
);
app.get("/paid", (_req, res) => res.json({ ok: true, secret: "contenido pago", at: new Date().toISOString() }));
const srv = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const url = `http://127.0.0.1:${srv.address().port}/paid`;

// Modo: --payer=g (cuenta G, cliente oficial) | --payer=account (PassportAccount C...).
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=")[1];
const MODE = arg("payer", "g");
const COUNT = Number(arg("count", MODE === "account" ? 6 : 1));
const CONCURRENT_TAIL = Number(arg("concurrent", 0));

function makeClient() {
  if (MODE === "account") {
    return {
      payer: process.env.PASSPORT_ACCOUNT_ID,
      client: new PassportAccountExactScheme({
        accountId: process.env.PASSPORT_ACCOUNT_ID,
        agentSecret: process.env.AGENT_SECRET,
      }),
    };
  }
  const signer = createEd25519Signer(process.env.PAYER_SECRET, NETWORK);
  return { payer: signer.address, client: new ClientScheme(signer) };
}

async function payOnce(fetchPay, i) {
  try {
    const res = await fetchPay(url);
    const body = await res.json().catch(() => ({}));
    const hdr = res.headers.get("payment-response");
    const settle = hdr ? decodePaymentResponseHeader(hdr) : null;
    let reason = "";
    if (res.status === 402 && res.headers.get("payment-required")) {
      reason = decodePaymentRequiredHeader(res.headers.get("payment-required")).error ?? "";
    }
    console.log(`#${i} -> ${res.status} ${settle?.success ? "OK" : "RECHAZADO"} tx=${settle?.transaction || "-"} ${reason} ${res.status === 200 ? JSON.stringify(body) : ""}`);
    return { ok: res.status === 200 && settle?.success, tx: settle?.transaction, reason };
  } catch (e) {
    const msg = String(e?.message ?? e) + (e?.cause ? ` (cause: ${e.cause?.message ?? e.cause})` : "");
    const m = msg.match(/Error\(Contract, #\d+\)/);
    console.log(`#${i} -> el cliente no pudo armar el pago: ${m ? m[0] : msg.slice(0, 300)}`);
    return { ok: false, reason: m ? m[0] : msg.slice(0, 300) };
  }
}

try {
  // 1) sin pago: tiene que dar 402
  const r402 = await fetch(url);
  console.log("sin pago ->", r402.status, "PAYMENT-REQUIRED header:", r402.headers.has("payment-required"));

  // 2) con pago
  const { payer, client } = makeClient();
  console.log(`modo=${MODE} payer=${payer} payTo=${process.env.MERCHANT_PUBLIC} asset=${USDC_TESTNET_ADDRESS}`);
  const fetchPay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: NETWORK, client }] });
  const results = [];
  for (let i = 1; i <= COUNT; i++) results.push(await payOnce(fetchPay, i));
  if (CONCURRENT_TAIL > 0) {
    console.log(`-- ${CONCURRENT_TAIL} pagos en paralelo --`);
    results.push(...(await Promise.all(Array.from({ length: CONCURRENT_TAIL }, (_, k) => payOnce(fetchPay, `p${k + 1}`)))));
  }
  for (const r of results) if (r.tx) console.log(`TX_HASH=${r.tx} https://stellar.expert/explorer/testnet/tx/${r.tx}`);
  process.exitCode = results.some((r) => r.ok) ? 0 : 1;
} finally {
  srv.close();
}
