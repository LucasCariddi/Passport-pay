import { useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { CONFIG, accountLink } from "../lib/config";
import { PERIODS, parseUsdc, short, usdc } from "../lib/format";
import {
  FACTORY_ERRORS,
  VALIDATOR_ERRORS,
  getPassport,
  proveInBrowser,
  registerPassport,
  type Attestation,
  type BrowserProof,
} from "../lib/passport";
import { useTx } from "../lib/useTx";
import type { Wallet } from "../lib/wallet";
import { Card, TxNote } from "./ui";

export function MintPanel({ wallet, onAccount }: { wallet: Wallet | null; onAccount: (id: string) => void }) {
  const viaFactory = Boolean(CONFIG.factoryId);
  const [passportCap, setPassportCap] = useState("50");
  const [agentKey, setAgentKey] = useState("");
  const [cap, setCap] = useState("0.05");
  const [period, setPeriod] = useState(String(PERIODS[1].ledgers));

  const [proving, setProving] = useState<string | null>(null);
  const [proveErr, setProveErr] = useState<string | null>(null);
  const [proof, setProof] = useState<BrowserProof | null>(null);
  const [registered, setRegistered] = useState<{ attestation: Attestation | null; account: string | null } | null>(null);
  const tx = useTx(viaFactory ? FACTORY_ERRORS : VALIDATOR_ERRORS);

  const prove = async () => {
    setProveErr(null);
    setProof(null);
    setRegistered(null);
    tx.reset();
    let capBase: bigint;
    try {
      capBase = parseUsdc(passportCap);
    } catch (e) {
      setProveErr((e as Error).message);
      return;
    }
    try {
      setProving("Starting");
      const p = await proveInBrowser(capBase, setProving);
      setProof(p);
    } catch (e) {
      setProveErr(String((e as Error)?.message ?? e));
    } finally {
      setProving(null);
    }
  };

  const keyOk = StrKey.isValidEd25519PublicKey(agentKey.trim());
  const canRegister = Boolean(wallet && proof && !tx.busy && (!viaFactory || keyOk));

  const register = async () => {
    if (!wallet || !proof) return;
    let capBase = 0n;
    if (viaFactory) {
      try {
        capBase = parseUsdc(cap);
      } catch (e) {
        alert((e as Error).message);
        return;
      }
    }
    const r = await tx.run(async (onPhase) => {
      const res = await registerPassport({
        proof,
        owner: wallet.address,
        agentKey: agentKey.trim(),
        capBase,
        periodLedgers: Number(period),
        sign: wallet.sign,
        onPhase,
      });
      return { hash: res.hash, ledger: res.ledger, value: res, feeStroops: "" };
    });
    if (!r) return;
    const attestation = (await getPassport(proof.agentId).catch(() => undefined)) ?? null;
    setRegistered({ attestation, account: r.account });
  };

  return (
    <Card
      id="mint"
      className="plain"
      kicker="ZK passport"
      title="New passport"
      display
      hint="The proof is generated in this browser. Your secret and your balance never leave it: only the proof goes to the network."
    >
      <div className="steps">
        <div className="step">
          <span className="step-n" aria-hidden="true">1</span>
          <div className="step-body">
            <h3>Generate the proof</h3>
            <label>
              Cap the passport guarantees
              <div className="input-suffix">
                <input inputMode="decimal" autoComplete="off" spellCheck={false} value={passportCap} onChange={(e) => setPassportCap(e.target.value)} name="passportCap" />
                <span>USDC</span>
              </div>
            </label>
            <button type="button" className="btn primary" onClick={prove} disabled={Boolean(proving)} data-testid="prove">
              {proving ? "Generating…" : "Generate proof"}
            </button>
            {proving && (
              <p className="note busy" role="status">
                <span className="spinner" aria-hidden /> {proving}…
              </p>
            )}
            {proveErr && <p className="note err">{proveErr}</p>}
            {proof && (
              <dl className="kv" data-testid="proof" data-agent-id={proof.agentId}>
                <dt>Agent</dt>
                <dd>#{proof.agentId}</dd>
                <dt>Time</dt>
                <dd data-testid="proving-ms">{(proof.provingMs / 1000).toFixed(1)} s in your browser</dd>
                <dt>Local check</dt>
                <dd>{proof.offChainValid ? "The proof verifies" : "It does not verify"}</dd>
                <dt>Proven cap</dt>
                <dd>{usdc(BigInt(proof.spendCap))} USDC</dd>
                <dt>Nullifier</dt>
                <dd className="mono">{short(proof.publicInputs[1], 8)}</dd>
              </dl>
            )}
          </div>
        </div>

        <div className="step">
          <span className="step-n" aria-hidden="true">2</span>
          <div className="step-body">
            <h3>Register it on the network</h3>
            {viaFactory ? (
              <>
                <label>
                  Agent key
                  <input
                    className="mono"
                    placeholder="G… (from passport-agent keygen)"
                    value={agentKey}
                    onChange={(e) => setAgentKey(e.target.value)}
                    name="agentKey"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <div className="grid2 tight">
                  <label>
                    Starting cap
                    <div className="input-suffix">
                      <input inputMode="decimal" autoComplete="off" spellCheck={false} value={cap} onChange={(e) => setCap(e.target.value)} name="initialCap" />
                      <span>USDC</span>
                    </div>
                  </label>
                  <label>
                    Every
                    <select value={period} onChange={(e) => setPeriod(e.target.value)} name="initialPeriod">
                      {PERIODS.map((p) => (
                        <option key={p.ledgers} value={p.ledgers}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="muted small">One transaction verifies the proof and creates the account that will pay.</p>
              </>
            ) : (
              <p className="muted small">
                The account factory is not deployed yet: the passport is registered straight in the validator (verify_and_register) and
                the paying account is created later.
              </p>
            )}
            <button type="button" className="btn primary" onClick={register} disabled={!canRegister} data-testid="register">
              Sign and register
            </button>
            {!wallet && proof && <p className="muted small">Connect your wallet to sign.</p>}
            <TxNote tx={tx} done="Passport registered." />
            {registered && (
              <dl className="kv" data-testid="registered">
                <dt>In the validator</dt>
                <dd>{registered.attestation ? `Yes, since ledger ${registered.attestation.ledger}` : "Not visible yet (try again in a few seconds)"}</dd>
                {registered.account && (
                  <>
                    <dt>Account</dt>
                    <dd>
                      <a href={accountLink(registered.account)} target="_blank" rel="noreferrer" className="mono">
                        {short(registered.account, 6)}
                      </a>{" "}
                      <button type="button" className="btn ghost sm" onClick={() => onAccount(registered.account!)}>
                        Open
                      </button>
                    </dd>
                  </>
                )}
              </dl>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
