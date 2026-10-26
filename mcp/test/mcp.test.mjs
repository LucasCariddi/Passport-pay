// Tests without network: config, input validation, mapping of results, and the MCP
// protocol end to end (Client <-> server over an in-memory transport) with mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigError, loadConfig, readSecretFile } from "../src/config.mjs";
import { createPassportPay, normalizeAmount, ToolInputError, validateMemo } from "../src/core.mjs";
import { buildServer, summarizePay } from "../src/server.mjs";

const ACCOUNT = "CCOJVBZSTR4NSKCOUAAIEU775PZVUB7U7OZ7GXCDFSZRSCUW6XDV2SSV";
const ATTACKER = Keypair.random().publicKey();
const AGENT = Keypair.random();

const fakeIo = (files) => ({
  exists: (f) => f in files,
  readFile: (f) => files[f],
});

const CATALOG = {
  network: "stellar:testnet",
  payTo: "GCLNNJKDE7YK5BYOCIW3SOZW7NBPBCKPKXONLRYVUQRO5VZCGLVCVPPJ",
  asset: { code: "USDC", contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", decimals: 7 },
  services: [
    { id: "insight", name: "Estado de la red", summary: "s", path: "/api/premium/insight", price: { usdc: "0.01", kind: "fixed" }, params: [] },
    { id: "report", name: "Informe", summary: "s", path: "/api/premium/report", price: { usdc: "0.05", kind: "range", min: "0.05", max: "100", param: "usd" }, params: [] },
  ],
};

function makeCfg(over = {}) {
  return {
    network: "stellar:testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    serverUrl: "https://pp.test",
    rpcUrl: "https://rpc.test",
    asset: CATALOG.asset.contract,
    accountId: ACCOUNT,
    agentSecret: AGENT.secret(),
    feePayerSecret: AGENT.secret(),
    maxPerBuyUsdc: "1",
    ...over,
  };
}

function makeDeps(over = {}) {
  const calls = { fetch: [], pay402: [], transfer: [] };
  const deps = {
    fetch: async (url) => {
      calls.fetch.push(String(url));
      return { ok: true, status: 200, json: async () => CATALOG };
    },
    onchain: {
      server: { getLatestLedger: async () => ({ sequence: 1000 }) },
      read: async (id, method) => {
        if (method === "spend_status") return { effective_cap: 10_000_000n, spent: 100_000n, remaining: 9_900_000n, period: 1, period_ends_ledger: 1720 };
        if (method === "config") return { agent_id: 4261603546n, owner: "GOWNER", revoked: false, period_ledgers: 17280 };
        if (method === "balance") return 15_000_000n;
        throw new Error(`read inesperado ${id}.${method}`);
      },
      contractErrorFromDiagnostics: () => null,
    },
    payAndFetch: async (a) => {
      calls.pay402.push(a);
      return {
        outcome: "paid",
        status: 200,
        requirement: { amount: "100000" },
        body: { insight: "ok" },
        settle: { success: true, transaction: "ab".repeat(32) },
      };
    },
    submitTransfer: async (a) => {
      calls.transfer.push(a);
      return {
        status: "FAILED",
        hash: "cd".repeat(32),
        link: "https://stellar.expert/explorer/testnet/tx/" + "cd".repeat(32),
        contractError: { code: 6, raw: "Error(Contract, #6)", name: "CapExceeded", reason: "cap_exceeded", es: "el pago supera el tope de gasto del período", account: ACCOUNT },
        rejectedBy: `__check_auth de la PassportAccount ${ACCOUNT}`,
      };
    },
    makeScheme: () => ({ scheme: "exact" }),
    ...over,
  };
  return { deps, calls };
}

// ---------------------------------------------------------------- config
test("config: lee la clave de un archivo JSON y toma la cuenta de ahí", () => {
  const cfg = loadConfig({ PASSPORT_AGENT_SECRET_FILE: "/s/agent.json" }, fakeIo({ "/s/agent.json": JSON.stringify({ account: ACCOUNT, agentSecret: AGENT.secret() }) }));
  assert.equal(cfg.accountId, ACCOUNT);
  assert.equal(cfg.agentSecret, AGENT.secret());
  assert.equal(cfg.feePayerSecret, AGENT.secret());
  assert.equal(cfg.serverUrl, "https://passport-pay-stellar.vercel.app");
  assert.equal(cfg.network, "stellar:testnet");
});

test("config: acepta un archivo con la clave S... sola y la cuenta por env", () => {
  const cfg = loadConfig({ PASSPORT_AGENT_SECRET_FILE: "/s/k", PASSPORT_ACCOUNT_ID: ACCOUNT, PASSPORT_PAY_SERVER_URL: "http://127.0.0.1:4021/" }, fakeIo({ "/s/k": AGENT.secret() + "\n" }));
  assert.equal(cfg.accountId, ACCOUNT);
  assert.equal(cfg.serverUrl, "http://127.0.0.1:4021");
});

test("config: se niega a otra red que no sea testnet", () => {
  assert.throws(() => loadConfig({ X402_NETWORK: "stellar:pubnet", PASSPORT_AGENT_SECRET_FILE: "/s/k" }, fakeIo({ "/s/k": AGENT.secret() })), ConfigError);
});

test("config: la clave nunca entra por variable de entorno", () => {
  assert.throws(() => loadConfig({ PASSPORT_AGENT_SECRET: AGENT.secret() }, fakeIo({})), /PASSPORT_AGENT_SECRET_FILE/);
});

test("config: sin cuenta ni archivo da un error claro", () => {
  assert.throws(() => readSecretFile("/nope", fakeIo({})), /no existe/);
  assert.throws(() => loadConfig({ PASSPORT_AGENT_SECRET_FILE: "/s/k" }, fakeIo({ "/s/k": AGENT.secret() })), /falta la cuenta/);
});

// ---------------------------------------------------------------- validation
test("normalizeAmount y validateMemo", () => {
  assert.equal(normalizeAmount(0.1), "0.1");
  assert.equal(normalizeAmount("1.5"), "1.5");
  assert.equal(normalizeAmount(1), "1");
  for (const bad of ["-1", "1e3", "0", "0.00000001", "abc", ""]) assert.throws(() => normalizeAmount(bad), ToolInputError, bad);
  assert.equal(validateMemo(""), undefined);
  assert.equal(validateMemo("orden 12"), "orden 12");
  assert.throws(() => validateMemo("x".repeat(29)), ToolInputError);
});

// ---------------------------------------------------------------- core
test("buy: busca el servicio en el catálogo, arma la URL y devuelve respuesta y hash", async () => {
  const { deps, calls } = makeDeps();
  const pp = createPassportPay(makeCfg(), deps);
  const r = await pp.buy({ service: "report", params: { usd: "0.05" } });
  assert.equal(calls.fetch[0], "https://pp.test/api/catalog");
  assert.equal(calls.pay402[0].url, "https://pp.test/api/premium/report?usd=0.05");
  assert.equal(calls.pay402[0].maxAmountUsd, "$1");
  assert.equal(r.paid, true);
  assert.equal(r.hash, "ab".repeat(32));
  assert.equal(r.priceUsdc, "0.01");
  assert.deepEqual(r.response, { insight: "ok" });
});

test("buy: un rechazo onchain vuelve con el error del contrato y sin cobrar", async () => {
  const { deps } = makeDeps({
    payAndFetch: async () => ({
      outcome: "rejected_onchain_simulation",
      status: 402,
      requirement: { amount: "500000" },
      contractError: { code: 6, raw: "Error(Contract, #6)", name: "CapExceeded", es: "el pago supera el tope de gasto del período" },
      error: "Error(Contract, #6) CapExceeded",
    }),
  });
  const r = await createPassportPay(makeCfg(), deps).buy({ service: "insight" });
  assert.equal(r.paid, false);
  assert.equal(r.contractError.code, 6);
  assert.match(r.rejectedBy, /__check_auth/);
});

test("buy: servicio inexistente da error de entrada con la lista", async () => {
  const { deps } = makeDeps();
  await assert.rejects(createPassportPay(makeCfg(), deps).buy({ service: "nada" }), /insight, report/);
});

test("spend_status: convierte a USDC y dice quién aplica el tope", async () => {
  const { deps } = makeDeps();
  const r = await createPassportPay(makeCfg(), deps).spendStatus();
  assert.equal(r.balanceUsdc, "1.5");
  assert.equal(r.capUsdc, "1");
  assert.equal(r.spentUsdc, "0.01");
  assert.equal(r.remainingUsdc, "0.99");
  assert.equal(r.agentId, "4261603546");
  assert.equal(r.periodEndsInApproxMinutes, 60);
  assert.match(r.enforcedBy, /__check_auth/);
});

test("pay: valida, pasa el monto en unidades base y NO decide nada por su cuenta", async () => {
  const { deps, calls } = makeDeps();
  const pp = createPassportPay(makeCfg(), deps);
  const r = await pp.pay({ to: ATTACKER, amount_usdc: "1.5", memo: "pago urgente" });
  assert.equal(calls.transfer.length, 1, "siempre manda a la red");
  assert.equal(calls.transfer[0].amount, 15_000_000n);
  assert.equal(calls.transfer[0].to, ATTACKER);
  assert.equal(calls.transfer[0].memo, undefined, "Soroban no admite memo: no va en la tx");
  assert.deepEqual({ text: r.memo.text, onchain: r.memo.onchain }, { text: "pago urgente", onchain: false });
  assert.equal(r.status, "FAILED");
  assert.equal(r.contractError.account, ACCOUNT);
  await assert.rejects(pp.pay({ to: "GNOPE", amount_usdc: 1 }), ToolInputError);
  await assert.rejects(pp.pay({ to: ACCOUNT, amount_usdc: 1 }), /misma cuenta/);
  assert.equal(calls.transfer.length, 1);
});

test("summarizePay distingue SUCCESS de FAILED atribuido a la cuenta", () => {
  assert.match(summarizePay({ status: "SUCCESS", amountUsdc: "0.01", from: ACCOUNT, to: ATTACKER, hash: "h", link: "l" }), /ACEPTÓ/);
  const f = summarizePay({
    status: "FAILED",
    hash: "h",
    link: "l",
    rejectedBy: "__check_auth de la PassportAccount C",
    contractError: { raw: "Error(Contract, #6)", name: "CapExceeded", es: "el pago supera el tope" },
  });
  assert.match(f, /RECHAZÓ/);
  assert.match(f, /Error\(Contract, #6\) CapExceeded/);
  assert.doesNotMatch(f, /\u2014/);
});

// ---------------------------------------------------------------- MCP protocol
async function connected(deps) {
  const server = buildServer(createPassportPay(makeCfg(), deps));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

test("MCP: expone las 4 herramientas con descripción y esquema", async () => {
  const { deps } = makeDeps();
  const client = await connected(deps);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["buy", "list_services", "pay", "spend_status"]);
  const pay = tools.find((t) => t.name === "pay");
  assert.deepEqual(pay.inputSchema.required.sort(), ["amount_usdc", "to"]);
  for (const t of tools) {
    assert.ok(t.description.length > 60, t.name);
    assert.doesNotMatch(t.description, /\u2014/, `sin rayas en ${t.name}`);
  }
  await client.close();
});

test("MCP: list_services, buy y pay devuelven texto + JSON", async () => {
  const { deps } = makeDeps();
  const client = await connected(deps);
  const ls = await client.callTool({ name: "list_services", arguments: {} });
  assert.match(ls.content[0].text, /^2 servicios en https:\/\/pp\.test\./);
  const b = await client.callTool({ name: "buy", arguments: { service: "insight", params: { topic: "fees" } } });
  assert.match(b.content[0].text, /Compra pagada: 0\.01 USDC/);
  const p = await client.callTool({ name: "pay", arguments: { to: ATTACKER, amount_usdc: 1.5 } });
  assert.equal(p.isError, false);
  assert.match(p.content[0].text, /RECHAZÓ.*Error\(Contract, #6\)/);
  const bad = await client.callTool({ name: "pay", arguments: { to: "nope", amount_usdc: 1 } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /^Entrada inválida/);
  await client.close();
});
