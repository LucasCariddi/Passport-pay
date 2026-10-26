// Muestra hasta qué ledger (y fecha aproximada) siguen vivas las entradas onchain de las que
// depende Passport Pay: validador y verificador de OSP, factory, wasm de cuentas, pasaportes
// y cuentas de la demo. Solo lecturas por RPC, no firma nada.
// Uso: node scripts/ttl-status.mjs [--agent <id>]... [--account <C...>]... [--json]
import { readFileSync, existsSync } from "node:fs";
import { Address, rpc, xdr, nativeToScVal } from "@stellar/stellar-sdk";

const root = new URL("../", import.meta.url);
const txt = (f) => {
  const p = new URL(`deploy/${f}`, root);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
};
const json = (f) => {
  const p = new URL(`deploy/${f}`, root);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
};
const argv = process.argv.slice(2);
const many = (k) => argv.flatMap((a, i) => (a === k && argv[i + 1] ? [argv[i + 1]] : []));
const asJson = argv.includes("--json");

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const VALIDATOR = process.env.VALIDATOR_ID || "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA";
const VERIFIER = process.env.VERIFIER_ID || "CCMKLYSRUH2HMA4UU6WLXWQXEY6KAH5AWB5BEVMJGNGC5GLGTVROLG4A";
const VALIDATOR_WASM = process.env.VALIDATOR_WASM || "2cd2e49c99832a909f8ee8a62b1725dc2f8aae650bb0cd833c8b512c3937858b";
const VERIFIER_WASM = process.env.VERIFIER_WASM || "98b1823e4b07ac5aa2dff0332eb9b15ecea5efa95a35376caff21bffe269f8bc";
const FACTORY = process.env.PASSPORT_FACTORY_ID || txt("passport-factory.txt");
const FACTORY_WASM = txt("passport-factory.wasm-hash.txt");
const ACCOUNT_WASM = txt("passport-account.wasm-hash.txt");
const demo = json("demo-public.json");

const agents = [...new Set([...(demo?.agentId ? [String(demo.agentId)] : []), ...many("--agent")])];
const accounts = [...new Set([...(demo?.account ? [demo.account] : []), ...many("--account")])];

const instanceKey = (c) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(c).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
const dataKey = (c, key) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(c).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
const codeKey = (hex) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hex, "hex") }));
const enumKey = (name, v) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), v]);
const u256 = (id) => nativeToScVal(BigInt(id), { type: "u256" });

const items = [
  ["validador OSP (instancia)", instanceKey(VALIDATOR)],
  ["validador OSP (wasm)", codeKey(VALIDATOR_WASM)],
  ["verificador OSP (instancia)", instanceKey(VERIFIER)],
  ["verificador OSP (wasm)", codeKey(VERIFIER_WASM)],
];
if (FACTORY) items.push(["factory (instancia)", instanceKey(FACTORY)]);
if (FACTORY_WASM) items.push(["factory (wasm)", codeKey(FACTORY_WASM)]);
if (ACCOUNT_WASM) items.push([`PassportAccount (wasm ${ACCOUNT_WASM.slice(0, 8)})`, codeKey(ACCOUNT_WASM)]);
for (const id of agents) {
  items.push([`Passport(${id}) en el validador`, dataKey(VALIDATOR, enumKey("Passport", u256(id)))]);
  if (FACTORY) items.push([`factory AccountOf(${id})`, dataKey(FACTORY, enumKey("AccountOf", u256(id)))]);
}
for (const c of accounts) {
  items.push([`cuenta ${c.slice(0, 6)}… (instancia)`, instanceKey(c)]);
  if (FACTORY) items.push([`factory AgentOf(${c.slice(0, 6)}…)`, dataKey(FACTORY, enumKey("AgentOf", xdr.ScVal.scvAddress(Address.fromString(c).toScAddress())))]);
}

const server = new rpc.Server(RPC_URL);
const latest = await server.getLatestLedger();
const res = await server.getLedgerEntries(...items.map((i) => i[1]));
const byKey = new Map(res.entries.map((e) => [e.key.toXDR("base64"), e]));
const SECS = 5; // aproximado: ~5 s por ledger en testnet
const out = items.map(([label, key]) => {
  const e = byKey.get(key.toXDR("base64"));
  const until = e?.liveUntilLedgerSeq ?? null;
  const left = until == null ? null : until - latest.sequence;
  const date = left == null ? null : new Date(Date.now() + left * SECS * 1000).toISOString().slice(0, 10);
  return { label, liveUntilLedger: until, ledgersLeft: left, approxDate: date, status: until == null ? "NO ENCONTRADA" : left < 0 ? "ARCHIVADA" : "viva" };
});
if (asJson) {
  console.log(JSON.stringify({ latestLedger: latest.sequence, entries: out }, null, 2));
} else {
  console.log(`ledger actual ${latest.sequence} (fechas aproximadas a ${SECS} s por ledger)`);
  for (const o of out) {
    console.log(`${o.status.padEnd(13)} ${String(o.liveUntilLedger ?? "-").padStart(9)}  ${(o.approxDate ?? "").padEnd(10)}  ${o.label}`);
  }
}
