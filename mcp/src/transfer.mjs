// Generic USDC transfer FROM the PassportAccount, sent straight to the network.
//
// This is the `pay` tool: the one a hijacked agent would use to pay an attacker. It does
// not decide anything by itself. It signs the auth entry with the agent key and always
// submits the tx, so the answer is what the ledger says: SUCCESS, or FAILED with the
// error that `__check_auth` of the PassportAccount returned.
//
// - If the enforcing simulation passes, the tx is assembled from that simulation.
// - If it fails (cap, revoked, ...), a failed simulation gives no footprint, so we build it
//   the same way as `agent/src/onchain.mjs#forceTransferOnchain`: union of the recording
//   simulation of the transfer and the simulation of `spend_status()`, with the account
//   instance read-write. The ledger then runs `__check_auth` for real and the tx is FAILED.
import {
  Account,
  Contract,
  Operation,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { agentAuthorizer } from "../../agent/src/passport-account-scheme.mjs";
import { extractContractError } from "../../agent/src/errors.mjs";

export const txLink = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const keyStr = (k) => k.toXDR("base64");

async function waitTx(server, hash, { tries = 45, delayMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await server.getTransaction(hash);
    if (r.status !== "NOT_FOUND") return r;
    await new Promise((ok) => setTimeout(ok, delayMs));
  }
  return { status: "TIMEOUT" };
}

function forcedSorobanData(recSim, stSim, accountId) {
  const d1 = recSim.transactionData.build();
  const d2 = stSim && rpc.Api.isSimulationSuccess(stSim) ? stSim.transactionData.build() : null;
  const rw = new Map(d1.resources().footprint().readWrite().map((k) => [keyStr(k), k]));
  const inst = new Contract(accountId).getFootprint();
  rw.set(keyStr(inst), inst); // __check_auth writes `Spent` in the account instance
  const ro = new Map();
  for (const k of [...d1.resources().footprint().readOnly(), ...(d2 ? d2.resources().footprint().readOnly() : [])]) {
    if (!rw.has(keyStr(k))) ro.set(keyStr(k), k);
  }
  const r1 = d1.resources();
  const r2 = d2?.resources();
  const resourceFee = (BigInt(recSim.minResourceFee) + BigInt(d2 ? stSim.minResourceFee : 0)) * 3n + 2_000_000n;
  const data = new SorobanDataBuilder()
    .setFootprint([...ro.values()], [...rw.values()])
    .setResources(
      r1.instructions() + (r2?.instructions() ?? 0) + 3_000_000,
      r1.diskReadBytes() + (r2?.diskReadBytes() ?? 0) + 4_000,
      r1.writeBytes() + 4_000,
    )
    .setResourceFee(resourceFee)
    .build();
  return { data, resourceFee };
}

/**
 * @param {object} p
 * @param {import("@stellar/stellar-sdk").rpc.Server} p.server
 * @param {string} p.networkPassphrase
 * @param {string} p.accountId   PassportAccount (C...) that pays
 * @param {import("@stellar/stellar-sdk").Keypair} p.agent     agent ed25519 key (signs the auth entry)
 * @param {import("@stellar/stellar-sdk").Keypair} p.feePayer  G account that is the tx source and pays the fee
 * @param {string} p.asset       USDC SAC
 * @param {string} p.to          destination (G... or C...)
 * @param {bigint} p.amount      base units (7 decimals)
 * @param {(diag: any[], accountId: string) => object|null} p.contractErrorFromDiagnostics
 */
export async function submitTransfer({ server, networkPassphrase, accountId, agent, feePayer, asset, to, amount, contractErrorFromDiagnostics }) {
  const source = await server.getAccount(feePayer.publicKey());
  const seq = source.sequenceNumber();
  const build = (op, opts = {}) => {
    // No memo: the network rejects Soroban txs with a memo ("Soroban transactions do not
    // support memos", seen on testnet on 25 oct). The memo only travels in the tool result.
    return new TransactionBuilder(new Account(feePayer.publicKey(), seq), { fee: "1000", networkPassphrase, ...opts })
      .addOperation(op)
      .setTimeout(120)
      .build();
  };
  const args = [
    nativeToScVal(accountId, { type: "address" }),
    nativeToScVal(to, { type: "address" }),
    nativeToScVal(BigInt(amount), { type: "i128" }),
  ];

  // 1) recording simulation: which auth entries are needed (does not run __check_auth yet)
  const t0 = build(new Contract(asset).call("transfer", ...args));
  const recSim = await server.simulateTransaction(t0);
  if (!rpc.Api.isSimulationSuccess(recSim)) {
    // Nothing to send: the transfer itself is invalid (no balance, no trustline at `to`, ...).
    return {
      status: "NOT_SENT",
      stage: "recording_simulation",
      error: String(recSim.error ?? "simulación fallida").slice(0, 500),
      contractError: extractContractError(recSim.error),
      note: "La simulación del transfer falló antes de llegar a __check_auth: no se mandó ninguna tx.",
    };
  }

  // 2) the agent signs the auth entry of SAC.transfer(from = PassportAccount)
  const latest = await server.getLatestLedger();
  const auth = await Promise.all(
    (recSim.result?.auth ?? []).map((e) =>
      e.credentials().switch().name === "sorobanCredentialsAddress"
        ? agentAuthorizer(agent)(e, null, latest.sequence + 60, networkPassphrase)
        : e,
    ),
  );
  const func = t0.operations[0].func;
  const signedOp = Operation.invokeHostFunction({ func, auth });

  // 3) enforcing simulation: here __check_auth runs against the real testnet state
  const t1 = build(signedOp);
  const enfSim = await server.simulateTransaction(t1);
  const enforcing = rpc.Api.isSimulationSuccess(enfSim)
    ? { ok: true }
    : { ok: false, error: String(enfSim.error ?? "").slice(0, 300), contractError: extractContractError(enfSim.error) };

  let tx;
  if (enforcing.ok) {
    tx = rpc.assembleTransaction(t1, enfSim).build();
  } else {
    const stTx = new TransactionBuilder(new Account(feePayer.publicKey(), "0"), { fee: "100", networkPassphrase })
      .addOperation(new Contract(accountId).call("spend_status"))
      .setTimeout(60)
      .build();
    const stSim = await server.simulateTransaction(stTx);
    const { data, resourceFee } = forcedSorobanData(recSim, stSim, accountId);
    tx = build(signedOp, { fee: (resourceFee + 1000n).toString(), sorobanData: data });
  }
  tx.sign(feePayer);

  // 4) always submit: the ledger decides
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") {
    let detail;
    try {
      detail = sent.errorResult?.result().switch().name;
    } catch {
      detail = undefined;
    }
    return { status: `SEND_${sent.status}`, hash: sent.hash, link: txLink(sent.hash), detail, enforcingSimulation: enforcing, forced: !enforcing.ok };
  }
  const r = await waitTx(server, sent.hash);
  const out = {
    status: r.status,
    hash: sent.hash,
    link: txLink(sent.hash),
    ledger: r.ledger,
    enforcingSimulation: enforcing,
    forced: !enforcing.ok,
  };
  if (r.status === "FAILED") {
    const ce = contractErrorFromDiagnostics(r.diagnosticEventsXdr ?? [], accountId);
    out.contractError = ce;
    out.rejectedBy = ce?.account === accountId ? `__check_auth de la PassportAccount ${accountId}` : "sin atribuir a la cuenta";
  }
  return out;
}
