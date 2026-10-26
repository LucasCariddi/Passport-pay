// Tests for POST/GET /api/demo/inject (fire test) with mocks: nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { ALLOWLIST_WASM_HASH, DEMO_WASM_HASH, createBoundedMutex, loadDemoConfig } from "../src/demo.mjs";
import { DEFAULT_ATTACKER, INJECTION_AMOUNT_BASE, loadRecorded, mountInject } from "../src/inject.mjs";
import { listen, testConfig } from "./helpers.mjs";

const ACC = "CADZU573AKZ7WV4T5TPZRJOMFA2VTU4PTLXHP27R7WWDYJ2J7PFKNWFF";
const OTHER_ACC = "CAGMBEI3DEJRUYETQ26VC6ZKERFEP3YYK76Z6AHBDPZDTZN3VGYWB7ZV";
const AGENT = Keypair.random();
const HASH = "c".repeat(64);
const MERCHANT = "GCLNNJKDE7YK5BYOCIW3SOZW7NBPBCKPKXONLRYVUQRO5VZCGLVCVPPJ";

const ce10 = (account) => ({ code: 10, raw: "Error(Contract, #10)", name: "PayeeNotAllowed", ...(account ? { account } : {}) });

/** Fake onchain layer: records calls and how many run at once. */
function fakeOc(over = {}) {
  const calls = { sim: [], force: [], reads: [] };
  let running = 0;
  let maxRunning = 0;
  const oc = {
    calls,
    get maxRunning() {
      return maxRunning;
    },
    async read(id, method, args) {
      calls.reads.push({ id, method, args });
      if (method === "payees") return over.payees ?? [MERCHANT];
      if (method === "is_payee") return over.isPayee ?? false;
      if (method === "balance") return 0n;
      if (method === "spend_status") return { spent: 0n, effective_cap: 500_000n };
      throw new Error(`unexpected read ${method}`);
    },
    async simulateAgentTransfer(a) {
      calls.sim.push(a);
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, over.simDelayMs ?? 5));
      running--;
      return over.sim ?? { ok: false, error: `failed account authentication with error, ${ACC}, Error(Contract, #10)`, contractError: ce10(ACC) };
    },
    async forceTransferOnchain(a) {
      calls.force.push(a);
      return over.force ?? { hash: HASH, status: "FAILED", link: `https://stellar.expert/explorer/testnet/tx/${HASH}`, resultCode: "txFailed", contractError: ce10(ACC), feeChargedStroops: "14000" };
    },
  };
  return oc;
}

async function setup({ oc = fakeOc(), wasm = ALLOWLIST_WASM_HASH, demo = { accountId: ACC, agentSecret: AGENT.secret() }, rateMax = 50, mutex, recordedFile } = {}) {
  const app = express();
  const chain = { getWasmHash: async () => wasm };
  mountInject({ app, cfg: testConfig(), chain, demo, oc, mutex, rateMax, log: () => {}, recordedFile, env: {} });
  const s = await listen(app);
  const post = (body, headers = {}) =>
    fetch(`${s.url}/api/demo/inject`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
  return { ...s, oc, post };
}

test("inject force: signs 5 USDC to the attacker, the network rejects it with PayeeNotAllowed attributed to the account", async () => {
  const t = await setup();
  try {
    // the client cannot pick the account, payee or amount: they are ignored
    const r = await t.post({ force: true, account: OTHER_ACC, payTo: MERCHANT, amount: "1" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.verdict, "REJECTED");
    assert.equal(j.account, ACC);
    assert.equal(j.attacker, DEFAULT_ATTACKER);
    assert.equal(j.amountUsdc, "5");
    assert.equal(j.agentPublic, AGENT.publicKey());
    assert.equal(j.signed, true);
    assert.deepEqual(j.rule, { wasmHash: ALLOWLIST_WASM_HASH, payees: [MERCHANT], attackerAllowed: false });
    assert.deepEqual(j.simulation, { rejected: true, contractError: { code: 10, name: "PayeeNotAllowed", raw: "Error(Contract, #10)" }, attributedTo: ACC });
    assert.equal(j.forced.hash, HASH);
    assert.equal(j.forced.status, "FAILED");
    assert.equal(j.forced.attributedTo, ACC);
    assert.match(j.forced.link, /stellar\.expert\/explorer\/testnet\/tx\/c{64}$/);
    assert.match(j.message, /PayeeNotAllowed \(#10\)/);
    // what was signed and sent
    const [f] = t.oc.calls.force;
    assert.equal(f.accountId, ACC);
    assert.equal(f.payTo, DEFAULT_ATTACKER);
    assert.equal(f.amount, INJECTION_AMOUNT_BASE);
    assert.equal(f.footprintAmount, 1n);
    assert.equal(f.feePayerSecret, AGENT.secret());
    assert.equal(t.oc.calls.sim[0].sourcePublic, AGENT.publicKey());
    // the key never leaks
    assert.ok(!JSON.stringify(j).includes(AGENT.secret()));
  } finally {
    await t.close();
  }
});

test("inject without force: only simulates, sends nothing to the network", async () => {
  const t = await setup();
  try {
    const j = await (await t.post({})).json();
    assert.equal(j.verdict, "REJECTED");
    assert.equal(j.forced, null);
    assert.equal(t.oc.calls.force.length, 0);
    assert.equal(t.oc.calls.sim.length, 1);
    assert.match(j.message, /Nothing was sent/);
  } finally {
    await t.close();
  }
});

test("inject: an account without a payee list (wasm f5ec1e6d) gets 503 and nothing is signed", async () => {
  const t = await setup({ wasm: DEMO_WASM_HASH });
  try {
    const r = await t.post({ force: true });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "inject_account_wasm");
    assert.equal(t.oc.calls.sim.length, 0);
    assert.equal(t.oc.calls.force.length, 0);
  } finally {
    await t.close();
  }
});

test("inject: if the attacker is an allowed payee, 503 and nothing is signed", async () => {
  const t = await setup({ oc: fakeOc({ isPayee: true }) });
  try {
    const r = await t.post({ force: true });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "attacker_is_payee");
    assert.equal(t.oc.calls.sim.length, 0);
    assert.equal(t.oc.calls.force.length, 0);
  } finally {
    await t.close();
  }
});

test("inject: if the simulation accepted the payment, nothing is sent", async () => {
  const t = await setup({ oc: fakeOc({ sim: { ok: true } }) });
  try {
    const r = await t.post({ force: true });
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, "simulation_accepted");
    assert.equal(t.oc.calls.force.length, 0);
  } finally {
    await t.close();
  }
});

test("inject: a #10 not attributed to the account (USDC balance error) does not count as the rule rejecting it", async () => {
  const sim = { ok: false, error: "HostError: Error(Contract, #10)", contractError: ce10() };
  const force = { hash: HASH, status: "FAILED", link: "x", contractError: ce10() };
  const t = await setup({ oc: fakeOc({ sim, force }) });
  try {
    const j = await (await t.post({ force: true })).json();
    assert.equal(j.verdict, "UNEXPECTED");
    assert.equal(j.simulation.attributedTo, null);
    assert.equal(j.forced.attributedTo, null);
  } finally {
    await t.close();
  }
});

test("inject: per-IP limit", async () => {
  const t = await setup({ rateMax: 2 });
  try {
    const h = { "x-forwarded-for": "9.9.9.9" };
    assert.equal((await t.post({}, h)).status, 200);
    assert.equal((await t.post({}, h)).status, 200);
    const r = await t.post({}, h);
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error, "rate_limited");
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal((await t.post({}, { "x-forwarded-for": "8.8.8.8" })).status, 200);
  } finally {
    await t.close();
  }
});

