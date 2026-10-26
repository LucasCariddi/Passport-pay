// "Try as an agent": one click and the server runs the agent's x402 flow with the public demo
// account (server/src/demo.mjs). The server picks the account, never this page.
// Texts are written here in English from the structured result, not copied from the server.
import { useCallback, useEffect, useState } from "react";
import { ACCOUNT_ERROR_NAMES } from "../lib/account";
import { CONFIG, accountLink, txLink } from "../lib/config";
import { EVIDENCE, shortTx } from "../lib/evidence";
import { short } from "../lib/format";
import { Pill, Stamp } from "./ui";
import "./agent-demo.css";

type Spend = {
  capUsdc: string;
  spentUsdc: string;
  remainingUsdc: string;
  minutesToReset: number;
};
type Status = { enabled: boolean; account?: string; agentId?: string; spend?: Spend; balanceUsdc?: string | null; message?: string; error?: string };
type Challenge = { x402Version: number; scheme: string; network: string; amountUsdc: string; payTo: string; asset: string; maxTimeoutSeconds: number };
type ContractError = { code: number; raw: string; name: string; account?: string; stage?: string };
type DemoResult = {
  action: "pay" | "over-cap";
  path: string;
  askedUsdc: string;
  account: string;
  agentPublic: string;
  challenge: Challenge | null;
  outcome: string;
  status?: number;
  tx?: string;
  link?: string;
  response?: unknown;
  contractError?: ContractError | null;
  attributedTo?: string | null;
  rejectedBy?: string;
  reason?: string;
  forced?: { hash?: string; status: string; link?: string; contractError?: ContractError | null; error?: string };
  before?: Spend;
  after?: Spend | null;
};
type Failure = { message: string; retryAfterSec?: number };

const api = () => CONFIG.apiUrl;

/** English text for an error answer of /api/demo/*, by its machine-readable code. */
function failureText(code: string | undefined, status: number, retry?: number): string {
  switch (code) {
    case "rate_limited":
      return `You ran many tests in a row. Try again in ${retry ?? 60} s.`;
    case "busy":
      return "Another demo payment is in progress. Try again in a few seconds.";
    case "slow_network":
      return "Testnet is slower than usual. The payment may have gone through anyway: check the account's payments in a few seconds.";
    case "demo_not_configured":
      return "The demo is not configured on this server.";
    case "demo_account_wasm":
      return "The demo account does not run the updated contract, so the demo is off.";
    case "upstream":
      return "Could not read the account on testnet. Try again in a few seconds.";
    case "demo_failed":
      return "Something failed while talking to testnet. Try again in a few seconds.";
    default:
      return `The server answered HTTP ${status}. Try again in a few seconds.`;
  }
}

