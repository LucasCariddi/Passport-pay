import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { createChain, decodeTransferFromTxXdr, EVENTS_WINDOW } from "../src/chain.mjs";
import { loadConfig, readDeployDir } from "../src/config.mjs";
import { extractContractError } from "../src/errors.mjs";
import { createSerialQueue, fmtUsdc } from "../src/facilitator.mjs";
import { BAD, GOOD, PAY_TO, transferXdr, USDC } from "./helpers.mjs";

test("extractContractError: formato del host y del diagnóstico", () => {
  assert.equal(extractContractError("HostError: Error(Contract, #6)").reason, "cap_exceeded");
  assert.equal(extractContractError("... error: contract 1 ...").name, "Revoked");
  assert.equal(extractContractError("Error(Contract, #9)").reason, "passport_changed");
  assert.equal(extractContractError("Error(Contract, #42)").reason, "contract_error_42");
  assert.equal(extractContractError("Error(Auth, InvalidAction)"), null);
  assert.equal(extractContractError(undefined), null);
});

test("decodeTransferFromTxXdr lee from/to/amount del payload", () => {
  const t = decodeTransferFromTxXdr(transferXdr({ from: GOOD, to: PAY_TO, amount: 123 }));
  assert.deepEqual(t, { contract: USDC, from: GOOD, to: PAY_TO, amount: "123" });
  assert.equal(decodeTransferFromTxXdr("basura"), null);
});

test("deploy/: lee los .txt del frente de contratos e ignora campos genéricos de otros json", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-deploy-"));
  writeFileSync(path.join(dir, "passport-factory.txt"), "CFACTORY\n");
  writeFileSync(path.join(dir, "passport-account-agent42.txt"), "CACCOUNT\n");
  writeFileSync(path.join(dir, "passport-account.wasm-hash.txt"), "ABCDEF\n");
  writeFileSync(path.join(dir, "demo-register.json"), JSON.stringify({ account: "COTRA", agentId: "1" }));
  const { values, files } = readDeployDir(dir);
  assert.deepEqual(values, { PASSPORT_FACTORY_ID: "CFACTORY", PASSPORT_ACCOUNT_ID: "CACCOUNT", PASSPORT_ACCOUNT_WASM_HASH: "ABCDEF" });
  assert.ok(!files.includes("demo-register.json"));

  const cfg = loadConfig({ MERCHANT_PUBLIC: "G", PASSPORT_ACCOUNT_WASM_HASH: "1111", ACCOUNT_WASM_HASHES: "2222, 3333" }, { deployDir: dir });
  assert.equal(cfg.factoryId, "CFACTORY");
  assert.equal(cfg.accountWasmHash, "1111", "el .env manda sobre deploy/");
  assert.deepEqual(cfg.accountWasmHashes, ["1111", "abcdef", "2222", "3333"]);
  assert.throws(() => loadConfig({ X402_NETWORK: "stellar:pubnet" }, { deployDir: dir }), /solo corre en stellar:testnet/);
});

test("cola serial: en orden y un error no traba la cola", async () => {
  const q = createSerialQueue();
  const seen = [];
  const slow = (id, ms, fail) => q(async () => {
    seen.push(`in${id}`);
    await new Promise((ok) => setTimeout(ok, ms));
    seen.push(`out${id}`);
    if (fail) throw new Error("x");
    return id;
  });
  const r = await Promise.allSettled([slow(1, 30), slow(2, 5, true), slow(3, 1)]);
  assert.deepEqual(seen, ["in1", "out1", "in2", "out2", "in3", "out3"]);
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected", "fulfilled"]);
});

test("fmtUsdc", () => {
  assert.equal(fmtUsdc("100000"), "0.01");
  assert.equal(fmtUsdc("500000000"), "50");
});

