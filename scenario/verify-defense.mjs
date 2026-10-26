// verify-defense.mjs - direct onchain checks of the defense, NOT the LLM agent.
//
// These isolate WHY the attacker fails, using the same real MCP pay tool (mcp/src/core.mjs):
//   1) attacker, amount WITHIN the cap -> expected FAILED, PayeeNotAllowed (#10).
//      This is the key proof: it is the payee list, not the spending cap, that stops the
//      attacker. A cap alone would let a small payment through; here it is rejected because
//      the destination is not on the account's payee list.
//   2) merchant (allowed), small amount -> expected SUCCESS, only if the period still has room.
//      Control showing the account is not simply broken. It consumes 0.005 USDC of the cap
//      (a FAILED attacker tx consumes nothing).
//
// No secrets are printed.
import { loadConfig } from "../mcp/src/config.mjs";
import { createPassportPay } from "../mcp/src/core.mjs";

const ATTACKER = process.env.ATTACKER || "GCCZXNV7U6MY6APDCWFXLAUTUOB63N6LTXZEMJ2Y4JJUJVGFEXQ7SNIN";
const MERCHANT = process.env.MERCHANT || "GCLNNJKDE7YK5BYOCIW3SOZW7NBPBCKPKXONLRYVUQRO5VZCGLVCVPPJ";

const cfg = loadConfig();
const pp = createPassportPay(cfg);

function show(label, r) {
  const ce = r.contractError ? ` ${r.contractError.raw}` : "";
  console.log(`  ${label}: ${r.status}${ce}${r.hash ? `  tx ${r.hash}` : ""}`);
  if (r.link) console.log(`     ${r.link}`);
  if (r.status === "FAILED") {
    const by = r.contractError?.account === cfg.accountId ? `__check_auth of PassportAccount ${cfg.accountId}` : "not attributed to the account";
    console.log(`     rejected by: ${by}`);
  }
  return r;
}

console.log("== DIRECT CHECK OF THE CONTRACT (not the LLM agent) ==");
console.log(`account: ${cfg.accountId}`);
const st = await pp.spendStatus();
console.log(`onchain state: cap ${st.capUsdc} USDC, spent ${st.spentUsdc}, left ${st.remainingUsdc}, revoked=${st.revoked}`);
console.log(`allowed payees: ${MERCHANT} (the only one)`);

console.log("\n[1] small payment TO THE ATTACKER, inside the cap (expected: FAILED Error(Contract, #10) PayeeNotAllowed):");
const a = show("attacker 0.005 USDC", await pp.pay({ to: ATTACKER, amount_usdc: "0.005" }));
const ok1 = a.status === "FAILED" && a.contractError?.code === 10 && a.contractError?.account === cfg.accountId;
console.log(`    -> ${ok1 ? "OK: the contract blocks the attacker even though the amount fits in the cap (the payee list, not the cap)." : "UNEXPECTED: check it."}`);

console.log("\n[2] small payment to the allowed MERCHANT (expected: SUCCESS):");
if (Number(st.remainingUsdc) >= 0.005) {
  const m = show("merchant 0.005 USDC", await pp.pay({ to: MERCHANT, amount_usdc: "0.005" }));
  const ok2 = m.status === "SUCCESS";
  console.log(`    -> ${ok2 ? "OK: the account pays an allowed destination as usual. It used 0.005 of the cap." : "UNEXPECTED: check it."}`);
} else {
  console.log(`  skipped: the cap for this period is used up (${st.remainingUsdc} USDC left); a payment now would fail with #6 CapExceeded, not because of the payee list.`);
  console.log(`  The SUCCESS control to an allowed destination was shown in an earlier run (see scenario/README.md).`);
}
console.log("\n== END OF CHECK ==");
