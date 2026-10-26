import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeContractError, clientIp, createBoundedMutex, createRateLimiter, loadDemoConfig } from "../src/demo.mjs";

const ACC = "CAGMBEI3DEJRUYETQ26VC6ZKERFEP3YYK76Z6AHBDPZDTZN3VGYWB7ZV";
const OTHER = "CDTC2YRIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("attributeContractError toma el código de la cuenta que falló la autenticación", () => {
  const raw = `HostError: Error(Auth, InvalidAction)\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Contract, #6)], data:["failed account authentication with error", ${ACC}, Error(Contract, #6)]`;
  assert.deepEqual(attributeContractError(raw, ACC), { account: ACC, code: 6 });
  assert.equal(attributeContractError(raw, OTHER), null);
  assert.equal(attributeContractError("Error(Contract, #6)", ACC), null);
});

test("rate limiter corta después de max pedidos por ventana", () => {
  const rl = createRateLimiter({ max: 2, windowMs: 60_000 });
  assert.equal(rl("a").ok, true);
  assert.equal(rl("a").ok, true);
  const third = rl("a");
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterSec > 0 && third.retryAfterSec <= 60);
  assert.equal(rl("b").ok, true);
});

test("mutex serializa y devuelve busy si no entra a tiempo", async () => {
  const m = createBoundedMutex(50);
  const order = [];
  const slow = m.run(async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 120));
    order.push("a-end");
    return "a";
  });
  await assert.rejects(m.run(async () => "b"), (e) => e.busy === true);
  assert.equal(await slow, "a");
  // después de liberar, entra el siguiente
  assert.equal(await m.run(async () => "c"), "c");
  assert.deepEqual(order, ["a-start", "a-end"]);
  assert.equal(m.pending, 0);
});

test("mutex: dos tareas cortas corren de a una, en orden", async () => {
  const m = createBoundedMutex(1000);
  const seen = [];
  await Promise.all([1, 2, 3].map((i) => m.run(async () => {
    seen.push(`s${i}`);
    await new Promise((r) => setTimeout(r, 10));
    seen.push(`e${i}`);
  })));
  assert.deepEqual(seen, ["s1", "e1", "s2", "e2", "s3", "e3"]);
});

test("clientIp usa el primer valor de x-forwarded-for", () => {
  const req = { header: (n) => (n === "x-forwarded-for" ? "1.2.3.4, 10.0.0.1" : undefined), socket: {} };
  assert.equal(clientIp(req), "1.2.3.4");
});

test("loadDemoConfig: la cuenta sale del env o de deploy/demo-public.json, nunca del cliente", () => {
  const c = loadDemoConfig({ DEMO_AGENT_SECRET: " x " });
  assert.match(c.accountId, /^C[A-Z2-7]{55}$/);
  assert.equal(c.agentSecret, "x");
  // deploy/demo-public.json names its account's wasm (b9dfc7c6… since the fire test).
  assert.match(c.requiredWasm, /^(f5ec1e6d5eb29e1975542e87d59655d9628e8606a60a8946bb17d9cd15aff903|b9dfc7c63110619e104fbeb8e912b1b004a4d7709bec57f5d2fbaef90197dd26)$/);
  assert.ok(c.allowedWasms.includes(c.requiredWasm));
});
