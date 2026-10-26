// Prueba de que el tope se aplica ONCHAIN, sin backend ni facilitador:
//
// 1. El duenio sube el tope para dejar 0.01 USDC disponibles.
// 2. El agente firma un pago x402 de 0.01 (simula OK: entra en el tope).
// 3. El duenio baja el tope (remaining = 0).
// 4. Mandamos ESE pago ya firmado directo a la red desde una cuenta cualquiera
//    (PAYER), salteando servidor y facilitador. El ledger ejecuta __check_auth de la
//    PassportAccount y la tx sale FAILED con Error(Contract, #6) = CapExceeded.
//
// Uso: node scripts/prove-onchain-cap.mjs
import { execFileSync } from "node:child_process";
import { Keypair, Networks, Operation, rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { PassportAccountExactScheme } from "../agent/src/passport-account-scheme.mjs";

process.loadEnvFile(new URL("../.env", import.meta.url));
const server = new rpc.Server(process.env.RPC_URL);
const ACCOUNT = process.env.PASSPORT_ACCOUNT_ID;
const PRICE = 100_000n; // 0.01 USDC

function cli(...args) {
  return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function status() {
  return JSON.parse(cli("contract", "invoke", "--id", ACCOUNT, "--source", "pp-owner", "--network", "testnet", "--send=no", "--", "spend_status"));
}
function setCap(cap) {
  cli("contract", "invoke", "--id", ACCOUNT, "--source", "pp-owner", "--network", "testnet", "--", "set_cap", "--cap", String(cap), "--period_ledgers", "17280");
}

const s0 = status();
console.log("estado inicial:", JSON.stringify(s0));
const spent = BigInt(s0.spent);
setCap(spent + PRICE);
console.log("1) tope subido a", String(spent + PRICE), "->", JSON.stringify(status()));

const scheme = new PassportAccountExactScheme({ accountId: ACCOUNT, agentSecret: process.env.AGENT_SECRET });
const { payload } = await scheme.createPaymentPayload(2, {
  scheme: "exact", network: "stellar:testnet", asset: USDC_TESTNET_ADDRESS,
  payTo: process.env.MERCHANT_PUBLIC, amount: String(PRICE), maxTimeoutSeconds: 300,
  extra: { areFeesSponsored: true },
});
console.log("2) pago de 0.01 firmado por el agente (simulacion OK)");

setCap(spent);
console.log("3) tope bajado a", String(spent), "->", JSON.stringify(status()));

const signed = TransactionBuilder.fromXDR(payload.transaction, Networks.TESTNET);
const op = signed.operations[0];
const payer = Keypair.fromSecret(process.env.PAYER_SECRET);
const src = await server.getAccount(payer.publicKey());
const sorobanData = signed.toEnvelope().v1().tx().ext().sorobanData();
const tx = new TransactionBuilder(src, { fee: signed.fee, networkPassphrase: Networks.TESTNET, sorobanData })
  .addOperation(Operation.invokeHostFunction({ func: op.func, auth: op.auth }))
  .setTimeout(120)
  .build();
tx.sign(payer);
const sent = await server.sendTransaction(tx);
console.log("4) enviado directo a la red:", sent.status, sent.hash);
let r;
for (let i = 0; i < 30; i++) {
  r = await server.getTransaction(sent.hash);
  if (r.status !== "NOT_FOUND") break;
  await new Promise((ok) => setTimeout(ok, 1000));
}
console.log("resultado onchain:", r.status);
if (r.status === "FAILED") {
  const diag = (r.diagnosticEventsXdr ?? []).map((e) => JSON.stringify(e.event().body().v0().data().value?.() ?? "")).join(" ");
  const m = /Error\(Contract, #\d+\)|#6|CapExceeded/.exec(JSON.stringify(r.resultXdr) + diag);
  console.log("resultXdr:", r.resultXdr?.result().switch().name, "detalle:", m ? m[0] : "(ver explorer)");
}
console.log(`FAILED_TX_HASH=${sent.hash} https://stellar.expert/explorer/testnet/tx/${sent.hash}`);
console.log("estado final:", JSON.stringify(status()));
process.exitCode = r.status === "FAILED" ? 0 : 1;
