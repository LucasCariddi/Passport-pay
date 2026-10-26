import { CONFIG } from "./config";

const D = CONFIG.usdcDecimals;
const SCALE = 10n ** BigInt(D);
const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Base units (7 decimals) to text, e.g. "1.25". */
export function usdc(base: bigint | number | string, maxDecimals = 4): string {
  const v = BigInt(base);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(D, "0").slice(0, maxDecimals).replace(/0+$/, "");
  if (frac.length < 2 && int < 1000n) frac = frac.padEnd(2, "0");
  const intStr = INT.format(int);
  return `${neg ? "-" : ""}${intStr}${frac ? "." + frac : ""}`;
}

/** User text ("0.05", also "0,05") to base units. Throws if it is not a valid amount. */
export function parseUsdc(input: string): bigint {
  const s = input.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) throw new Error("Enter an amount like 0.05");
  const [i, f = ""] = s.split(".");
  if (f.length > D) throw new Error(`Use at most ${D} decimals`);
  return BigInt(i || "0") * SCALE + BigInt(f.padEnd(D, "0") || "0");
}

export const short = (s: string, n = 4) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

/** Ledgers to a readable duration (about 5 s per ledger). */
export function ledgersToText(ledgers: number): string {
  const secs = ledgers * CONFIG.secondsPerLedger;
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))} min`;
  if (secs < 86400 * 2) {
    const h = Math.round((secs / 3600) * 10) / 10;
    return `${h} h`;
  }
  return `${Math.round(secs / 86400)} days`;
}

export const PERIODS = [
  { label: "1 hour", ledgers: 720 },
  { label: "1 day", ledgers: 17_280 },
  { label: "1 week", ledgers: 120_960 },
  { label: "30 days", ledgers: 518_400 },
];

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return WHEN.format(d);
}

/** The passport spend_cap can be huge (U256): shown as "no limit" when it does not fit in i128. */
export const I128_MAX = (1n << 127n) - 1n;
