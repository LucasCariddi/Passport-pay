// PassportAccount: la cuenta contrato que paga por x402 (ARCHITECTURE.md 4.1).
import { Address, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CONFIG } from "./config";
import { addr, bytes, i128, invoke, latestLedger, read, server, u32, ContractError, type Phase, type Signer } from "./soroban";

export interface AccountConfig {
  owner: string;
  agent_key: Uint8Array;
  validator: string;
  agent_id: bigint;
  token: string;
  cap: bigint;
  period_ledgers: number;
  revoked: boolean;
}

export interface SpendStatus {
  period: number;
  spent: bigint;
  effective_cap: bigint;
  remaining: bigint;
  period_ends_ledger: number;
}

export const ACCOUNT_ERRORS: Record<number, string> = {
  1: "This account is revoked",
  2: "Wrong number of signatures",
  3: "Signed by an unknown key",
  4: "The agent has no passport in the validator",
  5: "This operation is not allowed for this account",
  6: "The payment goes over the spend cap for this period",
  7: "Invalid amount",
  8: "Invalid configuration (negative cap or zero period)",
  9: "The agent's passport changed",
  10: "The payee is not on the owner's list",
};

/** Contract error names, as the Rust enum spells them (contracts/passport-account). */
export const ACCOUNT_ERROR_NAMES: Record<number, string> = {
  1: "Revoked", 2: "BadSignatureCount", 3: "UnknownSigner", 4: "NoPassport", 5: "ContextNotAllowed",
  6: "CapExceeded", 7: "BadAmount", 8: "InvalidConfig", 9: "PassportChanged", 10: "PayeeNotAllowed",
};

export const getConfig = (id: string) => read<AccountConfig>(id, "config");

export async function getSpendStatus(id: string): Promise<SpendStatus | null> {
  try {
    return await read<SpendStatus>(id, "spend_status");
  } catch (e) {
    if (e instanceof ContractError && e.code === 4) return null; // sin pasaporte
    throw e;
  }
}

export const getUsdcBalance = (holder: string) => read<bigint>(CONFIG.usdcSac, "balance", [addr(holder)]);

/**
 * Payee list of the account (read only). Accounts created before the payee list (wasm
 * f5ec1e6d and older) have no `payees` function: that comes back as `null`.
 */