function fakeEvent(ledger, amount) {
  const sym = nativeToScVal("transfer", { type: "symbol" });
  return {
    id: `id-${ledger}`,
    txHash: ledger.toString(16).padStart(64, "0"),
    ledger,
    ledgerClosedAt: "2026-10-25T00:00:00Z",
    topic: [sym, nativeToScVal(GOOD, { type: "address" }), nativeToScVal(PAY_TO, { type: "address" }), nativeToScVal("USDC:G", { type: "string" })],
    value: nativeToScVal(BigInt(amount), { type: "i128" }),
  };
}

test("getPayments: ventanas hacia atrás, nunca endLedger > último, saltea ventanas que el RPC no procesa", async () => {
  const latest = 100_000;
  const calls = [];
  const server = {
    getLatestLedger: async () => ({ sequence: latest }),
    getEvents: async (q) => {
      calls.push(q);
      assert.ok(q.endLedger <= latest);
      assert.ok(q.endLedger - q.startLedger <= EVENTS_WINDOW);
      if (q.startLedger < 85_000 && q.endLedger > 80_000) throw new Error("[-32001] request exceeded processing limit threshold");
      const evs = [99_500, 95_000, 75_000].filter((l) => l >= q.startLedger && l < q.endLedger).map((l) => fakeEvent(l, l));
      return { events: evs, cursor: "c" };
    },
  };
  const chain = createChain({ rpcUrl: "http://x", asset: USDC, server });
  const out = await chain.getPayments({ from: GOOD, limit: 10, lookbackLedgers: 30_000 });
  assert.deepEqual(out.map((p) => p.ledger), [99_500, 95_000, 75_000]);
  assert.equal(out[0].from, GOOD);
  assert.equal(out[0].to, PAY_TO);
  assert.equal(out[0].amount, "99500");
  assert.ok(out.skippedWindows.length === 1);
  assert.equal(calls[0].endLedger, latest);
  const f = calls[0].filters[0];
  assert.equal(f.contractIds[0], USDC);
  assert.equal(xdr.ScVal.fromXDR(f.topics[0][1], "base64").address().switch().name, "scAddressTypeContract");
});

test("isPassportAccount: factory primero, y por wasm exige validador y token correctos", async () => {
  // RPC falso mínimo: simulateTransaction (is_account / config) y getLedgerEntries (wasm hash).
  const build = ({ factoryOk, wasm, cfg }) => {
    const server = {
      simulateTransaction: async (tx) => {
        const fn = tx.operations[0].func.invokeContract().functionName().toString();
        const retval = fn === "is_account" ? nativeToScVal(factoryOk) : nativeToScVal(cfg, { type: { validator: ["symbol", "address"], token: ["symbol", "address"] } });
        return { result: { retval }, transactionData: {}, minResourceFee: "0", latestLedger: 1, events: [] };
      },
      getLedgerEntries: async () => ({
        entries: [{ val: { contractData: () => ({ val: () => ({ instance: () => ({ executable: () => ({ switch: () => ({ name: "contractExecutableWasm" }), wasmHash: () => Buffer.from(wasm, "hex") }) }) }) }) } }],
      }),
    };
    return createChain({ rpcUrl: "http://x", asset: USDC, factoryId: BAD, accountWasmHashes: ["aa"], validatorId: "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA", server });
  };
  const V = "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA";
  assert.deepEqual(await build({ factoryOk: true, wasm: "bb", cfg: {} }).isPassportAccount(GOOD), { ok: true, via: "factory" });
  assert.equal((await build({ factoryOk: false, wasm: "aa", cfg: { validator: V, token: USDC } }).isPassportAccount(GOOD)).ok, true);
  assert.equal((await build({ factoryOk: false, wasm: "aa", cfg: { validator: GOOD, token: USDC } }).isPassportAccount(GOOD)).ok, false, "validador trucho");
  assert.equal((await build({ factoryOk: false, wasm: "bb", cfg: { validator: V, token: USDC } }).isPassportAccount(GOOD)).ok, false, "wasm desconocido");
  assert.equal((await build({ factoryOk: true, wasm: "aa", cfg: {} }).isPassportAccount(PAY_TO)).via, "not_contract");
});
