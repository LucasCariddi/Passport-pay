// Tests del agente sin red: parseo de la CLI, montos, errores del contrato y el flujo
// x402 de payAndFetch contra respuestas HTTP falsas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { parseCli, resolveEndpoint } from "../src/cli.mjs";
import { byReason, extractContractError } from "../src/errors.mjs";
import { baseToUsdc, createOnchain, usdcToBase } from "../src/onchain.mjs";
import { OnchainRejection } from "../src/passport-account-scheme.mjs";
import { payAndFetch } from "../src/pay.mjs";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = "GCLNNJKDE7YK5BYOCIW3SOZW7NBPBCKPKXONLRYVUQRO5VZCGLVCVPPJ";

test("parseCli y resolveEndpoint", () => {
  const p = parseCli(["call", "report", "--amount", "0.5", "--no-preflight", "--param", "topic=fees"]);
  assert.equal(p.cmd, "call");
  assert.deepEqual(p.rest, ["report"]);
  assert.equal(p.opts.preflight, false);
  assert.equal(p.opts["force-onchain"], false);
  const s = "http://127.0.0.1:4021";
  assert.equal(resolveEndpoint("insight", { serverUrl: s }), `${s}/api/premium/insight`);
  assert.equal(resolveEndpoint("report", { serverUrl: s, amount: "0.5", params: ["topic=fees"] }), `${s}/api/premium/report?usd=0.5&topic=fees`);
  assert.equal(resolveEndpoint("/api/premium/quote", { serverUrl: s }), `${s}/api/premium/quote`);
  assert.equal(resolveEndpoint("http://x:1/a", { serverUrl: s }), "http://x:1/a");
  assert.throws(() => resolveEndpoint("report", { serverUrl: s, amount: "1e3" }), /--amount/);
  assert.throws(() => parseCli(["call", "--inventada"]), /Unknown option/);
});

test("montos USDC <-> unidades base (7 decimales)", () => {
  assert.equal(usdcToBase("0.01"), 100_000n);
  assert.equal(usdcToBase("50"), 500_000_000n);
  assert.equal(usdcToBase("0.0000001"), 1n);
  assert.throws(() => usdcToBase("0.00000001"));
  assert.throws(() => usdcToBase("-1"));
  assert.equal(baseToUsdc(700_000n), "0.07");
  assert.equal(baseToUsdc("500000000"), "50");
  assert.equal(baseToUsdc(0), "0");
});

test("errores del contrato", () => {
  assert.equal(extractContractError("HostError: Error(Contract, #6)").name, "CapExceeded");
  assert.deepEqual(byReason("revoked").code, 1);
  assert.equal(byReason("payer_not_passport_account"), null);
  const r = new OnchainRejection("enforcing", new Error("simulation failed: HostError: Error(Auth, InvalidAction) ... Error(Contract, #6)"));
  assert.equal(r.contractError.code, 6);
  assert.match(r.message, /CapExceeded/);
});

test("contractErrorFromDiagnostics encuentra el código en un evento de diagnóstico", () => {
  const oc = createOnchain({ rpcUrl: "http://x", server: {} });
  const err = xdr.ScVal.scvError(xdr.ScError.sceContract(6));
  const ev = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics: [nativeToScVal("error", { type: "symbol" }), err], data: nativeToScVal("x") })),
    }),
  });
  assert.equal(oc.contractErrorFromDiagnostics([ev]).name, "CapExceeded");
  assert.equal(oc.contractErrorFromDiagnostics([ev]).account, undefined);
  assert.equal(oc.contractErrorFromDiagnostics([]), null);
});

