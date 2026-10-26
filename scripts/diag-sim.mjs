// Diagnostico: simula get_passport(42) en el validador y muestra fee y si pide restore.
import { Account, Contract, nativeToScVal, rpc, TransactionBuilder, Networks, xdr } from "@stellar/stellar-sdk";
process.loadEnvFile(new URL("../.env", import.meta.url));
const server = new rpc.Server(process.env.RPC_URL);
const VALIDATOR = process.env.VALIDATOR_ID ?? "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA";
const src = await server.getAccount(process.env.OWNER_PUBLIC);
const agentId = Number(process.argv[2] ?? process.env.AGENT_ID ?? 42);
const tx = new TransactionBuilder(src, { fee: "100", networkPassphrase: Networks.TESTNET })
  .addOperation(new Contract(VALIDATOR).call("get_passport", nativeToScVal(agentId, { type: "u256" })))
  .setTimeout(60).build();
const sim = await server.simulateTransaction(tx);
console.log("error:", sim.error ?? "-");
console.log("minResourceFee:", sim.minResourceFee, "restorePreamble:", !!sim.restorePreamble);
if (sim.restorePreamble) console.log("restore minResourceFee:", sim.restorePreamble.minResourceFee);
const latest = await server.getLatestLedger();
console.log("latest ledger:", latest.sequence);
// TTL de las entradas del footprint
const fp = (sim.transactionData ?? sim.restorePreamble?.transactionData)?.build().resources().footprint();
const keys = fp ? [...fp.readOnly(), ...fp.readWrite()] : [];
const got = await server.getLedgerEntries(...keys);
for (const e of got.entries) console.log(e.key.switch().name, "liveUntil:", e.liveUntilLedgerSeq);
console.log("pedidas:", keys.length, "devueltas:", got.entries.length);
