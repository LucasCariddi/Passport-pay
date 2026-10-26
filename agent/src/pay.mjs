// Un pedido pago x402 paso a paso (402 -> firma -> reintento con PAYMENT-SIGNATURE), con
// el resultado en una estructura para que la CLI lo muestre y los tests lo verifiquen.
// Hace lo mismo que wrapFetchWithPayment de @x402/fetch, pero sin esconder en qué paso
// se rechazó un pago: la simulación onchain del agente, la del facilitador o el settle.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { OnchainRejection } from "./passport-account-scheme.mjs";
import { byReason } from "./errors.mjs";

/**
 * @returns {Promise<{
 *   outcome: "paid"|"free"|"rejected_onchain_simulation"|"rejected_by_server"|"rejected_client_limit"|"http_error",
 *   status?: number, requirement?: object, body?: any, settle?: object, reason?: string,
 *   contractError?: object, error?: string, payload?: object
 * }>}
 */
export async function payAndFetch({ url, scheme, network = "stellar:testnet", maxAmountUsd = "$1", fetchImpl = fetch }) {
  const client = x402Client.fromConfig({
    schemes: [{ network, client: scheme }],
    spendControls: { maxAmountPerPayment: maxAmountUsd },
  });
  const http = new x402HTTPClient(client);

  const r1 = await fetchImpl(url);
  if (r1.status !== 402) {
    const body = await readBody(r1);
    return { outcome: r1.ok ? "free" : "http_error", status: r1.status, body };
  }
  const body1 = await readBody(r1);
  const paymentRequired = http.getPaymentRequiredResponse((n) => r1.headers.get(n), body1);
  const requirement = paymentRequired.accepts?.[0];

  let payload;
  try {
    payload = await client.createPaymentPayload(paymentRequired);
  } catch (e) {
    const cause = e instanceof OnchainRejection ? e : findCause(e);
    if (cause instanceof OnchainRejection) {
      return {
        outcome: "rejected_onchain_simulation",
        status: 402,
        requirement,
        stage: cause.stage,
        contractError: cause.contractError,
        error: cause.message,
      };
    }
    const msg = String(e?.message ?? e);
    if (/spendControls/i.test(msg)) return { outcome: "rejected_client_limit", status: 402, requirement, error: msg };
    throw e;
  }

  const headers = http.encodePaymentSignatureHeader(payload);
  const r2 = await fetchImpl(url, { headers });
  const body2 = await readBody(r2);
  const pr = r2.headers.get("payment-response");
  const settle = pr ? decodePaymentResponseHeader(pr) : undefined;
  if (r2.status === 200 && settle?.success !== false) {
    return { outcome: "paid", status: 200, requirement, body: body2, settle, payload };
  }
  let reason = settle?.errorReason;
  if (!reason && r2.headers.get("payment-required")) {
    try {
      reason = http.getPaymentRequiredResponse((n) => r2.headers.get(n), body2).error;
    } catch {
      // header ilegible
    }
  }
  reason = reason ?? body2?.error;
  return { outcome: "rejected_by_server", status: r2.status, requirement, reason, contractError: byReason(reason), body: body2, settle, payload };
}

function findCause(e) {
  let c = e;
  for (let i = 0; i < 5 && c; i++) {
    if (c instanceof OnchainRejection) return c;
    c = c.cause;
  }
  return null;
}

async function readBody(r) {
  const t = await r.text();
  try {
    return t ? JSON.parse(t) : undefined;
  } catch {
    return t;
  }
}
