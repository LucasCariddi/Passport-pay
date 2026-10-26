// Logic of the 4 MCP tools, independent from the MCP transport (so tests can inject mocks).
//
//   list_services  GET /api/catalog of the Passport Pay server (free)
//   buy            x402 payment from the PassportAccount (agent/src: PassportAccountExactScheme + payAndFetch)
//   spend_status   onchain reads: cap, spent, remaining, balance, revoked
//   pay            generic USDC transfer from the PassportAccount, sent to the network (src/transfer.mjs)
import { Keypair } from "@stellar/stellar-sdk";
import { addr, baseToUsdc, createOnchain, usdcToBase } from "../../agent/src/onchain.mjs";
import { PassportAccountExactScheme } from "../../agent/src/passport-account-scheme.mjs";
import { payAndFetch } from "../../agent/src/pay.mjs";
import { submitTransfer, txLink } from "./transfer.mjs";

const ADDRESS = /^[GC][A-Z2-7]{55}$/;
const AMOUNT = /^\d+(\.\d{1,7})?$/;

export class ToolInputError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ToolInputError";
  }
}

/** 0.1 | "0.1" -> "0.1"; rejects negatives, exponents and more than 7 decimals. */
export function normalizeAmount(v) {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(7).replace(/0+$/, "").replace(/\.$/, "") : "") : String(v ?? "").trim();
  if (!AMOUNT.test(s)) throw new ToolInputError(`monto inválido: ${v} (usá un número en USDC con hasta 7 decimales, p. ej. 0.05)`);
  if (usdcToBase(s) <= 0n) throw new ToolInputError("el monto tiene que ser mayor que 0");
  return s;
}

export function validateMemo(memo) {
  if (memo === undefined || memo === null || memo === "") return undefined;
  const m = String(memo);
  if (Buffer.byteLength(m, "utf8") > 28) throw new ToolInputError("el memo admite hasta 28 bytes");
  return m;
}

const big = (v) => (typeof v === "bigint" ? v.toString() : v);

