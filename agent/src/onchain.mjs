// Operaciones onchain del agente (y del dueño, solo para scripts y demo: en la web
// las firma Freighter). Todo contra Soroban RPC de testnet.
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { agentAuthorizer } from "./passport-account-scheme.mjs";
import { extractContractError } from "./errors.mjs";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const txLink = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`;
export const usdcToBase = (s) => {
  if (!/^\d+(\.\d{1,7})?$/.test(String(s))) throw new Error(`monto USDC inválido: ${s}`);
  const [i, d = ""] = String(s).split(".");
  return BigInt(i) * 10_000_000n + BigInt((d + "0000000").slice(0, 7));
};
export const baseToUsdc = (b) => {
  const n = BigInt(b ?? 0);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const s = `${a / 10_000_000n}.${(a % 10_000_000n).toString().padStart(7, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
  return (neg ? "-" : "") + s;
};

export function createOnchain({ rpcUrl, networkPassphrase = TESTNET_PASSPHRASE, server: injected }) {
  const server = injected ?? new rpc.Server(rpcUrl, { allowHttp: rpcUrl?.startsWith("http://") });
  const readSource = Keypair.random().publicKey();

  async function simulateCall(contractId, method, args = [], source = readSource) {
    const tx = new TransactionBuilder(new Account(source, "0"), { fee: "100", networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    return { tx, sim: await server.simulateTransaction(tx) };
  }

  async function read(contractId, method, args = []) {
    const { sim } = await simulateCall(contractId, method, args);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const e = new Error(`${method} falló: ${sim.error}`);
      e.contractError = extractContractError(sim.error);
      throw e;
    }
    return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
  }

  async function waitTx(hash, tries = 40) {
    for (let i = 0; i < tries; i++) {
      const r = await server.getTransaction(hash);
      if (r.status !== "NOT_FOUND") return r;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    return { status: "TIMEOUT" };
  }

  /** Firma y manda una invocación con `signer` como fuente (su firma cubre require_auth). */
  async function invoke(signer, contractId, method, args = []) {
    const acct = await server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(120)
      .build();
    let prepared;
    try {
      prepared = await server.prepareTransaction(tx);
    } catch (e) {
      const err = new Error(`simulación de ${method} falló: ${String(e?.message ?? e).slice(0, 300)}`);
      err.contractError = extractContractError(e?.message ?? e);
      throw err;
    }
    prepared.sign(signer);
    const sent = await server.sendTransaction(prepared);
    if (sent.status !== "PENDING") throw new Error(`envío de ${method} rechazado: ${sent.status} ${JSON.stringify(sent.errorResult ?? "")}`);
    const r = await waitTx(sent.hash);
    return { hash: sent.hash, status: r.status, link: txLink(sent.hash) };
  }

  /**
   * Busca Error(Contract, #n) en los eventos de diagnóstico de una tx fallida.
   *
   * Primero busca el evento del host "failed account authentication with error" y toma el
   * código de ESA cuenta: así el error queda atribuido a `__check_auth` de la PassportAccount
   * (el resultado trae `account`). Hace falta porque la SAC también tiene códigos #1 y #6
   * (InternalError, AccountMissingError) y un `Error(Contract, #6)` suelto no prueba que el
   * rechazo sea del tope. Si se pasa `accountId`, solo vale el evento de esa cuenta.
   * Si no hay evento de auth, cae al primer código de contrato que aparezca (sin `account`).
   */
  function contractErrorFromDiagnostics(diag = [], accountId) {
    for (const d of diag) {
      try {
        const body = d.event().body().v0();
        const isError = body.topics().some((t) => t.switch().name === "scvSymbol" && t.sym().toString() === "error");
        const data = body.data();
        if (!isError || data.switch().name !== "scvVec") continue;
        const [msg, acc, err] = data.vec() ?? [];
        if (!msg || msg.switch().name !== "scvString" || msg.str().toString() !== "failed account authentication with error") continue;
        if (!err || err.switch().name !== "scvError" || err.error().switch().name !== "sceContract") continue;
        const account = scValToNative(acc);
        if (accountId && account !== accountId) continue;
        return { ...extractContractError(`Error(Contract, #${err.error().contractCode()})`), account };
      } catch {
        // evento con otra forma: lo ignoramos
      }
    }
    const found = [];
    const visit = (v) => {
      if (!v || typeof v.switch !== "function") return;
      const k = v.switch().name;
      if (k === "scvError") {
        const e = v.error();
        if (e.switch().name === "sceContract") found.push(e.contractCode());
      } else if (k === "scvVec") (v.vec() ?? []).forEach(visit);
    };
    for (const d of diag) {
      try {
        const body = d.event().body().v0();
        body.topics().forEach(visit);
        visit(body.data());
      } catch {
        // evento con otra forma: lo ignoramos
      }
    }
    return found.length ? extractContractError(`Error(Contract, #${found[0]})`) : null;
  }

  /**
   * Manda DIRECTO a la red (sin servidor ni facilitador) un transfer desde la PassportAccount,
   * aunque la simulación enforcing diga que __check_auth lo rechaza. Así el ledger ejecuta
   * __check_auth de verdad y la tx queda FAILED con el error del contrato: es la prueba de que
   * el tope (o la revocación) se aplica onchain y no en un if del backend.
   *
   * Como una simulación fallida no devuelve footprint, lo armamos con la unión de:
   *  - la simulación "recording" del transfer (SAC, balances, nonce del auth entry), y
   *  - la simulación de `spend_status()` de la cuenta (instancia y wasm de la cuenta,
   *    instancia y wasm del validador, entrada Passport(agent_id)), que lee lo mismo que
   *    __check_auth y no falla por tope.
   */
  /**
   * Recording simulation of the SAC transfer + auth entry signed by the agent for `amount`.
   *
   * `footprintAmount` (optional): amount used ONLY in the recording simulation, which builds the
   * footprint and the auth entry. Needed when `amount` is above the account balance: recording
   * mode does not run __check_auth and would fail in the USDC contract on balance. Footprint keys
   * do not depend on the amount, so the amount is swapped in the operation and in the auth entry
   * (same nonce) before signing. Without `footprintAmount` nothing changes.
   */
  async function signTransferAuth({ accountId, agent, sourcePublic, asset, payTo, amount, footprintAmount }) {
    const argsFor = (n) => [
      nativeToScVal(accountId, { type: "address" }),
      nativeToScVal(payTo, { type: "address" }),
      nativeToScVal(BigInt(n), { type: "i128" }),
    ];
    const swap = footprintAmount != null && BigInt(footprintAmount) !== BigInt(amount);
    const args = argsFor(amount);
    const rec = await simulateCall(asset, "transfer", swap ? argsFor(footprintAmount) : args, sourcePublic);
    if (!rpc.Api.isSimulationSuccess(rec.sim)) throw new Error(`la simulación recording del transfer falló: ${rec.sim.error}`);
    const func = swap
      ? xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({ contractAddress: Address.fromString(asset).toScAddress(), functionName: "transfer", args }),
        )
      : rec.tx.operations[0].func;
    const withAmount = (e) => {
      if (!swap) return e;
      const copy = xdr.SorobanAuthorizationEntry.fromXDR(e.toXDR());
      const fn = copy.rootInvocation().function();
      if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("unexpected auth entry: not a contract call");
      fn.contractFn().args(args);
      return copy;
    };
    const latest = await server.getLatestLedger();
    const auth = await Promise.all(
      (rec.sim.result?.auth ?? []).map((e) =>
        e.credentials().switch().name === "sorobanCredentialsAddress"
          ? agentAuthorizer(agent)(withAmount(e), null, latest.sequence + 60, networkPassphrase)
          : e,
      ),
    );
    return { rec, func, auth };
  }

  /**
   * Signs, with the agent's key, a SAC transfer from the PassportAccount and simulates it in
   * enforcing mode (the signed auth entry makes the host run __check_auth against live testnet
   * state). Sends nothing. Returns `{ ok: true }` or `{ ok: false, error, contractError }`, with
   * `contractError.account` only when the diagnostic event attributes the code to `accountId`.
   */
  async function simulateAgentTransfer({ accountId, agentSecret, sourcePublic, asset, payTo, amount, footprintAmount }) {
    const agent = Keypair.fromSecret(agentSecret);
    const src = sourcePublic ?? readSource;
    const { func, auth } = await signTransferAuth({ accountId, agent, sourcePublic: src, asset, payTo, amount, footprintAmount });
    const tx = new TransactionBuilder(new Account(src, "0"), { fee: "100", networkPassphrase })
      .addOperation(Operation.invokeHostFunction({ func, auth }))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(sim)) return { ok: true };
    const error = String(sim.error ?? "");
    return { ok: false, error, contractError: contractErrorFromDiagnostics(sim.events ?? [], accountId) ?? extractContractError(error) };
  }

  async function forceTransferOnchain({ accountId, agentSecret, feePayerSecret, asset, payTo, amount, footprintAmount }) {
    const agent = Keypair.fromSecret(agentSecret);
    const payer = Keypair.fromSecret(feePayerSecret);
    const { rec, func, auth } = await signTransferAuth({ accountId, agent, sourcePublic: payer.publicKey(), asset, payTo, amount, footprintAmount });
    const st = await simulateCall(accountId, "spend_status");
    const stOk = rpc.Api.isSimulationSuccess(st.sim);

    const d1 = rec.sim.transactionData.build();
    const d2 = stOk ? st.sim.transactionData.build() : null;
    const keyStr = (k) => k.toXDR("base64");
    const rw = new Map(d1.resources().footprint().readWrite().map((k) => [keyStr(k), k]));
    const accountInstance = new Contract(accountId).getFootprint();
    rw.set(keyStr(accountInstance), accountInstance); // __check_auth escribe Spent en la instancia
    const ro = new Map();
    for (const k of [...d1.resources().footprint().readOnly(), ...(d2 ? d2.resources().footprint().readOnly() : [])]) {
      if (!rw.has(keyStr(k))) ro.set(keyStr(k), k);
    }
    const r1 = d1.resources();
    const r2 = d2?.resources();
    const instructions = r1.instructions() + (r2?.instructions() ?? 0) + 3_000_000;
    const readBytes = r1.diskReadBytes() + (r2?.diskReadBytes() ?? 0) + 4_000;
    const writeBytes = r1.writeBytes() + 4_000;
    const resourceFee = (BigInt(rec.sim.minResourceFee) + BigInt(stOk ? st.sim.minResourceFee : 0)) * 3n + 2_000_000n;
    const sorobanData = new SorobanDataBuilder()
      .setFootprint([...ro.values()], [...rw.values()])
      .setResources(instructions, readBytes, writeBytes)
      .setResourceFee(resourceFee)
      .build();

    const acct = await server.getAccount(payer.publicKey());
    const tx = new TransactionBuilder(acct, { fee: (resourceFee + 1000n).toString(), networkPassphrase, sorobanData })
      .addOperation(Operation.invokeHostFunction({ func, auth }))
      .setTimeout(120)
      .build();
    tx.sign(payer);
    const sent = await server.sendTransaction(tx);
    if (sent.status !== "PENDING") {
      return { hash: sent.hash, status: `SEND_${sent.status}`, link: txLink(sent.hash), detail: sent.errorResult?.result().switch().name };
    }
    const r = await waitTx(sent.hash);
    const ce = r.status === "FAILED" ? contractErrorFromDiagnostics(r.diagnosticEventsXdr ?? [], accountId) : null;
    return {
      hash: sent.hash,
      status: r.status,
      link: txLink(sent.hash),
      resultCode: r.resultXdr?.result?.().switch?.().name,
      contractError: ce,
      feeChargedStroops: r.resultXdr?.feeCharged?.()?.toString?.(),
    };
  }

  return { server, read, invoke, waitTx, forceTransferOnchain, simulateAgentTransfer, contractErrorFromDiagnostics };
}

export const addr = (a) => nativeToScVal(a, { type: "address" });
export const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
export const u32 = (n) => nativeToScVal(Number(n), { type: "u32" });
export const u256 = (n) => nativeToScVal(BigInt(n), { type: "u256" });
export const bytes32 = (buf) => xdr.ScVal.scvBytes(Buffer.from(buf));
