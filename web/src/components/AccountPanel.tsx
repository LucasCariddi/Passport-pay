import { useCallback, useEffect, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import {
  ACCOUNT_ERRORS,
  agentKeyToG,
  deposit,
  getConfig,
  getPayees,
  getSpendStatus,
  getUsdcBalance,
  revoke,
  setAgentKey,
  setCap,
  type AccountConfig,
  type SpendStatus,
} from "../lib/account";
import { accountLink } from "../lib/config";
import { I128_MAX, PERIODS, ledgersToText, parseUsdc, short, usdc } from "../lib/format";
import { getPassport, type Attestation } from "../lib/passport";
import { latestLedger } from "../lib/soroban";
import { useTx } from "../lib/useTx";
import type { Wallet } from "../lib/wallet";
import { Card, Copy, Pill, Stat, TxNote } from "./ui";

interface Snapshot {
  config: AccountConfig;
  status: SpendStatus | null;
  passport: Attestation | null;
  balance: bigint;
  ledger: number;
}

export function AccountPanel({ account, wallet, onChanged }: { account: string; wallet: Wallet | null; onChanged: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const config = await getConfig(account);
      const [status, passport, balance, ledger] = await Promise.all([
        getSpendStatus(account),
        getPassport(config.agent_id).then((p) => p ?? null),
        getUsdcBalance(account),
        latestLedger(),
      ]);
      setSnap({ config, status, passport, balance: BigInt(balance), ledger });
    } catch (e) {
      setSnap(null);
      setLoadErr(`Could not read account ${short(account, 6)}: ${String((e as Error)?.message ?? e)}. Check the ID (it starts with C) and try again.`);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = () => {
    load();
    onChanged();
  };

  if (loadErr)
    return (
      <Card title="Agent account">
        <p className="note err">{loadErr}</p>
      </Card>
    );
  if (!snap)
    return (
      <Card title="Agent account">
        <p className="muted">{loading ? "Reading the account on testnet…" : ""}</p>
      </Card>
    );

  const { config, status, passport, balance, ledger } = snap;
  const isOwner = wallet?.address === config.owner;
  const passportCap = passport ? BigInt(passport.spend_cap) : null;
  const spent = status?.spent ?? 0n;
  const eff = status?.effective_cap ?? 0n;
  const pct = eff > 0n ? Math.min(100, Number((spent * 10000n) / eff) / 100) : spent > 0n ? 100 : 0;
  // If the owner lowers the cap mid-period, what was already spent can sit above the new cap.
  // No payment went over: the cap went down afterwards.
  const overAfterLowering = Boolean(status) && spent > eff;
  const endsIn = status ? Math.max(0, status.period_ends_ledger - ledger) : 0;
  const state = config.revoked ? "revocada" : !passport ? "sin-pasaporte" : "activa";

  return (
    <div className="panel-grid">
      <div className="panel-col">
        <Card
          id="cuenta"
          kicker="Agent account"
          title={`Agent #${config.agent_id.toString()}`}
          aside={
            <span className="badge" data-state={state}>
              <Pill kind={state === "activa" ? "ok" : state === "revocada" ? "bad" : "wait"}>
                {state === "activa" ? "ACTIVE" : state === "revocada" ? "REVOKED" : "NO PASSPORT"}
              </Pill>
            </span>
          }
        >
          <dl className="stats">
            <Stat
              label="Account"
              value={
                <a href={accountLink(account)} target="_blank" rel="noreferrer" className="mono">
                  {short(account, 6)}
                </a>
              }
            />
            <Stat label="Balance" value={<span className="num">{usdc(balance)} USDC</span>} />
            <Stat label="Passport" value={passport ? "Verified onchain" : "Missing"} sub="Groth16 · BN254" />
            <Stat label="Agent key" value={<Copy text={agentKeyToG(config.agent_key)} />} />
          </dl>
          <div className="row-end">
            <button type="button" className="btn ghost sm" onClick={refresh} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </Card>

        <Card
          id="gasto"
          className="visa"
          title="Spend cap"
          aside={<span className="muted small">{status ? `resets in ~${ledgersToText(endsIn || 1)}` : ""}</span>}
        >
          <p className="big-number">
            <span data-testid="spent">{usdc(spent)} USDC</span>{" "}
            <span className="big-sub" data-testid="effective-cap">
              {overAfterLowering ? `current cap ${usdc(eff)} USDC` : `of ${usdc(eff)} USDC`}
            </span>
          </p>
          <div className="meter" role="progressbar" aria-label="Spent this period" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div className={`fill ${pct >= 100 ? "full" : pct >= 75 ? "warn" : ""}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="muted small" data-testid="meter-note">
            {!status
              ? "Without a passport there is no cap to compute: the account cannot pay."
              : overAfterLowering
                ? `The cap was lowered to ${usdc(eff)} USDC after the agent had already spent ${usdc(spent)} USDC this period. No payment went over the cap: none goes through until the period resets (in ~${ledgersToText(endsIn || 1)}).`
                : `${usdc(status.remaining)} USDC left. The period resets in ~${ledgersToText(endsIn || 1)}.`}
          </p>
          <dl className="stats two">
            <Stat label="Your cap" value={`${usdc(config.cap)} USDC`} sub={`every ${ledgersToText(config.period_ledgers)}`} />
            <Stat
              label="Passport cap"
              value={passportCap == null ? "none" : passportCap > I128_MAX ? "no limit" : `${usdc(passportCap)} USDC`}
              sub="proven in ZK"
            />
          </dl>
          <p className="muted small">The smaller of your cap and the passport's cap applies. Enforced by the account contract, not by this page.</p>
        </Card>

        <PayeesCard account={account} />
      </div>

      <div className="panel-col">
        {!wallet ? (
          <p className="callout">Connect the owner's wallet to change the cap, deposit or revoke.</p>
        ) : !isOwner ? (
          <p className="callout">
            The connected wallet ({short(wallet.address, 5)}) is not the owner of this account ({short(config.owner, 5)}). You can look,
            but you cannot change anything.
          </p>
        ) : null}
        <CapForm account={account} config={config} wallet={isOwner ? wallet : null} onDone={refresh} />
        <DepositForm account={account} wallet={isOwner ? wallet : null} onDone={refresh} />
        <AccessForm account={account} config={config} wallet={isOwner ? wallet : null} onDone={refresh} />
      </div>
    </div>
  );
}

/** Read-only list of allowed payees (only accounts created with the payee list have one). */
function PayeesCard({ account }: { account: string }) {
  const [payees, setPayees] = useState<string[] | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getPayees(account)
      .then((p) => alive && setPayees(p))
      .catch((e) => alive && setErr(String((e as Error)?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [account]);
  return (
    <Card id="payees" kicker="Onchain list" title="Allowed payees" hint="The agent can only pay these addresses. Anyone else gets PayeeNotAllowed from the network.">
      {err ? (
        <p className="note err">Could not read the payee list: {err}</p>
      ) : payees === undefined ? (
        <p className="muted small">Reading the payee list…</p>
      ) : payees === null ? (
        <p className="muted small" data-testid="payees-legacy">
          This account was created before the payee list (older contract), so it can pay any address within its cap. New accounts from
          the factory get the list.
        </p>
      ) : payees.length === 0 ? (
        <p className="muted small">No payees yet: every payment is refused until the owner adds one.</p>
      ) : (
        <ul className="payees">
          {payees.map((p) => (
            <li key={p}>
              <a className="mono" href={accountLink(p)} target="_blank" rel="noreferrer">
                {short(p, 8)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CapForm({ account, config, wallet, onDone }: { account: string; config: AccountConfig; wallet: Wallet | null; onDone: () => void }) {
  const [cap, setCapText] = useState(usdc(config.cap, 7));
  const [period, setPeriod] = useState(String(config.period_ledgers));
  const tx = useTx(ACCOUNT_ERRORS);
  const options = PERIODS.some((p) => String(p.ledgers) === String(config.period_ledgers))
    ? PERIODS
    : [{ label: `${ledgersToText(config.period_ledgers)} (current)`, ledgers: config.period_ledgers }, ...PERIODS];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) return;
    let capBase: bigint;
    try {
      capBase = parseUsdc(cap);
    } catch (err) {
      tx.reset();
      alert((err as Error).message);
      return;
    }
    await tx.run((onPhase) =>
      setCap({ account, owner: wallet.address, sign: wallet.sign, capBase, periodLedgers: Number(period), onPhase }),
    );
    onDone();
  };

  return (
    <Card id="tope" kicker="Owner action" title="Set the cap" hint="How much the agent can spend per period. Stored in the contract.">
      <form onSubmit={submit} className="form">
        <div className="grid2 tight">
          <label>
            Maximum amount
            <div className="input-suffix">
              <input inputMode="decimal" autoComplete="off" spellCheck={false} value={cap} onChange={(e) => setCapText(e.target.value)} name="cap" aria-label="Cap in USDC" />
              <span>USDC</span>
            </div>
          </label>
          <label>
            Every
            <select value={period} onChange={(e) => setPeriod(e.target.value)} name="period">
              {options.map((p) => (
                <option key={p.ledgers} value={p.ledgers}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" className="btn primary" disabled={!wallet || tx.busy}>
          Save cap
        </button>
        <TxNote tx={tx} done="Cap saved in the account." />
      </form>
    </Card>
  );
}

function DepositForm({ account, wallet, onDone }: { account: string; wallet: Wallet | null; onDone: () => void }) {
  const [amount, setAmount] = useState("0.10");
  const tx = useTx();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) return;
    let amountBase: bigint;
    try {
      amountBase = parseUsdc(amount);
    } catch (err) {
      alert((err as Error).message);
      return;
    }
    await tx.run((onPhase) => deposit({ account, owner: wallet.address, sign: wallet.sign, amountBase, onPhase }));
    onDone();
  };
  return (
    <Card id="deposito" kicker="Owner action" title="Add funds" hint="Move USDC from your wallet to the agent's account.">
      <form onSubmit={submit} className="form">
        <label>
          Amount
          <div className="input-suffix">
            <input inputMode="decimal" autoComplete="off" spellCheck={false} value={amount} onChange={(e) => setAmount(e.target.value)} name="amount" aria-label="Deposit in USDC" />
            <span>USDC</span>
          </div>
        </label>
        <button type="submit" className="btn primary" disabled={!wallet || tx.busy}>
          Deposit
        </button>
        <TxNote tx={tx} done="Deposit done." />
      </form>
    </Card>
  );
}

function AccessForm({ account, config, wallet, onDone }: { account: string; config: AccountConfig; wallet: Wallet | null; onDone: () => void }) {
  const tx = useTx(ACCOUNT_ERRORS);
  const current = agentKeyToG(config.agent_key);
  const [newKey, setNewKey] = useState("");

  const doRevoke = async () => {
    if (!wallet) return;
    if (!confirm("Revoking stops every payment of this agent right away. Continue?")) return;
    await tx.run((onPhase) => revoke({ account, owner: wallet.address, sign: wallet.sign, onPhase }));
    onDone();
  };
  const doKey = async (key: string) => {
    if (!wallet) return;
    if (!StrKey.isValidEd25519PublicKey(key)) {
      alert("The key has to be a valid G… address (passport-agent keygen prints one).");
      return;
    }
    await tx.run((onPhase) => setAgentKey({ account, owner: wallet.address, sign: wallet.sign, agentKey: key, onPhase }));
    setNewKey("");
    onDone();
  };

  return (
    <section className="card revoke" id="acceso" aria-labelledby="acceso-t">
      <header className="card-head">
        <div className="card-titles">
          <span className="kicker">Owner action</span>
          <h2 id="acceso-t">{config.revoked ? "This agent is revoked" : "Revoke this agent"}</h2>
          <p className="hint">One signature from you and no further payment settles, wherever the agent is running. Funds stay withdrawable.</p>
        </div>
      </header>
      <div className="access">
        {config.revoked ? (
          <button type="button" className="btn primary" disabled={!wallet || tx.busy} onClick={() => doKey(current)}>
            Reactivate with the same key
          </button>
        ) : (
          <button type="button" className="btn danger" disabled={!wallet || tx.busy} onClick={doRevoke}>
            Revoke agent
          </button>
        )}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            doKey(newKey.trim());
          }}
        >
          <input
            placeholder="New agent key (G…)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            aria-label="New agent key"
            name="agentKey"
            autoComplete="off"
            spellCheck={false}
            className="mono"
          />
          <button type="submit" className="btn ghost" disabled={!wallet || tx.busy || !newKey.trim()}>
            Rotate key
          </button>
        </form>
      </div>
      <p className="muted small">Rotating the key also reactivates a revoked account.</p>
      <TxNote tx={tx} done={config.revoked ? "Account revoked." : "Done."} />
    </section>
  );
}
