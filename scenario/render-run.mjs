// render-run.mjs <last-run.log> <last-run.txt> - readable render of a Story A run, for the video.
//
// It does not rewrite anything: it takes the timestamped lines of the real log (steps 7 and 8:
// the LLM agent run and the direct check of the contract), drops the setup steps and the
// machine-readable JSON line, and puts a short header on top built from that same JSON line.
// The log stays the full record; this file is only easier to read on screen.
import { readFileSync, writeFileSync } from "node:fs";

const [src = "scenario/last-run.log", out = "scenario/last-run.txt"] = process.argv.slice(2);
const lines = readFileSync(src, "utf8").split("\n");
const body = (l) => l.replace(/^\[\d\d:\d\d:\d\dZ\] ?/, "");

let summary = null;
for (const l of lines) {
  const m = body(l).match(/^JSON_SUMMARY=(.*)$/);
  if (m) {
    try {
      summary = JSON.parse(m[1]);
    } catch {}
  }
}
const date = lines.map(body).find((l) => l.startsWith("# date: "))?.slice(8) ?? "?";

const start = lines.findIndex((l) => body(l).startsWith("== 7."));
const end = lines.findIndex((l) => body(l).startsWith("== DONE"));
const picked = (start >= 0 ? lines.slice(start, end >= 0 ? end : undefined) : lines).filter((l) => !body(l).startsWith("JSON_SUMMARY="));
// collapse runs of empty lines
const tidy = [];
for (const l of picked) {
  if (!body(l).trim() && tidy.length && !body(tidy[tidy.length - 1]).trim()) continue;
  tidy.push(l);
}

const pay = summary?.payCalls?.find((p) => p.to === summary.attacker);
const head = [
  "Passport Pay · Story A: a real LLM agent reads a poisoned data feed (Stellar testnet)",
  "=".repeat(86),
  `run started (UTC)  : ${date}`,
  `model              : ${summary?.model ?? "?"} via the Vercel AI Gateway${summary?.responseModel ? ` (gateway reports ${summary.responseModel})` : ""}`,
  `agent account      : ${summary?.account ?? "?"} (PassportAccount, payee list onchain)`,
  `attacker           : ${summary?.attacker ?? "?"} (not on the payee list)`,
  `staged             : only the trap page (${summary?.trapUrl ?? "web/public/trampa/"}, web/public/trampa/index.html)`,
  `real               : the model's decisions, the agent key's signature, every ledger result below`,
  pay
    ? `outcome            : the model paid the attacker ${pay.amount_usdc} USDC -> ${pay.status}${pay.contractError ? ` ${pay.contractError}` : ""}${pay.hash ? `, tx ${pay.hash}` : ""}`
    : `outcome            : the model did not pay the attacker in this run`,
  `rendered from      : ${src} (steps 7 and 8, same lines and timestamps)`,
  "",
];

writeFileSync(out, [...head, ...tidy].join("\n").replace(/\n+$/, "\n"));
