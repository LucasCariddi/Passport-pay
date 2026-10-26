import type { ReactNode } from "react";
import { txLink } from "../lib/config";
import { short } from "../lib/format";
import type { TxState } from "../lib/useTx";

/** A card: optional small label, the title, a one-line description and an optional aside. */
export function Card(props: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  id?: string;
  aside?: ReactNode;
  className?: string;
  display?: boolean;
  kicker?: string;
}) {
  return (
    <section className={`card ${props.className ?? ""}`} id={props.id} aria-labelledby={props.id ? `${props.id}-t` : undefined}>
      <header className="card-head">
        <div className="card-titles">
          {props.kicker && <span className="kicker">{props.kicker}</span>}
          <h2 id={props.id ? `${props.id}-t` : undefined} className={props.display ? "display" : undefined}>
            {props.title}
          </h2>
          {props.hint && <p className="hint">{props.hint}</p>}
        </div>
        {props.aside}
      </header>
      {props.children}
    </section>
  );
}

/** State of a transaction: progress, error or a link to the explorer. */
export function TxNote({ tx, done }: { tx: TxState; done?: string }) {
  if (tx.busy)
    return (
      <p className="note busy" role="status">
        <span className="spinner" aria-hidden /> {tx.status}
      </p>
    );
  if (tx.error)
    return (
      <p className="note err" role="alert">
        {tx.error}
      </p>
    );
  if (tx.hash)
    return (
      <p className="note ok" role="status" data-tx={tx.hash}>
        {done ?? "Done."}{" "}
        <a href={txLink(tx.hash)} target="_blank" rel="noreferrer">
          View transaction {short(tx.hash, 6)}
        </a>
      </p>
    );
  return null;
}

export function Stat(props: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <dt className="stat-label">{props.label}</dt>
      <dd className="stat-value">{props.value}</dd>
      {props.sub && <dd className="stat-sub">{props.sub}</dd>}
    </div>
  );
}

export function Copy({ text, label }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="mono-btn"
      title={`Copy ${text}`}
      aria-label={`Copy ${text}`}
      onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}
    >
      {label ?? short(text, 5)}
    </button>
  );
}

export function Pill({ kind, children, testid }: { kind: "ok" | "bad" | "wait" | "neutral"; children: ReactNode; testid?: string }) {
  return (
    <span className={`pill ${kind}`} data-testid={testid}>
      {children}
    </span>
  );
}

/**
 * The network's answer as a red badge: "FAILED · <contract error>". It always carries the real
 * error name and, when there is one, links the real tx hash on stellar.expert. Without a hash it
 * says so in its label instead of inventing one.
 */
export function Stamp(props: { error: string; code?: number | null; tx?: string | null; size?: "sm" | "md"; micro?: string; testid?: string }) {
  const label = `Rejected on Stellar testnet: ${props.error}${props.code != null ? `, error ${props.code}` : ""}.${props.tx ? ` Transaction ${short(props.tx, 6)} on stellar.expert` : " No transaction sent."}`;
  const body = (
    <>
      <span className="stamp-dot" aria-hidden="true" />
      FAILED · {props.error}
    </>
  );
  const cls = `stamp ${props.size ?? "md"}`;
  return props.tx ? (
    <a className={cls} href={txLink(props.tx)} target="_blank" rel="noreferrer" aria-label={label} data-testid={props.testid}>
      {body}
    </a>
  ) : (
    <span className={cls} role="img" aria-label={label} data-testid={props.testid}>
      {body}
    </span>
  );
}
