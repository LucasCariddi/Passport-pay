import { useCallback, useEffect, useMemo, useState } from "react";
import { listMovements, type Movement } from "../lib/account";
import { agentCommand, fetchCatalog, matchPurchases, serverUrl, type Catalog, type CatalogService } from "../lib/catalog";
import { txLink } from "../lib/config";
import { parseUsdc, short, usdc, when } from "../lib/format";
import { Card } from "./ui";
import "../catalog.css";

// The server publishes the catalog (GET /catalog). Its text for people is shown in English here,
// keyed by service id; anything new from the server falls back to the server's own text.
const COPY: Record<string, { name: string; summary: string }> = {
  insight: { name: "Network insight", summary: "Latest ledger, protocol version and the suggested fee, so your transaction gets in without overpaying." },
  quote: { name: "XLM/USDC quote", summary: "Best bid and ask on the Stellar DEX, spread and book depth. With ?xlm= it estimates how much USDC you get." },
  report: { name: "Full report", summary: "Network state, quote and the paying account's spend, all together. The agent picks how much to pay with ?usd=." },
};
const copyOf = (s: CatalogService) => COPY[s.id] ?? { name: s.name, summary: s.summary };

/** The server's examples are written in Spanish: show the insight line in English. */
function englishExample(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(englishExample);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, englishExample(x)]));
  if (typeof v === "string")
    return v
      .replace(/protocolo/g, "protocol")
      .replace(/Fee de inclusión Soroban/g, "Soroban inclusion fee")
      .replace(/red tranquila, alcanza con el p50/g, "quiet network, p50 is enough")
      .replace(/red cargada, ofertá al menos el p90/g, "busy network, bid at least p90");
  return v;
}

function priceText(s: CatalogService): string {
  if (s.price.kind === "range" && s.price.min && s.price.max)
    return `${usdc(parseUsdc(s.price.min))} to ${usdc(parseUsdc(s.price.max))} USDC`;
  return `${usdc(s.price.base)} USDC`;
}

function ServiceCard({ s, account }: { s: CatalogService; account: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const cmd = agentCommand(s, account);
  const t = copyOf(s);
  return (
    <article className="svc" data-testid={`svc-${s.id}`}>
      <header className="svc-head">
        <h3>{t.name}</h3>
        <span className="svc-price">
          {priceText(s)}
          <small>{s.price.kind === "range" ? "per call, the agent picks" : "per call"}</small>
        </span>
      </header>
      <div className="svc-body">
        <p className="svc-sum">{t.summary}</p>
        <dl className="kv svc-kv">
          <dt>Route</dt>
          <dd className="mono">
            {s.method} {s.path}
          </dd>
          <dt>Who can buy</dt>
          <dd>Only agents with a passport</dd>
        </dl>
        <button type="button" className="btn ghost sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "How an agent buys it"}
        </button>
      </div>
      {open && (
        <div className="svc-how">
          <p className="small muted">From the project root, with the agent's key in .env:</p>
          <div className="svc-cmd">
            <code className="mono">{cmd}</code>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(cmd)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => {})
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="small muted">
            The server answers 402 with the price, the agent signs the payment from its account and the contract checks the passport
            and the cap before letting it through.
          </p>
          {s.exampleResponse != null && (
            <details>
              <summary className="small">Example response</summary>
              <pre className="svc-pre mono" tabIndex={0}>{JSON.stringify(englishExample(s.exampleResponse), null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </article>
  );
}

function Purchases({ catalog, account, owner, version }: { catalog: Catalog; account: string; owner: string | null; version: number }) {
  const [items, setItems] = useState<Movement[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setItems((await listMovements(account, owner)).items);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [account, owner]);

  useEffect(() => {
    load();
  }, [load, version]);

  const bought = useMemo(() => (items ? matchPurchases(items, catalog) : []), [items, catalog]);
  const total = bought.reduce((a, p) => a + BigInt(p.movement.amount), 0n);

  return (
    <Card
      id="compras"
      kicker="Ledger"
      title="What your agent bought"
      hint={
        items
          ? `${bought.length} recent ${bought.length === 1 ? "purchase" : "purchases"} for ${usdc(total)} USDC, account ${short(account, 4)}. Read from the network.`
          : `Payments from account ${short(account, 4)} to this catalog, read from the network.`
      }
      aside={
        <button type="button" className="btn ghost sm" onClick={load} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      }
    >
      {err && (
        <p className="note err" role="alert">
          Could not read the account's payments: {err}. Try Refresh in a few seconds.
        </p>
      )}
      {!items && !err && <p className="muted">Reading payments…</p>}
      {items && bought.length === 0 && (
        <div className="empty">
          <p>Your agent has not bought anything from this catalog yet.</p>
          <p className="small muted">Open a service, copy the command and run it: the payment shows up here in a few seconds.</p>
        </div>
      )}
      {bought.length > 0 && (
        <div className="table-box" role="region" aria-label="Purchases" tabIndex={0}>
          <table className="ledger" data-testid="purchases">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Amount</th>
                <th scope="col">When</th>
                <th scope="col">Tx</th>
              </tr>
            </thead>
            <tbody>
              {bought.slice(0, 100).map(({ movement: m, service }, i) => (
                <tr key={`${m.tx}-${i}`} className="buy">
                  <td className="move-kind">{service ? copyOf(service).name : "Unknown service"}</td>
                  <td className="mono num">{usdc(m.amount)} USDC</td>
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
      {bought.length > 0 && <p className="small muted">The onchain payment does not say which route was called: the service is inferred from the amount.</p>}
    </Card>
  );
}

export function CatalogPanel({ account, owner, version }: { account: string; owner: string | null; version: number }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setErr(null);
    fetchCatalog(ac.signal)
      .then(setCatalog)
      .catch((e) => {
        if (!ac.signal.aborted) setErr(String((e as Error)?.message ?? e));
      });
    return () => ac.abort();
  }, [attempt]);

  return (
    <div className="catalog" data-testid="catalog">
      <Card
        id="catalogo"
        className="plain"
        kicker="Price list"
        title="Catalog"
        display
        hint="APIs your agent can pay per call, in USDC. Only agents with a passport can buy, always within the cap you set."
      >
        {err && (
          <div className="note err" role="alert">
            <p className="catalog-errp">
              Could not read the catalog from {serverUrl()}: {err}.
            </p>
            <p className="catalog-errp small">Check that the server is running (node server/src/index.mjs) or set VITE_API_URL.</p>
            <button type="button" className="btn ghost sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        {!catalog && !err && <p className="muted">Reading the catalog…</p>}
        {catalog && catalog.services.length === 0 && <p className="muted">The server does not publish any service yet.</p>}
        {catalog && catalog.services.length > 0 && (
          <div className="svcs">
            {catalog.services.map((s) => (
              <ServiceCard key={s.id} s={s} account={account} />
            ))}
          </div>
        )}
      </Card>
      {catalog && <Purchases catalog={catalog} account={account} owner={owner} version={version} />}
      <p className="catalog-soon muted small">Coming soon: any API can list here.</p>
    </div>
  );
}
