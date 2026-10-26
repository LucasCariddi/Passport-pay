import { useCallback, useEffect, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { AccountPanel } from "./components/AccountPanel";
import { AgentDemoPanel } from "./components/AgentDemoPanel";
import { CatalogPanel } from "./components/CatalogPanel";
import { FireTest } from "./components/FireTest";
import { MintPanel } from "./components/MintPanel";
import { PaymentsPanel } from "./components/PaymentsPanel";
import { CONFIG } from "./lib/config";
import { short } from "./lib/format";
import { connectWallet, disconnectWallet, type Wallet } from "./lib/wallet";

const initialAccount = () => {
  const q = new URLSearchParams(location.search).get("account");
  return q && StrKey.isValidContract(q) ? q : CONFIG.defaultAccount;
};

// Views: the hash picks one (deep links). Spanish hashes from older links keep working.
type Tab = "cuenta" | "mint" | "catalogo" | "probar";
const HASH_TAB: Record<string, Tab> = {
  "#fire": "probar", "#try": "probar", "#probar": "probar",
  "#panel": "cuenta", "#cuenta": "cuenta",
  "#catalog": "catalogo", "#catalogo": "catalogo",
  "#passport": "mint", "#mint": "mint",
};
const tabFromHash = (): Tab => HASH_TAB[location.hash] ?? (new URLSearchParams(location.search).has("account") ? "cuenta" : "probar");
const NAV: { hash: string; tab: Tab; label: string; testid?: string }[] = [
  { hash: "#fire", tab: "probar", label: "Prompt injection test", testid: "tab-probar" },
  { hash: "#try", tab: "probar", label: "Try as an agent" },
  { hash: "#panel", tab: "cuenta", label: "Owner panel", testid: "tab-cuenta" },
  { hash: "#catalog", tab: "catalogo", label: "Catalog", testid: "tab-catalogo" },
  { hash: "#passport", tab: "mint", label: "New passport", testid: "tab-mint" },
];

const MOON = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M16.5 12.5A7 7 0 0 1 7.5 3.5a7 7 0 1 0 9 9z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

function toggleTheme() {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try {
    localStorage.setItem("pp-theme", next);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

export function App() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [account, setAccount] = useState(initialAccount);
  const [accountInput, setAccountInput] = useState(account);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [hash, setHash] = useState(() => location.hash);
  const [price, setPrice] = useState<string | null>(null);
  // Account the server uses for "Try as an agent" (it decides, from /api/demo/status).
  const [demoAccount, setDemoAccount] = useState<string | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!CONFIG.apiUrl) return;
    fetch(`${CONFIG.apiUrl}/api/health`)
      .then((r) => (r.ok ? r.json() : null))
      // The server returns `prices` per route, e.g. { "/api/premium/insight": "$0.01" }.
      .then((h) => {
        const raw = h?.prices?.["/api/premium/insight"];
        if (typeof raw === "string" && /^\$\d/.test(raw)) setPrice(raw.replace(/^\$/, ""));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onHash = () => {
      setHash(location.hash);
      if (HASH_TAB[location.hash]) setTab(HASH_TAB[location.hash]);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // After a view change from the nav, bring the target section into view (fire vs try).
  useEffect(() => {
    const id = hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [hash, tab]);

  const connect = async () => {
    setConnecting(true);
    setWalletErr(null);
    try {
      setWallet(await connectWallet());
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      setWalletErr(/closed|cancel/i.test(msg) ? null : `Could not connect the wallet: ${msg}`);
    } finally {
      setConnecting(false);
    }
  };

  const openAccount = (id: string) => {
    setAccount(id);
    setAccountInput(id);
    setTab("cuenta");
    history.replaceState(null, "", `?account=${id}#panel`);
    setHash("#panel");
  };

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="app-header-row">
          <a href="/" className="brand">
            <span className="brand-name">Passport Pay</span>
            <span className="net-tag">Testnet</span>
          </a>
          <div className="header-tools">
            <form
              className="lookup"
              onSubmit={(e) => {
                e.preventDefault();
                const id = accountInput.trim();
                if (StrKey.isValidContract(id)) openAccount(id);
                else alert("Paste the agent account ID (it starts with C).");
              }}
            >
              <label htmlFor="acct">Agent account</label>
              <input
                id="acct"
                className="mono"
                name="account"
                value={accountInput}
                onChange={(e) => setAccountInput(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="C…"
              />
              <button type="submit" className="btn ghost sm">
                Open
              </button>
            </form>
            {wallet ? (
              <div className="who">
                <span className="mono" title={wallet.address} data-testid="wallet-address">
                  {short(wallet.address, 4)}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={async () => {
                    await disconnectWallet();
                    setWallet(null);
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button type="button" className="btn primary sm" onClick={connect} disabled={connecting} data-testid="connect">
                {connecting ? "Connecting…" : "Connect wallet"}
              </button>
            )}
            <button type="button" className="theme-btn" onClick={toggleTheme} aria-label="Switch between light and dark mode">
              {MOON}
            </button>
          </div>
        </div>
      </header>
      {walletErr && (
        <p className="note err wrap" role="alert">
          {walletErr}
        </p>
      )}

      <main id="main" className="wrap app-main">
        <h1 className="sr-only">Passport Pay app</h1>
        <div className="page-head">
          <p className="lead-line">
            Every agent pays from its own smart account, and the spending rules live in that contract: if the agent breaks them, the network
            refuses the payment.{price && <> The cheapest call in the catalog costs {price} USDC.</>}
          </p>
        </div>

        <div className="nav-band">
          <nav className="app-nav" aria-label="Sections">
            {NAV.map((n) => {
              const on = tab === n.tab && (n.tab !== "probar" || (n.hash === "#try" ? hash === "#try" : hash !== "#try"));
              return (
                <a
                  key={n.hash}
                  href={n.hash}
                  className={`nav-idx${on ? " on" : ""}`}
                  aria-current={on ? "page" : undefined}
                  data-testid={n.testid}
                  onClick={() => {
                    setTab(n.tab);
                    setHash(n.hash);
                  }}
                >
                  {n.label}
                </a>
              );
            })}
          </nav>
        </div>

        {tab === "probar" ? (
          <div className="stack">
            <FireTest demoAccount={demoAccount} />
            <AgentDemoPanel onPaid={bump} onAccount={setDemoAccount} />
            {demoAccount && <PaymentsPanel key={demoAccount} account={demoAccount} owner={null} version={version} title="What the demo agent paid" />}
          </div>
        ) : tab === "catalogo" ? (
          <CatalogPanel account={account} owner={wallet?.address ?? null} version={version} />
        ) : tab === "cuenta" ? (
          <div className="stack">
            <AccountPanel key={account} account={account} wallet={wallet} onChanged={() => setVersion((v) => v + 1)} />
            <PaymentsPanel account={account} owner={wallet?.address ?? null} version={version} />
          </div>
        ) : (
          <MintPanel wallet={wallet} onAccount={openAccount} />
        )}

        <footer className="foot muted small">
          ZK passport: <a href="https://github.com/Bitcoindefi/open-stellar-passport" target="_blank" rel="noreferrer">open-stellar-passport</a>{" "}
          (Apache-2.0). Everything runs on Stellar testnet: never use real funds. <a href="/">Back to the site</a> ·{" "}
          <a href="/presentacion">Deck</a> · <a href="/docs">Docs</a>
        </footer>
      </main>
    </div>
  );
}
