// Facilitador x402 LOCAL (código oficial de @x402/stellar/exact/facilitator) envuelto
// como FacilitatorClient para x402ResourceServer, con tres agregados:
//
// 1. Admisión: antes de verify/settle, el pagador tiene que ser una PassportAccount
//    (lectura onchain, ver chain.isPassportAccount). Es la única regla de servidor.
// 2. Diagnóstico: si la simulación falla, re-simulamos la misma tx para leer el
//    `Error(Contract, #n)` que devolvió __check_auth y lo mapeamos a cap_exceeded,
//    revoked, no_passport... El rechazo lo decide el CONTRATO, acá solo lo traducimos.
// 3. Settles en serie: el facilitador firma con una sola cuenta G, así que dos settles
//    en paralelo usan el mismo número de secuencia y uno falla. Con la cola, el segundo
//    re-verifica después del primero y, si ya no hay tope, recibe un 402 limpio.
import { x402Facilitator } from "@x402/core/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as FacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { decodeTransferFromTxXdr, txLink } from "./chain.mjs";
import { describeContractError, extractContractError, SIMULATION_REASONS } from "./errors.mjs";

export function createOfficialFacilitator({ network, facilitatorSecret, maxFeeStroops, rpcUrl }) {
  if (!facilitatorSecret) throw new Error("falta FACILITATOR_SECRET en .env (scripts/gen-keys.sh)");
  return new x402Facilitator().register(
    network,
    new FacilitatorScheme([createEd25519Signer(facilitatorSecret, network)], {
      // El default (50 000 stroops) rechaza hasta un transfer simple en testnet (~83 000).
      maxTransactionFeeStroops: maxFeeStroops,
      rpcConfig: rpcUrl ? { url: rpcUrl } : undefined,
    }),
  );
}

/** Cola mínima: ejecuta las funciones de a una, en orden de llegada. */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");
export const fmtUsdc = (base) => (Number(BigInt(base ?? 0)) / 1e7).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");

/**
 * @param {object} o
 * @param {{verify, settle, getSupported}} o.inner  facilitador oficial (o mock en tests)
 * @param {{isPassportAccount, simulationError}} o.chain
 * @param {string} o.networkPassphrase
 * @param {(line: string) => void} [o.log]
 * @param {(rec: object) => void} [o.record]  registro de pagos/rechazos para /api/payments/recent
 */
export function createPassportFacilitatorClient({ inner, chain, networkPassphrase, log = console.log, record = () => {} }) {
  const serial = createSerialQueue();
  const admissionCache = new Map(); // payer -> { ok, via, at }

  async function admit(payer) {
    const hit = admissionCache.get(payer);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const r = await chain.isPassportAccount(payer);
    const out = { ...r, at: Date.now() };
    if (r.ok) admissionCache.set(payer, out);
    return out;
  }

  function payloadInfo(payload) {
    const txXdr = payload?.payload?.transaction;
    const t = txXdr ? decodeTransferFromTxXdr(txXdr, networkPassphrase) : null;
    return { txXdr, transfer: t, payer: t?.from };
  }

  /** Traduce un motivo del facilitador a uno nuestro leyendo el error real del contrato. */
  async function diagnose(reason, txXdr) {
    if (!SIMULATION_REASONS.has(reason) || !txXdr) return { reason };
    let simErr = null;
    try {
      simErr = await chain.simulationError(txXdr);
    } catch (e) {
      simErr = String(e?.message ?? e);
    }
    const ce = extractContractError(simErr);
    if (ce) return { reason: ce.reason, contractError: ce, detail: describeContractError(ce) };
    return { reason, detail: simErr ? String(simErr).slice(0, 300) : undefined };
  }

  async function checkAdmission(payload, phase) {
    const { payer, transfer } = payloadInfo(payload);
    if (!payer) return { isValid: false, invalidReason: "invalid_exact_stellar_payload_malformed" };
    let adm;
    try {
      adm = await admit(payer);
    } catch (e) {
      log(`[admisión] error leyendo ${payer}: ${e.message}`);
      return { isValid: false, invalidReason: "admission_check_failed", payer };
    }
    if (!adm.ok) {
      log(`[admisión] RECHAZADO ${phase}: ${payer} no es una PassportAccount (vía ${adm.via}${adm.detail ? `, ${adm.detail}` : ""})`);
      record({ kind: "rejected", phase, payer, amount: transfer?.amount, reason: "payer_not_passport_account", via: adm.via });
      return { isValid: false, invalidReason: "payer_not_passport_account", invalidMessage: `admission via ${adm.via}`, payer };
    }
    return null;
  }

  return {
    async verify(payload, requirements) {
      const bad = await checkAdmission(payload, "verify");
      if (bad) return bad;
      const res = await inner.verify(payload, requirements);
      if (res.isValid) return res;
      const { txXdr, transfer, payer } = payloadInfo(payload);
      const d = await diagnose(res.invalidReason, txXdr);
      log(
        `[verify] RECHAZADO ${short(payer)} ${fmtUsdc(transfer?.amount)} USDC: ${d.reason}` +
          (d.detail ? ` (${d.detail}; lo devolvió el contrato en la simulación onchain)` : ""),
      );
      record({ kind: "rejected", phase: "verify", payer, amount: transfer?.amount, reason: d.reason, contractError: d.contractError?.raw, detail: d.detail });
      return { ...res, invalidReason: d.reason, invalidMessage: d.detail ?? res.invalidMessage };
    },

    settle(payload, requirements) {
      return serial(async () => {
        const bad = await checkAdmission(payload, "settle");
        if (bad) return { success: false, network: requirements.network, transaction: "", errorReason: bad.invalidReason, payer: bad.payer };
        const { txXdr, transfer, payer } = payloadInfo(payload);
        const res = await inner.settle(payload, requirements);
        if (res.success) {
          log(`[settle] OK ${short(payer)} -> ${short(transfer?.to)} ${fmtUsdc(transfer?.amount)} USDC tx=${res.transaction} ${txLink(res.transaction)}`);
          record({ kind: "paid", payer, to: transfer?.to, amount: transfer?.amount, tx: res.transaction, link: txLink(res.transaction) });
          return res;
        }
        const d = await diagnose(res.errorReason, txXdr);
        log(
          `[settle] FALLÓ ${short(payer)} ${fmtUsdc(transfer?.amount)} USDC: ${d.reason}` +
            (d.detail ? ` (${d.detail})` : "") +
            (res.transaction ? ` tx=${res.transaction} ${txLink(res.transaction)}` : ""),
        );
        record({ kind: "rejected", phase: "settle", payer, amount: transfer?.amount, reason: d.reason, contractError: d.contractError?.raw, detail: d.detail, tx: res.transaction || undefined });
        return { ...res, errorReason: d.reason, errorMessage: d.detail ?? res.errorMessage };
      });
    },

    getSupported: async () => inner.getSupported(),
  };
}
