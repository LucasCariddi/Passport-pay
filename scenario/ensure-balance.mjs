// ensure-balance.mjs <requiredUsdc> - makes sure the PassportAccount has enough USDC balance
// so the agent's attempted payment actually reaches __check_auth on the ledger (and is
// rejected there), instead of failing earlier for lack of balance. If the balance is below
// the requirement, it deposits the difference FROM THE OWNER (agent CLI `fund`). Idempotent.
// Deposits do not change the spending cap; they only make the onchain rejection the clean,
// visible path. No secrets are printed.
import { spawnSync } from "node:child_process";
import { loadConfig } from "../mcp/src/config.mjs";
import { createPassportPay } from "../mcp/src/core.mjs";

const required = Number(process.argv[2] || "5");
const cfg = loadConfig();
const pp = createPassportPay(cfg);
const st = await pp.spendStatus();
const bal = Number(st.balanceUsdc);
console.log(`balance of ${cfg.accountId}: ${bal} USDC (needed so the attempt reaches the network: ${required})`);
if (bal >= required) {
  console.log("balance is enough; no deposit needed.");
  process.exit(0);
}
const delta = Math.max(1, Math.ceil(required - bal + 1));
console.log(`the owner deposits ${delta} USDC to reach it (the cap does not change)...`);
const r = spawnSync("node", ["agent/src/cli.mjs", "fund", "--usdc", String(delta), "--account", cfg.accountId], { stdio: "inherit" });
process.exit(r.status ?? 0);