export function createPassportPay(cfg, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const oc = deps.onchain ?? createOnchain({ rpcUrl: cfg.rpcUrl, networkPassphrase: cfg.networkPassphrase });
  const pay402 = deps.payAndFetch ?? payAndFetch;
  const transfer = deps.submitTransfer ?? submitTransfer;
  const makeScheme =
    deps.makeScheme ?? (() => new PassportAccountExactScheme({ accountId: cfg.accountId, agentSecret: cfg.agentSecret, rpcConfig: { url: cfg.rpcUrl } }));
  const agent = Keypair.fromSecret(cfg.agentSecret);
  const feePayer = Keypair.fromSecret(cfg.feePayerSecret);

  async function getCatalog() {
    const r = await fetchImpl(`${cfg.serverUrl}/api/catalog`);
    if (!r.ok) throw new Error(`el catálogo respondió HTTP ${r.status}`);
    return r.json();
  }

  async function listServices() {
    const c = await getCatalog();
    return {
      server: cfg.serverUrl,
      network: c.network,
      payTo: c.payTo,
      asset: c.asset,
      services: (c.services ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        summary: s.summary,
        price:
          s.price?.kind === "range"
            ? `entre ${s.price.min} y ${s.price.max} USDC (elegís con el parámetro ${s.price.param})`
            : `${s.price?.usdc} USDC`,
        params: s.params ?? [],
      })),
    };
  }

  async function buy({ service, params = {} }) {
    if (!service) throw new ToolInputError("falta service (usá list_services para ver los id)");
    const c = await getCatalog();
    const s = (c.services ?? []).find((x) => x.id === service || x.path === service);
    if (!s) throw new ToolInputError(`no existe el servicio "${service}". Disponibles: ${(c.services ?? []).map((x) => x.id).join(", ")}`);
    const u = new URL(cfg.serverUrl + s.path);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
    const r = await pay402({ url: u.toString(), scheme: makeScheme(), network: cfg.network, maxAmountUsd: `$${cfg.maxPerBuyUsdc}`, fetchImpl });
    const hash = r.settle?.transaction;
    const base = { service: s.id, url: u.toString(), outcome: r.outcome, httpStatus: r.status };
    if (r.requirement?.amount) base.priceUsdc = baseToUsdc(r.requirement.amount);
    switch (r.outcome) {
      case "paid":
        return { ...base, paid: true, hash, link: hash ? txLink(hash) : undefined, response: r.body };
      case "free":
        return { ...base, paid: false, response: r.body };
      case "rejected_onchain_simulation":
        return {
          ...base,
          paid: false,
          rejectedBy: "simulación onchain de __check_auth (la PassportAccount no autoriza este pago)",
          contractError: r.contractError,
          error: r.error,
        };
      case "rejected_by_server":
        return { ...base, paid: false, rejectedBy: "servidor x402 (402)", reason: r.reason, contractError: r.contractError, settle: r.settle };
      case "rejected_client_limit":
        return {
          ...base,
          paid: false,
          rejectedBy: `límite LOCAL de este MCP (PASSPORT_PAY_MAX_PER_BUY_USDC=${cfg.maxPerBuyUsdc}), no el tope onchain`,
          error: r.error,
        };
      default:
        return { ...base, paid: false, error: typeof r.body === "string" ? r.body.slice(0, 500) : r.body };
    }
  }

  async function spendStatus() {
    const [s, conf, bal, latest] = await Promise.all([
      oc.read(cfg.accountId, "spend_status"),
      oc.read(cfg.accountId, "config"),
      oc.read(cfg.asset, "balance", [addr(cfg.accountId)]),
      oc.server.getLatestLedger().catch(() => null),
    ]);
    const endsIn = latest ? Number(s.period_ends_ledger) - latest.sequence : undefined;
    return {
      account: cfg.accountId,
      agentId: big(conf.agent_id),
      owner: conf.owner,
      revoked: Boolean(conf.revoked),
      balanceUsdc: baseToUsdc(bal),
      capUsdc: baseToUsdc(s.effective_cap),
      spentUsdc: baseToUsdc(s.spent),
      remainingUsdc: baseToUsdc(s.remaining),
      periodLedgers: Number(conf.period_ledgers),
      periodEndsLedger: Number(s.period_ends_ledger),
      periodEndsInApproxMinutes: endsIn === undefined ? undefined : Math.max(0, Math.round((endsIn * 5) / 60)),
      enforcedBy: "__check_auth de la PassportAccount (onchain). Este MCP no aplica ningún tope propio en pay.",
      explorer: `https://stellar.expert/explorer/testnet/contract/${cfg.accountId}`,
    };
  }

  async function pay({ to, amount_usdc, memo }) {
    const dest = String(to ?? "").trim();
    if (!ADDRESS.test(dest)) throw new ToolInputError(`destino inválido: ${to} (tiene que ser una dirección Stellar G... o C...)`);
    if (dest === cfg.accountId) throw new ToolInputError("el destino es la misma cuenta que paga");
    const amount = normalizeAmount(amount_usdc);
    const m = validateMemo(memo);
    const r = await transfer({
      server: oc.server,
      networkPassphrase: cfg.networkPassphrase,
      accountId: cfg.accountId,
      agent,
      feePayer,
      asset: cfg.asset,
      to: dest,
      amount: usdcToBase(amount),
      contractErrorFromDiagnostics: oc.contractErrorFromDiagnostics,
    });
    const out = { from: cfg.accountId, to: dest, amountUsdc: amount, ...r };
    if (m) out.memo = { text: m, onchain: false, note: "Stellar no admite memo en txs de Soroban: el memo queda solo en esta respuesta." };
    return out;
  }

  return { listServices, buy, spendStatus, pay, cfg };
}
