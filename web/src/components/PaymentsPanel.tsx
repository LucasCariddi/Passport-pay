import { useCallback, useEffect, useState } from "react";
import { listMovements, type Movement } from "../lib/account";
import { accountLink, txLink } from "../lib/config";
import { short, usdc, when } from "../lib/format";
import { Card } from "./ui";

const KIND_TEXT: Record<Movement["kind"], string> = { pago: "Payment", "depósito": "Deposit", retiro: "Withdrawal" };

export function PaymentsPanel({ account, owner, version, title = "Agent payments" }: { account: string; owner: string | null; version: number; title?: string }) {
  const [items, setItems] = useState<Movement[] | null>(null);
  const [source, setSource] = useState<"api" | "rpc">("rpc");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await listMovements(account, owner);
      setItems(r.items);
      setSource(r.source);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [account, owner]);

  useEffect(() => {
    load();
  }, [load, version]);

  const payments = items?.filter((m) => m.kind === "pago") ?? [];
  const totalPaid = payments.reduce((a, m) => a + m.amount, 0n);

  return (
    <Card
      id="pagos"
      kicker="Ledger"
      title={title}
      hint={
        items
          ? `${payments.length} ${payments.length === 1 ? "payment" : "payments"} for ${usdc(totalPaid)} USDC in the last 7 days. Source: ${source === "api" ? "x402 server" : "network events (RPC)"}.`
          : "USDC movements of the account, read from the network."
      }
      aside={
        <button type="button" className="btn ghost sm" onClick={load} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      }
    >
      {err && <p className="note err">Could not read the movements: {err}. Try Refresh in a few seconds.</p>}
      {items && items.length === 0 && <p className="muted">No movements in the last 7 days yet.</p>}
      {!items && !err && <p className="muted">Reading events…</p>}
      {items && items.length > 0 && (
        <div className="table-box" role="region" aria-label={title} tabIndex={0}>
          <table className="ledger" data-testid="movements">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Amount</th>
                <th scope="col">Counterparty</th>
                <th scope="col">When</th>
                <th scope="col">Tx</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 100).map((m, i) => (
                <tr key={`${m.tx}-${i}`} className={`move ${m.kind}`}>
                  <td className="move-kind">
                    <span className={`ledger-stamp ${m.kind === "depósito" ? "in" : "out"}`}>{KIND_TEXT[m.kind]}</span>
                  </td>
                  <td className={`mono num move-amt ${m.kind === "depósito" ? "in" : ""}`}>
                    {m.kind === "depósito" ? "+" : "−"}
                    {usdc(m.amount)} USDC
                  </td>
                  <td>
                    <span className="muted">{m.kind === "depósito" ? "from " : "to "}</span>
                    <a href={accountLink(m.kind === "depósito" ? m.from : m.to)} target="_blank" rel="noreferrer" className="mono">
                      {short(m.kind === "depósito" ? m.from : m.to, 4)}
                    </a>
                  </td>
                  <td className="muted">{when(m.at)}</td>
                  <td>
                    <a className="mono" href={txLink(m.tx)} target="_blank" rel="noreferrer" title={m.tx}>
                      {short(m.tx, 6)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
