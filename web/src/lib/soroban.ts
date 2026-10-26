// Lecturas (simulación) y escrituras firmadas contra Soroban, sin bindings
// generados: las interfaces salen de docs/ARCHITECTURE.md, sección 4.
import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { CONFIG } from "./config";

export const server = new rpc.Server(CONFIG.rpcUrl, { allowHttp: CONFIG.rpcUrl.startsWith("http://") });

/** Firma un XDR de transacción y devuelve el XDR firmado (wallet o firmante de pruebas). */
export type Signer = (txXdr: string, address: string) => Promise<string>;

// Cuenta usada como origen para simulaciones de solo lectura cuando no hay
// wallet conectada. No firma nada; solo tiene que existir en testnet.
const READ_SOURCE = CONFIG.readSource;

// ------------------------------------------------------------ conversiones

export const u256 = (v: bigint | string | number) => nativeToScVal(BigInt(v), { type: "u256" });
export const i128 = (v: bigint | string | number) => nativeToScVal(BigInt(v), { type: "i128" });
export const u32 = (v: number) => nativeToScVal(v, { type: "u32" });
export const addr = (a: string) => Address.fromString(a).toScVal();
export const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
export const vec = (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items);
/** Struct de Soroban: mapa con claves Symbol ordenadas. */
export const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k] })),
  );

// ------------------------------------------------------------ errores

export class ContractError extends Error {
  code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

/** Saca el `Error(Contract, #n)` de un mensaje de simulación o de envío. */
export function contractCode(e: unknown): number | null {
  const s = String((e as Error)?.message ?? e);
  const m = s.match(/Error\(Contract, #(\d+)\)/);
  return m ? Number(m[1]) : null;
}

function shortError(raw: string): string {
  const first = raw.split("\n").find((l) => l.trim()) ?? raw;
  return first.length > 220 ? first.slice(0, 220) + "…" : first;
}

// ------------------------------------------------------------ lecturas

function buildTx(source: Account, contractId: string, method: string, args: xdr.ScVal[]): Transaction {
  return new TransactionBuilder(source, { fee: "1000000", networkPassphrase: CONFIG.networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
}

/** Simula una llamada y devuelve el resultado ya convertido a JS. Tira ContractError si falla. */
export async function read<T = unknown>(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<T> {
  const tx = buildTx(new Account(READ_SOURCE, "0"), contractId, method, args);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(shortError(sim.error), contractCode(sim.error));
  }
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return (retval ? scValToNative(retval) : undefined) as T;
}

// ------------------------------------------------------------ escrituras

export interface InvokeResult<T = unknown> {
  hash: string;
  ledger: number;
  value: T;
  feeStroops: string;
}

export type Phase = "simulando" | "firmando" | "enviando" | "confirmando";

/**
 * Arma la invocación, la simula (prepareTransaction agrega footprint, auth y fee),
 * la firma con la wallet y la envía. Espera la confirmación y devuelve el hash.
 */
export async function invoke<T = unknown>(
  opts: {
    contractId: string;
    method: string;
    args: xdr.ScVal[];
    source: string;
    sign: Signer;
    onPhase?: (p: Phase) => void;
  },
): Promise<InvokeResult<T>> {
  const { contractId, method, args, source, sign, onPhase } = opts;
  onPhase?.("simulando");
  const account = await server.getAccount(source);
  const raw = buildTx(account, contractId, method, args);
  let prepared: Transaction;
  try {
    prepared = await server.prepareTransaction(raw);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    throw new ContractError(shortError(msg), contractCode(msg));
  }

  onPhase?.("firmando");
  const signedXdr = await sign(prepared.toXDR(), source);
  const signed = TransactionBuilder.fromXDR(signedXdr, CONFIG.networkPassphrase) as Transaction;

  onPhase?.("enviando");
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    // La forma de errorResult cambió entre versiones del SDK: se lee con cuidado.
    const er = sent.errorResult as unknown as { result?: () => { switch?: () => { name?: string } } } | undefined;
    let detail = "error";
    try {
      detail = er?.result?.().switch?.().name ?? detail;
    } catch {
      /* queda "error" */
    }
    throw new ContractError(`The network rejected the transaction (${detail}). Hash ${sent.hash}`, null);
  }

  onPhase?.("confirmando");
  const done = await server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1000 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new ContractError(`Transaction ${sent.hash} ended as ${done.status}`, null);
  }
  const ok = done as rpc.Api.GetSuccessfulTransactionResponse;
  return {
    hash: sent.hash,
    ledger: ok.ledger,
    value: (ok.returnValue ? scValToNative(ok.returnValue) : undefined) as T,
    feeStroops: signed.fee,
  };
}

export async function latestLedger(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}
