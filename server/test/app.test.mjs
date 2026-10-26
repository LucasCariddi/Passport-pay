// Flujo HTTP x402 completo contra la app real, con facilitador y chain falsos.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { createApp, createRecentLog, parseReportPrice } from "../src/app.mjs";
import { createPassportFacilitatorClient } from "../src/facilitator.mjs";
import { BAD, fakeChain, fakeClientScheme, fakeData, fakeInnerFacilitator, GOOD, listen, NETWORK, PASS, PAY_TO, testConfig, USDC } from "./helpers.mjs";

function build({ behavior, chain = fakeChain() } = {}) {
  const inner = fakeInnerFacilitator(behavior);
  const recent = createRecentLog();
  const logs = [];
  const facilitator = createPassportFacilitatorClient({ inner: inner.client, chain, networkPassphrase: PASS, log: (l) => logs.push(l), record: (r) => recent.push(r) });
  const app = createApp({ cfg: testConfig(), chain, facilitator, data: fakeData, recent, log: (l) => logs.push(l), syncFacilitatorOnStart: true });
  return { app, inner, recent, logs };
}

async function pay(url, from) {
  const client = x402Client.fromConfig({ schemes: [{ network: NETWORK, client: fakeClientScheme(from) }], spendControls: false });
  const http = new x402HTTPClient(client);
  const r1 = await fetch(url);
  assert.equal(r1.status, 402);
  const pr = http.getPaymentRequiredResponse((n) => r1.headers.get(n), await r1.json().catch(() => undefined));
  const payload = await client.createPaymentPayload(pr);
  const r2 = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
  const body = await r2.json().catch(() => undefined);
  const settle = r2.headers.get("payment-response") ? decodePaymentResponseHeader(r2.headers.get("payment-response")) : undefined;
  const required = r2.headers.get("payment-required") ? decodePaymentRequiredHeader(r2.headers.get("payment-required")) : undefined;
  return { status: r2.status, body, settle, required };
}