test("inject: simultaneous requests run one at a time (mutex shared with /api/demo/pay)", async () => {
  const mutex = createBoundedMutex(5_000);
  const oc = fakeOc({ simDelayMs: 40 });
  const t = await setup({ oc, mutex });
  try {
    const rs = await Promise.all([t.post({}), t.post({}), t.post({})]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(oc.maxRunning, 1);
  } finally {
    await t.close();
  }
});

test("inject: busy when the shared mutex is not released in time", async () => {
  const mutex = createBoundedMutex(30);
  let release;
  const hold = mutex.run(() => new Promise((r) => (release = r))); // a /api/demo/pay in flight
  const t = await setup({ mutex });
  try {
    const r = await t.post({ force: true });
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error, "busy");
    assert.equal(t.oc.calls.force.length, 0);
  } finally {
    release();
    await hold;
    await t.close();
  }
});

test("inject: without the agent key it answers 503", async () => {
  const t = await setup({ demo: { accountId: ACC, agentSecret: "" } });
  try {
    const r = await t.post({ force: true });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "demo_not_configured");
  } finally {
    await t.close();
  }
});

test("GET /api/demo/inject: public setup and the run recorded in deploy/injection-demo.json", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "inject-"));
  const file = path.join(dir, "injection-demo.json");
  writeFileSync(file, JSON.stringify({ account: ACC, at: "2026-10-26T00:00:00Z", forced: { hash: HASH, status: "FAILED", link: "l", contractError: { code: 10, name: "PayeeNotAllowed" }, attributedTo: ACC } }));
  const t = await setup({ recordedFile: file });
  try {
    const r = await fetch(`${t.url}/api/demo/inject`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.enabled, true);
    assert.equal(j.account, ACC);
    assert.equal(j.attacker, DEFAULT_ATTACKER);
    assert.equal(j.attackerAllowed, false);
    assert.deepEqual(j.payees, [MERCHANT]);
    assert.equal(j.recorded.hash, HASH);
    assert.equal(j.recorded.status, "FAILED");
    assert.ok(!JSON.stringify(j).includes(AGENT.secret()));
    assert.equal(t.oc.calls.sim.length, 0); // GET signs nothing
  } finally {
    await t.close();
  }
});

test("loadRecorded ignores files without a valid hash", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "inject-"));
  const file = path.join(dir, "x.json");
  writeFileSync(file, JSON.stringify({ forced: { hash: "nope" } }));
  assert.equal(loadRecorded(file), null);
  assert.equal(loadRecorded(path.join(dir, "missing.json")), null);
});

test("loadDemoConfig accepts both fixed wasms and never the old 72f52276", () => {
  const c = loadDemoConfig({ DEMO_AGENT_SECRET: "x" });
  assert.ok(c.allowedWasms.includes(DEMO_WASM_HASH));
  assert.ok(c.allowedWasms.includes(ALLOWLIST_WASM_HASH));
  assert.ok(!c.allowedWasms.includes("72f522762b62913e09e107c073e346f69324625ad6a9ccd16944cf804d900908"));
});