test("contractErrorFromDiagnostics atribuye el error a la cuenta que falló la auth", () => {
  const oc = createOnchain({ rpcUrl: "http://x", server: {} });
  const ACC = "CDTC2YRISEGPR53ZNTHXOVQVUGOUQOBMDUY66TF5OK5TI2FZZMV4M6UH";
  const OTHER = "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA";
  const diagEv = (topics, data) =>
    new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: null,
        type: xdr.ContractEventType.diagnostic(),
        body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
      }),
    });
  const errSym = nativeToScVal("error", { type: "symbol" });
  const authFail = (acc, code) =>
    diagEv([errSym, xdr.ScVal.scvError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()))],
      xdr.ScVal.scvVec([
        xdr.ScVal.scvString("failed account authentication with error"),
        nativeToScVal(acc, { type: "address" }),
        xdr.ScVal.scvError(xdr.ScError.sceContract(code)),
      ]));
  // Un #1 suelto (p. ej. InternalError de la SAC) antes del evento de auth no se toma.
  const stray = diagEv([errSym, xdr.ScVal.scvError(xdr.ScError.sceContract(1))], nativeToScVal("x"));
  const ce = oc.contractErrorFromDiagnostics([stray, authFail(ACC, 6)], ACC);
  assert.equal(ce.code, 6);
  assert.equal(ce.name, "CapExceeded");
  assert.equal(ce.account, ACC);
  // Si la auth que falló es de otra cuenta, no se atribuye a la nuestra.
  const other = oc.contractErrorFromDiagnostics([authFail(OTHER, 6)], ACC);
  assert.notEqual(other?.account, ACC);
});

// --- payAndFetch con HTTP falso ---------------------------------------------
const REQ = (amount = "100000") => ({
  scheme: "exact",
  network: "stellar:testnet",
  amount,
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
});
const paymentRequired = (amount, error = "Payment required") => ({
  x402Version: 2,
  error,
  resource: { url: "http://s/api/premium/insight", description: "x", mimeType: "application/json" },
  accepts: [REQ(amount)],
});

function fakeFetch({ amount = "100000", second }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const paid = init?.headers && Object.keys(init.headers).some((k) => /payment-signature/i.test(k));
    if (!paid) {
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired(amount)) } });
    }
    return second(amount);
  };
  fn.calls = calls;
  return fn;
}
const okScheme = {
  scheme: "exact",
  findDefaultAsset: () => ({ address: USDC, decimals: 7, symbol: "USDC" }),
  createPaymentPayload: async (v) => ({ x402Version: v, payload: { transaction: "AAAA" } }),
};

test("payAndFetch: pago OK devuelve body y hash del settle", async () => {
  const f = fakeFetch({
    second: () =>
      new Response(JSON.stringify({ insight: "ok" }), {
        status: 200,
        headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: "ab".repeat(32), network: "stellar:testnet", payer: "C" }) },
      }),
  });
  const r = await payAndFetch({ url: "http://s/api/premium/insight", scheme: okScheme, fetchImpl: f });
  assert.equal(r.outcome, "paid");
  assert.equal(r.settle.transaction, "ab".repeat(32));
  assert.equal(r.body.insight, "ok");
  assert.equal(f.calls.length, 2);
});

test("payAndFetch: rechazo en la simulación onchain del agente no llega al servidor", async () => {
  const f = fakeFetch({ second: () => assert.fail("no debería reintentar") });
  const scheme = { ...okScheme, createPaymentPayload: async () => { throw new OnchainRejection("enforcing", new Error("HostError: Error(Contract, #6)")); } };
  const r = await payAndFetch({ url: "http://s/x", scheme, fetchImpl: f });
  assert.equal(r.outcome, "rejected_onchain_simulation");
  assert.equal(r.contractError.reason, "cap_exceeded");
  assert.equal(r.requirement.amount, "100000");
  assert.equal(f.calls.length, 1);
});

test("payAndFetch: el servidor devuelve 402 cap_exceeded (simulación del facilitador)", async () => {
  const f = fakeFetch({
    second: (amount) => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired(amount, "cap_exceeded")) } }),
  });
  const r = await payAndFetch({ url: "http://s/x", scheme: okScheme, fetchImpl: f });
  assert.equal(r.outcome, "rejected_by_server");
  assert.equal(r.reason, "cap_exceeded");
  assert.equal(r.contractError.code, 6);
});

test("payAndFetch: el límite local del cliente se distingue del tope onchain", async () => {
  const f = fakeFetch({ amount: "50000000", second: () => assert.fail("no debería pagar") });
  const r = await payAndFetch({ url: "http://s/x", scheme: okScheme, fetchImpl: f, maxAmountUsd: "$1" });
  assert.equal(r.outcome, "rejected_client_limit");
});