describe("rutas sin pago", () => {
  let s;
  before(async () => (s = await listen(build().app)));
  after(() => s.close());

  test("/health y /api/health", async () => {
    for (const p of ["/health", "/api/health"]) {
      const j = await (await fetch(s.url + p)).json();
      assert.equal(j.ok, true);
      assert.equal(j.network, NETWORK);
      assert.equal(j.payTo, PAY_TO);
      assert.equal(j.asset, USDC);
    }
  });

  test("CORS expone los headers x402", async () => {
    const r = await fetch(s.url + "/api/premium/insight", { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.match(r.headers.get("access-control-expose-headers"), /PAYMENT-RESPONSE/);
  });

  test("HEAD a una ruta paga no corre el handler gratis", async () => {
    for (const p of ["/api/premium/insight", "/api/premium/quote", "/api/premium/report?usd=1"]) {
      const r = await fetch(s.url + p, { method: "HEAD" });
      assert.equal(r.status, 405, p);
      assert.equal(r.headers.get("allow"), "GET");
    }
  });

  test("/api/accounts valida la dirección y devuelve admisión", async () => {
    assert.equal((await fetch(s.url + "/api/accounts/nope")).status, 400);
    const j = await (await fetch(`${s.url}/api/accounts/${GOOD}`)).json();
    assert.equal(j.admitted, true);
    assert.equal(j.balance, "1000000");
  });

  test("/api/payments pasa account y limit al chain", async () => {
    const j = await (await fetch(`${s.url}/api/payments?account=${GOOD}&limit=3`)).json();
    assert.equal(j[0].query.from, GOOD);
    assert.equal(j[0].query.limit, 3);
    const k = await (await fetch(`${s.url}/api/payments`)).json();
    assert.equal(k[0].query.to, PAY_TO, "sin account lista lo cobrado por el comercio");
  });
});

describe("402 con precios distintos", () => {
  let s;
  before(async () => (s = await listen(build().app)));
  after(() => s.close());

  const req402 = async (p) => {
    const r = await fetch(s.url + p);
    assert.equal(r.status, 402);
    return decodePaymentRequiredHeader(r.headers.get("payment-required")).accepts[0];
  };

  test("insight cuesta 0.01 USDC y quote 0.02", async () => {
    const a = await req402("/api/premium/insight");
    assert.equal(a.amount, "100000");
    assert.equal(a.asset, USDC);
    assert.equal(a.payTo, PAY_TO);
    assert.equal(a.network, NETWORK);
    assert.equal((await req402("/api/premium/quote")).amount, "200000");
  });

  test("report cobra lo que pide ?usd=", async () => {
    assert.equal((await req402("/api/premium/report?usd=0.5")).amount, "5000000");
    assert.equal((await req402("/api/premium/report")).amount, "500000", "sin usd usa el mínimo");
  });

  test("report con usd inválido es 400, no 402", async () => {
    for (const q of ["abc", "1000", "0.01", "1.123456789"]) {
      assert.equal((await fetch(`${s.url}/api/premium/report?usd=${q}`)).status, 400, q);
    }
  });

  test("parseReportPrice", () => {
    const lim = { reportMin: "0.05", reportMax: "100" };
    assert.deepEqual(parseReportPrice("0.3", lim), { usd: "0.3" });
    assert.ok(parseReportPrice("-1", lim).error);
    assert.ok(parseReportPrice(["1", "2"], lim).error);
  });
});

describe("pago x402", () => {
  test("pagador PassportAccount: 200, paidBy y hash en PAYMENT-RESPONSE", async () => {
    const b = build();
    const s = await listen(b.app);
    try {
      const r = await pay(`${s.url}/api/premium/insight?topic=fees`, GOOD);
      assert.equal(r.status, 200);
      assert.equal(r.body.topic, "fees");
      assert.equal(r.body.paidBy.payer, GOOD);
      assert.equal(r.body.paidBy.amount, "100000");
      assert.equal(r.settle.success, true);
      assert.match(r.settle.transaction, /^[0-9a-f]{64}$/);
      const rec = b.recent.list();
      assert.equal(rec[0].kind, "paid");
      assert.match(rec[0].link, /stellar\.expert\/explorer\/testnet\/tx\//);
      assert.ok(b.logs.some((l) => l.includes("[settle] OK") && l.includes(r.settle.transaction)));
    } finally {
      await s.close();
    }
  });

  test("pagador que no es PassportAccount: 402 payer_not_passport_account sin llegar al facilitador", async () => {
    const b = build();
    const s = await listen(b.app);
    try {
      const r = await pay(`${s.url}/api/premium/insight`, BAD);
      assert.equal(r.status, 402);
      assert.equal(r.required.error, "payer_not_passport_account");
      assert.equal(b.inner.calls.verify, 0);
      assert.equal(b.recent.list()[0].reason, "payer_not_passport_account");
    } finally {
      await s.close();
    }
  });

  test("simulación fallida del facilitador se traduce con el error del contrato (cap_exceeded)", async () => {
    const b = build({ behavior: { verify: () => ({ isValid: false, invalidReason: "invalid_exact_stellar_payload_simulation_failed", payer: GOOD }) } });
    const s = await listen(b.app);
    try {
      const r = await pay(`${s.url}/api/premium/report?usd=0.5`, GOOD);
      assert.equal(r.status, 402);
      assert.equal(r.required.error, "cap_exceeded");
      const rec = b.recent.list()[0];
      assert.equal(rec.contractError, "Error(Contract, #6)");
      assert.equal(rec.amount, "5000000");
      assert.equal(b.inner.calls.settle, 0);
    } finally {
      await s.close();
    }
  });

  test("revocada: Error(Contract, #1) -> revoked", async () => {
    const chain = fakeChain({ simulationError: async () => "HostError: ... Error(Contract, #1)" });
    const b = build({ chain, behavior: { verify: () => ({ isValid: false, invalidReason: "invalid_exact_stellar_payload_simulation_failed" }) } });
    const s = await listen(b.app);
    try {
      assert.equal((await pay(`${s.url}/api/premium/insight`, GOOD)).required.error, "revoked");
    } finally {
      await s.close();
    }
  });

  test("settle fallido (el tope se agotó entre verify y settle): 402 con cap_exceeded", async () => {
    const b = build({ behavior: { settle: () => ({ success: false, errorReason: "invalid_exact_stellar_payload_simulation_failed", transaction: "", network: NETWORK }) } });
    const s = await listen(b.app);
    try {
      const r = await pay(`${s.url}/api/premium/quote`, GOOD);
      assert.equal(r.status, 402);
      assert.equal(r.settle?.errorReason ?? r.required?.error, "cap_exceeded");
    } finally {
      await s.close();
    }
  });

  test("dos pagos en paralelo: los settles no se pisan (cola)", async () => {
    const b = build({ behavior: { settleDelayMs: 150 } });
    const s = await listen(b.app);
    try {
      const rs = await Promise.all([pay(`${s.url}/api/premium/insight`, GOOD), pay(`${s.url}/api/premium/insight`, GOOD)]);
      assert.deepEqual(rs.map((r) => r.status), [200, 200]);
      const [a, c] = b.inner.calls.settleSpans.sort((x, y) => x.start - y.start);
      assert.ok(c.start >= a.end, `el segundo settle arrancó (${c.start}) antes de que termine el primero (${a.end})`);
      assert.notEqual(rs[0].settle.transaction, rs[1].settle.transaction);
    } finally {
      await s.close();
    }
  });
});
