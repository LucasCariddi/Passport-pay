// Errores del contrato PassportAccount (AccError). Espejo de server/src/errors.mjs:
// si cambia uno, cambiar el otro. Los códigos los devuelve el CONTRATO onchain.
export const ACC_ERRORS = {
  1: { name: "Revoked", reason: "revoked", es: "el dueño revocó la cuenta" },
  2: { name: "BadSignatureCount", reason: "bad_signature_count", es: "cantidad de firmas inválida" },
  3: { name: "UnknownSigner", reason: "unknown_signer", es: "la clave que firmó no es la del agente" },
  4: { name: "NoPassport", reason: "no_passport", es: "el agente no tiene pasaporte ZK en el validador" },
  5: { name: "ContextNotAllowed", reason: "context_not_allowed", es: "la cuenta solo autoriza transfer de USDC desde sí misma" },
  6: { name: "CapExceeded", reason: "cap_exceeded", es: "el pago supera el tope de gasto del período" },
  7: { name: "BadAmount", reason: "bad_amount", es: "monto inválido" },
  8: { name: "InvalidConfig", reason: "invalid_config", es: "configuración inválida" },
  9: { name: "PassportChanged", reason: "passport_changed", es: "el pasaporte del agente cambió (otro nullifier)" },
  // Wasm b9dfc7c6… only. The USDC contract uses the same #10 for insufficient balance: it means
  // PayeeNotAllowed only when the diagnostic event attributes it to the account (ARCHITECTURE 4.9).
  10: { name: "PayeeNotAllowed", reason: "payee_not_allowed", es: "el destino no está en la lista de destinos permitidos de la cuenta" },
};

export function extractContractError(text) {
  if (!text) return null;
  const s = String(text);
  const m = /Error\(Contract, #(\d+)\)/.exec(s) ?? /error:?\s*contract\s*#?(\d+)/i.exec(s);
  if (!m) return null;
  const code = Number(m[1]);
  return {
    code,
    raw: `Error(Contract, #${code})`,
    ...(ACC_ERRORS[code] ?? { name: `Unknown${code}`, reason: `contract_error_${code}`, es: "error del contrato" }),
  };
}

/** Motivo x402 (`cap_exceeded`, ...) -> entrada de la tabla, si es uno del contrato. */
export function byReason(reason) {
  const hit = Object.entries(ACC_ERRORS).find(([, v]) => v.reason === reason);
  return hit ? { code: Number(hit[0]), raw: `Error(Contract, #${hit[0]})`, ...hit[1] } : null;
}
