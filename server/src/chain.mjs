// Lecturas onchain (Soroban RPC) que usa el servidor: admisión de pagadores,
// estado de la cuenta y historial de pagos (eventos `transfer` de la SAC).
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const EXPLORER = "https://stellar.expert/explorer/testnet";
export const txLink = (hash) => `${EXPLORER}/tx/${hash}`;
export const contractLink = (id) => `${EXPLORER}/contract/${id}`;

/** BigInt / bytes -> string, recursivo, para poder serializar a JSON. */
export function jsonSafe(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.from(v).toString("hex");
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export function isContractAddress(a) {
  return typeof a === "string" && StrKey.isValidContract(a);
}

/** El RPC de testnet escanea como mucho ~10 000 ledgers por pedido de getEvents. */
export const EVENTS_WINDOW = 10_000;

/**
 * @param {object} o
 * @param {string} o.rpcUrl
 * @param {string} o.asset            SAC de USDC
 * @param {string} [o.factoryId]      PassportFactory (si está desplegada)
 * @param {string[]|string} [o.accountWasmHashes] wasm hashes aceptados de PassportAccount
 * @param {string} [o.validatorId]    validador OSP que tiene que usar la cuenta
 * @param {object} [o.server]         rpc.Server inyectable (tests)
 */
export function createChain({
  rpcUrl,
  networkPassphrase = TESTNET_PASSPHRASE,
  asset,
  factoryId,
  accountWasmHashes,
  accountWasmHash,
  validatorId,
  readSource,
  server: injected,
}) {
  const server = injected ?? new rpc.Server(rpcUrl, { allowHttp: rpcUrl?.startsWith("http://") });
  // Fuente para simular lecturas: no necesita fondos ni existir (la simulación no cobra).
  const source = readSource || Keypair.random().publicKey();
  const wasmAllow = new Set(
    [accountWasmHashes, accountWasmHash]
      .flat()
      .filter(Boolean)
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  async function simulateRead(contractId, method, args = []) {
    const tx = new TransactionBuilder(new Account(source, "0"), { fee: "100", networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const e = new Error(`simulación de ${method} en ${contractId} falló: ${sim.error ?? "sin detalle"}`);
      e.simulationError = sim.error;
      throw e;
    }
    return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
  }

  async function getWasmHash(contractId) {
    const key = new Contract(contractId).getFootprint();
    const { entries } = await server.getLedgerEntries(key);
    if (!entries?.length) return null;
    const exec = entries[0].val.contractData().val().instance().executable();
    if (exec.switch().name !== "contractExecutableWasm") return null;
    return Buffer.from(exec.wasmHash()).toString("hex");
  }

  /**
   * Admisión: el pagador tiene que ser una PassportAccount legítima.
   * 1. Con factory: `PassportFactory.is_account(addr)` (fuente de verdad para cuentas nuevas).
   * 2. Si no (o la factory dice que no): el wasm de la cuenta está en la lista de wasm de
   *    PassportAccount Y su `config()` apunta al validador OSP y a la SAC de USDC. Sin ese
   *    segundo chequeo alguien podría desplegar el mismo wasm con un validador trucho.
   *    Así entra el agente #42, cuya cuenta es anterior a la factory.
   */
  async function isPassportAccount(addr) {
    if (!isContractAddress(addr)) return { ok: false, via: "not_contract" };
    if (factoryId) {
      try {
        const ok = await simulateRead(factoryId, "is_account", [nativeToScVal(addr, { type: "address" })]);
        if (ok === true) return { ok: true, via: "factory" };
      } catch (e) {
        if (!wasmAllow.size) return { ok: false, via: "factory_error", detail: e.simulationError ?? e.message };
      }
    }
    if (!wasmAllow.size) return { ok: false, via: factoryId ? "factory" : "unconfigured" };
    const h = await getWasmHash(addr);
    if (!h || !wasmAllow.has(h)) return { ok: false, via: "wasm_hash", wasmHash: h };
    let cfg;
    try {
      cfg = await simulateRead(addr, "config");
    } catch (e) {
      return { ok: false, via: "wasm_hash", wasmHash: h, detail: e.simulationError ?? e.message };
    }
    if (validatorId && cfg?.validator !== validatorId) return { ok: false, via: "wasm_hash", wasmHash: h, detail: "validador distinto" };
    if (asset && cfg?.token !== asset) return { ok: false, via: "wasm_hash", wasmHash: h, detail: "token distinto" };
    return { ok: true, via: "wasm_hash", wasmHash: h };
  }

  async function getAccountView(id) {
    const out = { id, config: null, spendStatus: null, balance: null, errors: {} };
    const addr = nativeToScVal(id, { type: "address" });
    await Promise.all([
      simulateRead(id, "config").then((v) => (out.config = jsonSafe(v)), (e) => (out.errors.config = e.simulationError ?? e.message)),
      simulateRead(id, "spend_status").then((v) => (out.spendStatus = jsonSafe(v)), (e) => (out.errors.spendStatus = e.simulationError ?? e.message)),
      simulateRead(asset, "balance", [addr]).then((v) => (out.balance = jsonSafe(v)), (e) => (out.errors.balance = e.simulationError ?? e.message)),
    ]);
    if (!Object.keys(out.errors).length) delete out.errors;
    return out;
  }

  /**
   * Pagos = eventos `transfer` de la SAC con `from` (y/o `to`) dados. Lee de RPC getEvents
   * en ventanas de EVENTS_WINDOW ledgers hacia atrás, desde el último ledger, hasta juntar
   * `limit` o llegar a `lookbackLedgers` (o al ledger más viejo que retiene el RPC).
   */
  async function getPayments({ from, to, limit = 50, lookbackLedgers = 30_000 } = {}) {
    const latest = (await server.getLatestLedger()).sequence;
    const sym = nativeToScVal("transfer", { type: "symbol" }).toXDR("base64");
    const fromT = from ? nativeToScVal(from, { type: "address" }).toXDR("base64") : "*";
    const toT = to ? nativeToScVal(to, { type: "address" }).toXDR("base64") : "*";
    const filters = [{ type: "contract", contractIds: [asset], topics: [[sym, fromT, toT, "*"]] }];
    const events = [];
    const floor = Math.max(2, latest - lookbackLedgers);
    // Ojo: con endLedger > último ledger el RPC de testnet devuelve vacío; por eso `latest`.
    let end = latest;
    const skipped = [];
    while (end > floor && events.length < limit) {
      let start = Math.max(floor, end - EVENTS_WINDOW);
      let cursor;
      for (let page = 0; page < 10; page++) {
        let res;
        try {
          res = await server.getEvents(
            cursor ? { filters, cursor, limit: 200 } : { filters, startLedger: start, endLedger: end, limit: 200 },
          );
        } catch (e) {
          const msg = String(e?.message ?? JSON.stringify(e));
          // "startLedger must be between the oldest ledger: X and ..." -> recortamos.
          const m = /oldest ledger:?\s*(\d+)/i.exec(msg);
          if (!cursor && m && Number(m[1]) > start) {
            start = Number(m[1]);
            page--;
            if (start >= end) break;
            continue;
          }
          // Ventanas viejas a veces superan el límite de procesamiento del RPC: la salteamos.
          if (/processing limit/i.test(msg)) {
            skipped.push([start, end]);
            break;
          }
          throw e;
        }
        for (const ev of res.events ?? []) events.push(eventToPayment(ev));
        if (!res.events?.length || res.events.length < 200) break;
        cursor = res.cursor;
      }
      if (start <= floor) break;
      end = start;
    }
    // dedupe (una tx puede aparecer en el borde de dos ventanas) y orden descendente
    const seen = new Set();
    const uniq = events.filter((e) => {
      const k = `${e.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    uniq.sort((a, b) => b.ledger - a.ledger);
    const out = uniq.slice(0, limit);
    if (skipped.length) Object.defineProperty(out, "skippedWindows", { value: skipped });
    return out;
  }

  /** Re-simula una tx de pago y devuelve el texto de error (para mapear Error(Contract, #n)). */
  async function simulationError(txXdr) {
    const tx = new Transaction(txXdr, networkPassphrase);
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(sim)) return null;
    return sim.error ?? "simulation failed";
  }

  return { server, simulateRead, getWasmHash, isPassportAccount, getAccountView, getPayments, simulationError };
}

export function eventToPayment(ev) {
  const topics = ev.topic.map((t) => scValToNative(t));
  let amount = scValToNative(ev.value);
  if (amount && typeof amount === "object" && "amount" in amount) amount = amount.amount; // CAP-67 con muxed id
  return {
    id: ev.id,
    tx: ev.txHash,
    ledger: ev.ledger,
    from: topics[1],
    to: topics[2],
    amount: String(amount),
    at: ev.ledgerClosedAt,
    link: txLink(ev.txHash),
  };
}

/** Saca `from`, `to` y `amount` del transfer que viene en un payload x402 exact. */
export function decodeTransferFromTxXdr(txXdr, networkPassphrase = TESTNET_PASSPHRASE) {
  let tx;
  try {
    tx = new Transaction(txXdr, networkPassphrase);
  } catch {
    return null;
  }
  const op = tx.operations[0];
  if (!op || op.type !== "invokeHostFunction") return null;
  const f = op.func;
  if (f.switch().name !== "hostFunctionTypeInvokeContract") return null;
  const ic = f.invokeContract();
  const args = ic.args();
  if (ic.functionName().toString() !== "transfer" || args.length !== 3) return null;
  return {
    contract: Address.fromScAddress(ic.contractAddress()).toString(),
    from: scValToNative(args[0]),
    to: scValToNative(args[1]),
    amount: scValToNative(args[2]).toString(),
  };
}

export { xdr };