/** English summary of a demo result (same cases as server/src/demo.mjs). */
function resultText(r: DemoResult): string {
  const left = r.before ? `${r.before.remainingUsdc} of ${r.before.capUsdc} USDC` : null;
  if (r.outcome === "paid") return `Paid ${r.askedUsdc} USDC from the agent's account.`;
  if (r.outcome === "rejected_onchain_simulation") {
    const code = r.contractError?.code;
    if (code === 6)
      return r.action === "over-cap"
        ? `The account contract refused the payment: it asked for ${r.askedUsdc} USDC and this period has ${left ?? "less"} left.`
        : `This period's cap is used up${left ? `: ${left} left` : ""}, and the call costs ${r.askedUsdc} USDC. It opens again in ${r.before?.minutesToReset ?? "a few"} min.`;
    if (code === 1) return "The owner revoked this account: the contract refuses every payment.";
    if (code === 10) return "The payee is not on the owner's list: the contract refuses the payment.";
    return `The contract refused the payment${code != null ? ` (error #${code} ${ACCOUNT_ERROR_NAMES[code] ?? ""})` : ""}.`;
  }
  if (r.outcome === "rejected_by_server")
    return r.reason === "cap_exceeded"
      ? `This period's cap is used up. It opens again in ${r.before?.minutesToReset ?? "a few"} min.`
      : `The server did not accept the payment (${r.reason ?? "unknown reason"}).`;
  return `Unexpected answer from the server${r.status ? ` (HTTP ${r.status})` : ""}.`;
}

/** Short English summary of what the paid API returned. */
function summary(body: unknown): string {
  if (!body || typeof body !== "object") return String(body ?? "");
  const b = body as Record<string, unknown>;
  const n = b.network as { latestLedger?: number; protocolVersion?: number; sorobanInclusionFee?: { p50?: string; p90?: string } } | undefined;
  if (n?.latestLedger) {
    const f = n.sorobanInclusionFee;
    return `Ledger ${n.latestLedger}, protocol ${n.protocolVersion}. Soroban inclusion fee p50 ${f?.p50} and p90 ${f?.p90} stroops; suggested fee ${String(b.suggestedInclusionFeeStroops ?? f?.p50)} stroops.`;
  }
  if (typeof b.pair === "string") return `${b.pair} on ${String(b.venue ?? "the DEX")}: bid ${b.bestBid}, ask ${b.bestAsk}.`;
  return JSON.stringify(body).slice(0, 240);
}

const contractName = (e?: ContractError | null) => (e ? e.name || ACCOUNT_ERROR_NAMES[e.code] || `Error${e.code}` : null);

export function AgentDemoPanel({ onPaid, onAccount }: { onPaid?: () => void; onAccount?: (account: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<null | "pay" | "over-cap">(null);
  const [pay, setPay] = useState<DemoResult | null>(null);
  const [over, setOver] = useState<DemoResult | null>(null);
  const [fail, setFail] = useState<Failure | null>(null);
  const [force, setForce] = useState(true);

  const loadStatus = useCallback(async () => {
    if (!api()) return setStatus({ enabled: false, message: "This build of the app has no server configured." });
    try {
      const r = await fetch(`${api()}/api/demo/status`);
      const j = (await r.json()) as Status;
      setStatus(j.enabled ? j : { ...j, message: j.error ? failureText(j.error, r.status) : "The demo is not available right now." });
    } catch {
      setStatus({ enabled: false, message: "Could not reach the server. Reload the page in a few seconds." });
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // The server picks the demo account: let the page show that same account's payments.
  const demoAccount = status?.account;
  useEffect(() => {
    if (demoAccount) onAccount?.(demoAccount);
  }, [demoAccount, onAccount]);

  const run =async (action: "pay" | "over-cap") => {
    setBusy(action);
    setFail(null);
    try {
      const r = await fetch(`${api()}/api/demo/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "pay" ? { action, endpoint: "insight" } : { action, force }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFail({ message: failureText(j.error, r.status, j.retryAfterSec), retryAfterSec: j.retryAfterSec });
        return;
      }
      if (action === "pay") setPay(j);
      else setOver(j);
      if (j.after) setStatus((s) => (s ? { ...s, spend: j.after } : s));
      onPaid?.();
    } catch {
      setFail({ message: "Could not reach the server. Try again in a few seconds." });
    } finally {
      setBusy(null);
      loadStatus();
    }
  };

  const spend = status?.spend;
  const exhausted = spend ? Number(spend.remainingUsdc) < 0.01 : false;
  const overErr = over?.forced?.contractError ?? over?.contractError ?? null;
  const overTx = over?.forced?.hash ?? null;

  return (
    <section id="try" className="card lg try" aria-labelledby="try-t">
      <header className="card-head">
        <div className="card-titles">
          <span className="kicker">x402 on Stellar testnet</span>
          <h2 id="try-t" className="display">Try as an agent</h2>
          <p className="hint">
            A test agent pays for a call from its own smart account, with a real ZK passport and a spend cap the contract enforces.
            Everything happens on Stellar testnet, with transactions you can open in the explorer.
          </p>
        </div>
        <span className="muted small head-aside">Up to 10 requests per minute per visitor</span>
      </header>

      {status && !status.enabled && (
        <p className="note err" data-testid="demo-off">
          {status.message ?? "The demo is not available right now."}
        </p>
      )}

      {spend && (
        <div className="demo-meter" data-testid="demo-status">
          <span className="demo-field">
            <span className="field-l">Agent account</span>{" "}
            <a href={accountLink(status!.account!)} target="_blank" rel="noreferrer" className="mono">
              {short(status!.account!, 5)}
            </a>
          </span>
          <span className="demo-field">
            <span className="field-l">Spent this period</span> <strong data-testid="demo-spent">{spend.spentUsdc}</strong> of {spend.capUsdc} USDC
          </span>
          <span className="demo-field">
            <span className="field-l">Cap period</span>{" "}
            {exhausted ? `The cap is used up: it opens again in ${spend.minutesToReset} min.` : `Resets in ${spend.minutesToReset} min.`}
          </span>
        </div>
      )}

      <ol className="try-steps">
        <li className="try-step">
          <span className="try-n" aria-hidden="true">1</span>
          <span className="try-title">Ask without paying</span>
          {pay?.challenge ? <Pill kind="ok">HTTP 402</Pill> : <Pill kind="neutral">HTTP 402 expected</Pill>}
          <span className={pay?.challenge ? "try-detail mono" : "try-detail"}>
            {pay?.challenge
              ? `${pay.challenge.scheme} · ${pay.challenge.network} · ${pay.challenge.amountUsdc} USDC`
              : "The API answers 402 with the price, the asset and who to pay."}
          </span>
        </li>
        <li className="try-step">
          <span className="try-n" aria-hidden="true">2</span>
          <span className="try-title">Pay over x402</span>
          {pay ? (
            pay.outcome === "paid" ? <Pill kind="ok">SUCCESS</Pill> : <Pill kind="bad">REFUSED</Pill>
          ) : (
            <Pill kind="ok">SUCCESS · last run</Pill>
          )}
          <span className="try-detail mono">
            {pay?.tx ? (
              <a href={txLink(pay.tx)} target="_blank" rel="noreferrer">
                tx {shortTx(pay.tx)}
              </a>
            ) : pay ? (
              "No transaction"
            ) : (
              <a href={txLink(EVIDENCE.paid.tx)} target="_blank" rel="noreferrer">
                tx {shortTx(EVIDENCE.paid.tx)}
              </a>
            )}
          </span>
        </li>
        <li className="try-step">
          <span className="try-n" aria-hidden="true">3</span>
          <span className="try-title">Exceed the cap</span>
          {over ? (
            over.outcome === "paid" ? <Pill kind="ok">PAID: room left</Pill> : <Pill kind="bad">FAILED · {contractName(overErr) ?? "refused"}</Pill>
          ) : (
            <Pill kind="bad">FAILED · CapExceeded · last run</Pill>
          )}
          <span className="try-detail mono">
            {overTx ? (
              <a href={txLink(overTx)} target="_blank" rel="noreferrer">
                tx {shortTx(overTx)}
              </a>
            ) : over ? (
              "Refused at simulation, nothing sent"
            ) : (
              <a href={txLink(EVIDENCE.capExceeded.tx)} target="_blank" rel="noreferrer">
                tx {shortTx(EVIDENCE.capExceeded.tx)}
              </a>
            )}
          </span>
        </li>
      </ol>

      <div className="try-actions">
        <button type="button" className="btn primary round" onClick={() => run("pay")} disabled={!status?.enabled || busy !== null} data-testid="demo-pay">
          {busy === "pay" ? "The agent is paying…" : "Pay 0.01 USDC and get data"}
        </button>
        <button type="button" className="btn ghost round" onClick={() => run("over-cap")} disabled={!status?.enabled || busy !== null} data-testid="demo-over">
          {busy === "over-cap" ? "Trying…" : "Try to exceed the cap"}
        </button>
        <label className="small demo-check">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={busy !== null} name="force" />
          Send the over-cap payment to the network anyway, to see the FAILED transaction in the explorer
        </label>
      </div>

      {busy && (
        <p className="note busy" role="status">
          <span className="spinner" aria-hidden />{" "}
          {busy === "pay" ? "Asking, signing and settling on testnet. It takes about 10 seconds." : `Simulating the payment against the contract${force ? " and sending it to the network" : ""}.`}
        </p>
      )}

      {fail && (
        <p className="note err" role="alert" data-testid="demo-fail">
          {fail.message}
        </p>
      )}

      {pay && (
        <div className="demo-box" data-testid="demo-paid" data-outcome={pay.outcome}>
          {pay.challenge && (
            <div data-testid="demo-402">
              <div className="demo-http">
                <span className="mono">GET {pay.path}</span>
                <span className="demo-code warn">402</span>
              </div>
              <dl className="kv">
                <dt>Price</dt>
                <dd>{pay.challenge.amountUsdc} USDC</dd>
                <dt>Scheme</dt>
                <dd className="mono">
                  x402 v{pay.challenge.x402Version}, {pay.challenge.scheme}, {pay.challenge.network}
                </dd>
                <dt>Pay to</dt>
                <dd className="mono">{short(pay.challenge.payTo, 6)}</dd>
              </dl>
            </div>
          )}
          {pay.outcome === "paid" ? (
            <>
              <div className="demo-http">
                <span className="mono">GET {pay.path} + signature</span>
                <span className="demo-code ok">200</span>
              </div>
              <p className="note ok">
                {resultText(pay)}{" "}
                {pay.tx && (
                  <a href={txLink(pay.tx)} target="_blank" rel="noreferrer" data-testid="demo-tx">
                    View transaction {short(pay.tx, 6)}
                  </a>
                )}
              </p>
              <p className="small demo-resp">
                <span className="muted">What the agent bought:</span> {summary(pay.response)}
              </p>
            </>
          ) : (
            <p className="note err" data-testid="demo-pay-rejected">
              {resultText(pay)}
              {pay.contractError && <span className="mono"> ({pay.contractError.raw} {contractName(pay.contractError)})</span>}
            </p>
          )}
        </div>
      )}

      {over && (
        <div className="demo-box over" data-testid="demo-overcap" data-outcome={over.outcome}>
          <div className="demo-http">
            <span className="mono">GET {over.path}</span>
            <span className="demo-code warn">{over.askedUsdc} USDC</span>
          </div>
          {over.outcome === "paid" ? (
            <p className="note ok">
              It went through: there was still room under the cap.{" "}
              {over.tx && (
                <a href={txLink(over.tx)} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              )}
            </p>
          ) : (
            <div className="over-result">
              {overErr && <Stamp error={contractName(overErr) ?? "Refused"} code={overErr.code} tx={overTx} size="sm" testid="demo-stamp" />}
              <div className="over-text">
                <p className="note err" data-testid="demo-reject-msg">
                  {resultText(over)}
                </p>
                {over.contractError && (
                  <dl className="kv">
                    <dt>Contract error</dt>
                    <dd className="mono" data-testid="demo-contract-error">
                      {over.contractError.raw} {contractName(over.contractError)}
                    </dd>
                    <dt>Returned by</dt>
                    <dd>
                      {over.attributedTo ? (
                        <>
                          the agent's account{" "}
                          <a className="mono" href={accountLink(over.attributedTo)} target="_blank" rel="noreferrer">
                            {short(over.attributedTo, 5)}
                          </a>{" "}
                          while checking the signature
                        </>
                      ) : over.rejectedBy === "server" ? (
                        "the facilitator's simulation"
                      ) : (
                        "the contract's simulation"
                      )}
                    </dd>
                  </dl>
                )}
                {over.forced && (
                  <p className={`note ${over.forced.status === "FAILED" ? "busy" : "err"}`} data-testid="demo-forced" data-status={over.forced.status}>
                    {over.forced.status === "FAILED" ? (
                      <>
                        Sent to the network anyway: the transaction is <strong>FAILED</strong> on the ledger
                        {over.forced.contractError ? ` with ${over.forced.contractError.raw} ${contractName(over.forced.contractError)}` : ""}.{" "}
                        {over.forced.hash && (
                          <a href={txLink(over.forced.hash)} target="_blank" rel="noreferrer" data-testid="demo-forced-tx">
                            View transaction {short(over.forced.hash, 6)}
                          </a>
                        )}
                      </>
                    ) : (
                      <>Could not send it to the network ({over.forced.error ?? over.forced.status}).</>
                    )}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {(pay?.tx || over?.forced?.hash) && (
        <p className="muted small">
          Every payment in this demo is real on testnet. If the payments list does not show it yet, wait a few seconds.{" "}
          {pay?.tx && (
            <a href={txLink(pay.tx)} target="_blank" rel="noreferrer">
              Last payment
            </a>
          )}
        </p>
      )}
    </section>
  );
}
