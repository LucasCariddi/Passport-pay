// check-tx.mjs <hash> [account] - reads a Story A transaction back from the network, without
// any of the code that sent it: Horizon for the status and the close time, RPC getTransaction
// for the diagnostic events. Prints whether the FAILED code is attributed to the account's
// __check_auth ("failed account authentication with error", <account>, Error(Contract, #n)).
// Also prints the attacker's USDC balance. Public data only.
import { Horizon, rpc, xdr, scValToNative, StrKey } from "@stellar/stellar-sdk";

const [hash, account = "CA75KBZFQPJUT7BTACHE22XKQROIWL77I2YPDFTEH56PBQFD72VVUVAO"] = process.argv.slice(2);
const ATTACKER = process.env.ATTACKER || "GCCZXNV7U6MY6APDCWFXLAUTUOB63N6LTXZEMJ2Y4JJUJVGFEXQ7SNIN";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
if (!/^[0-9a-f]{64}$/.test(hash ?? "")) {
  console.error("usage: node scenario/check-tx.mjs <hash> [account]");
  process.exit(2);
}
const horizon = new Horizon.Server(process.env.HORIZON_URL || "https://horizon-testnet.stellar.org");
const server = new rpc.Server(process.env.RPC_URL || "https://soroban-testnet.stellar.org");

const h = await horizon.transactions().transaction(hash).call();
console.log(`horizon: successful=${h.successful} ledger=${h.ledger_attr} closed=${h.created_at} source=${h.source_account}`);

const r = await server.getTransaction(hash);
console.log(`rpc: status=${r.status} ledger=${r.ledger}`);
let attributed = null;
for (const ev of r.diagnosticEventsXdr ?? []) {
  const e = typeof ev === "string" ? xdr.DiagnosticEvent.fromXDR(ev, "base64") : ev;
  const body = e.event().body().v0();
  let topics, data;
  try {
    topics = body.topics().map((t) => scValToNative(t));
    data = scValToNative(body.data());
  } catch {
    continue;
  }
  const text = JSON.stringify([topics, data], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (/failed account authentication/i.test(text)) {
    const cid = e.event().contractId();
    console.log(`diagnostic: ${text.slice(0, 300)}`);
    attributed = text.includes(account) ? account : cid ? StrKey.encodeContract(cid) : "?";
  }
}
const ce = (() => {
  try {
    return r.resultXdr?.result().switch().name;
  } catch {
    return undefined;
  }
})();
console.log(`result: ${ce ?? "?"}`);
if (r.status === "FAILED") {
  console.log(`attributed to the account's __check_auth: ${attributed === account ? `YES (${account})` : `NO (${attributed})`}`);
}

const acc = await horizon.loadAccount(ATTACKER);
const usdc = acc.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
console.log(`attacker ${ATTACKER} USDC balance now: ${usdc ? usdc.balance : "no trustline"}`);
