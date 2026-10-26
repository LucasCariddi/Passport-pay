import { useCallback, useState } from "react";
import { ContractError, type InvokeResult, type Phase } from "./soroban";

const PHASE_TEXT: Record<Phase, string> = {
  simulando: "Preparing the transaction…",
  firmando: "Waiting for your signature in the wallet…",
  enviando: "Sending to the network…",
  confirmando: "Waiting for confirmation…",
};

export interface TxState {
  busy: boolean;
  status: string | null;
  error: string | null;
  hash: string | null;
}

/**
 * State of an action that signs and sends a transaction. `errors` turns the contract's
 * `Error(Contract, #n)` codes into text for the user.
 */
export function useTx(errors: Record<number, string> = {}) {
  const [s, setS] = useState<TxState>({ busy: false, status: null, error: null, hash: null });

  const run = useCallback(
    async <T,>(fn: (onPhase: (p: Phase) => void) => Promise<InvokeResult<T> | { hash: string }>): Promise<T | undefined> => {
      setS({ busy: true, status: PHASE_TEXT.simulando, error: null, hash: null });
      try {
        const r = await fn((p) => setS((x) => ({ ...x, status: PHASE_TEXT[p] })));
        setS({ busy: false, status: null, error: null, hash: r.hash });
        return (r as InvokeResult<T>).value;
      } catch (e) {
        const code = e instanceof ContractError ? e.code : null;
        const msg = code != null && errors[code] ? `${errors[code]} (error #${code})` : String((e as Error)?.message ?? e);
        setS({ busy: false, status: null, error: friendly(msg), hash: null });
        return undefined;
      }
    },
    [errors],
  );

  const reset = useCallback(() => setS({ busy: false, status: null, error: null, hash: null }), []);
  return { ...s, run, reset };
}

function friendly(msg: string): string {
  if (/User declined|rejected|denied/i.test(msg)) return "You cancelled the signature in your wallet.";
  if (/Account not found/i.test(msg)) return "Your account does not exist on testnet yet. Fund it with friendbot first.";
  if (/insufficient|underfunded|balance is not sufficient/i.test(msg)) return "Your balance is not enough for this operation.";
  return msg;
}