export async function getPayees(id: string): Promise<string[] | null> {
  try {
    const r = await read<unknown>(id, "payees");
    return Array.isArray(r) ? r.map(String) : [];
  } catch (e) {
    if (/MissingValue|non-existent|not found|InvalidAction/i.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
}

export const agentKeyToG = (k: Uint8Array) => StrKey.encodeEd25519PublicKey(Buffer.from(k));

type Act = { account: string; owner: string; sign: Signer; onPhase?: (p: Phase) => void };

export const setCap = (a: Act & { capBase: bigint; periodLedgers: number }) =>
  invoke({ contractId: a.account, method: "set_cap", args: [i128(a.capBase), u32(a.periodLedgers)], source: a.owner, sign: a.sign, onPhase: a.onPhase });

export const revoke = (a: Act) =>
  invoke({ contractId: a.account, method: "revoke", args: [], source: a.owner, sign: a.sign, onPhase: a.onPhase });

/** Rota la clave del agente. El contrato además des-revoca la cuenta. */
export const setAgentKey = (a: Act & { agentKey: string }) =>
  invoke({
    contractId: a.account,
    method: "set_agent_key",
    args: [bytes(StrKey.decodeEd25519PublicKey(a.agentKey))],
    source: a.owner,
    sign: a.sign,
    onPhase: a.onPhase,
  });

/** El dueño deposita USDC en la cuenta (transfer de la SAC). */
export const deposit = (a: Act & { amountBase: bigint }) =>
  invoke({
    contractId: CONFIG.usdcSac,
    method: "transfer",
    args: [addr(a.owner), addr(a.account), i128(a.amountBase)],
    source: a.owner,
    sign: a.sign,
    onPhase: a.onPhase,
  });

export const withdraw = (a: Act & { to: string; amountBase: bigint }) =>
  invoke({ contractId: a.account, method: "withdraw", args: [addr(a.to), i128(a.amountBase)], source: a.owner, sign: a.sign, onPhase: a.onPhase });

// ------------------------------------------------------------ movimientos

export interface Movement {
  kind: "pago" | "depósito" | "retiro";
  tx: string;
  ledger: number;
  at: string;
  from: string;
  to: string;
  amount: bigint;
}

const sym = (s: string) => nativeToScVal(s, { type: "symbol" }).toXDR("base64");
const ledgerOfCursor = (c: string) => Number(BigInt(c.split("-")[0]) >> 32n);

/**
 * Lee los transfer de la SAC de USDC que salen de la cuenta (pagos x402 y
 * retiros) o entran (depósitos). El RPC solo recorre ~10 000 ledgers por
 * pedido, así que se pagina con el cursor hasta llegar al último ledger.
 */
async function movementsFromRpc(account: string, lookbackLedgers: number): Promise<Movement[]> {
  const latest = await latestLedger();
  const me = Address.fromString(account).toScVal().toXDR("base64");
  const topicsOut = [sym("transfer"), me, "*", "*"];
  const topicsIn = [sym("transfer"), "*", me, "*"];
  const filters = [{ type: "contract" as const, contractIds: [CONFIG.usdcSac], topics: [topicsOut, topicsIn] }];

  let startLedger = Math.max(2, latest - lookbackLedgers);
  const out: Movement[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 40; i++) {
    let res: Awaited<ReturnType<typeof server.getEvents>>;
    try {
      res = cursor
        ? await server.getEvents({ cursor, filters, limit: 200 })
        : await server.getEvents({ startLedger, filters, limit: 200 });
    } catch (e) {
      // Si pedimos más atrás que la retención del RPC, el error trae el rango válido.
      const m = String((e as Error)?.message ?? e).match(/ledger range:? (\d+)/i);
      if (!cursor && m && Number(m[1]) > startLedger) {
        startLedger = Number(m[1]);
        continue;
      }
      throw e;
    }
    for (const ev of res.events) {
      const [, fromV, toV] = ev.topic;
      const from = String(scValToNative(fromV as xdr.ScVal));
      const to = String(scValToNative(toV as xdr.ScVal));
      const amount = BigInt(scValToNative(ev.value as xdr.ScVal) as bigint);
      const kind: Movement["kind"] = to === account ? "depósito" : "pago";
      out.push({ kind, tx: ev.txHash, ledger: ev.ledger, at: ev.ledgerClosedAt, from, to, amount });
    }
    if (!res.cursor || res.cursor === cursor) break;
    cursor = res.cursor;
    // Página incompleta y el cursor ya llegó al último ledger: no hay más.
    if (res.events.length < 200 && ledgerOfCursor(cursor) >= (res.latestLedger ?? latest) - 1) break;
  }
  return out;
}

/** Si el servidor x402 está configurado, usa /api/payments; si falla, va directo al RPC. */
export async function listMovements(account: string, owner: string | null, lookbackLedgers = 120_960): Promise<{ items: Movement[]; source: "api" | "rpc" }> {
  let items: Movement[] | null = null;
  let source: "api" | "rpc" = "rpc";
  if (CONFIG.apiUrl) {
    try {
      const r = await fetch(`${CONFIG.apiUrl}/api/payments?account=${account}&limit=200`);
      if (r.ok) {
        const body = await r.json();
        const rows: Array<{ tx: string; ledger: number; from: string; to: string; amount: string | number; at: string }> =
          Array.isArray(body) ? body : body.payments ?? body.items ?? [];
        items = rows.map((p) => ({
          kind: p.to === account ? "depósito" : "pago",
          tx: p.tx,
          ledger: Number(p.ledger),
          at: p.at,
          from: p.from,
          to: p.to,
          amount: BigInt(p.amount),
        }));
        source = "api";
      }
    } catch {
      items = null;
    }
  }
  if (!items) items = await movementsFromRpc(account, lookbackLedgers);
  // Lo que sale hacia el propio dueño es un retiro, no un pago del agente.
  for (const m of items) if (m.kind === "pago" && owner && m.to === owner) m.kind = "retiro";
  items.sort((a, b) => b.ledger - a.ledger);
  return { items, source };
}
