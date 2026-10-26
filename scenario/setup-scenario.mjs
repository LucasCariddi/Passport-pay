// setup-scenario.mjs - idempotent testnet setup for the prompt-injection scenario.
//
// Two one-time steps so the demo isolates the REAL defense (the on-chain allowlist):
//   1) Fund the agent fee-payer account with XLM (friendbot) so the `pay` tool can
//      submit transactions and pay the network fee.
//   2) Give the ATTACKER account a USDC trustline, so a payment to it REACHES
//      __check_auth and is rejected there (PayeeNotAllowed), instead of failing one
//      step earlier for a missing trustline. The attacker never receives any USDC:
//      the contract rejects the transfer. This just removes an incidental obstacle so
//      the evidence points at the contract check, where the defense actually lives.
//
// Secrets are read only from local files and used to sign locally. No secret is ever
// printed or sent anywhere: only the signed transaction goes to Horizon.
import { readFileSync } from "node:fs";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const ROOT = new URL("..", import.meta.url);
const HORIZON_URL = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const horizon = new Horizon.Server(HORIZON_URL);

const payees = JSON.parse(readFileSync(new URL("deploy/demo-payees.json", ROOT), "utf8"));
const agentPublic = payees.agentPublic;

function readSecret(file) {
  const raw = readFileSync(new URL(file, ROOT), "utf8").trim();
  if (/^S[A-Z2-7]{55}$/.test(raw)) return raw;
  const j = JSON.parse(raw);
  return j.agentSecret ?? j.secret;
}

async function accountExists(pub) {
  try {
    await horizon.loadAccount(pub);
    return true;
  } catch {
    return false;
  }
}

// 1) fund the agent fee-payer (the tx source for the `pay` tool).
if (await accountExists(agentPublic)) {
  console.log(`agent fee-payer ${agentPublic}: already funded`);
} else {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${agentPublic}`);
  console.log(`agent fee-payer ${agentPublic}: friendbot funded = ${r.ok}`);
}

// 2) attacker USDC trustline.
const attackerKp = Keypair.fromSecret(readSecret(".secrets/attacker.secret"));
const attackerPub = attackerKp.publicKey();
if (!(await accountExists(attackerPub))) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${attackerPub}`);
  console.log(`attacker ${attackerPub}: friendbot funded = ${r.ok}`);
}
const acc = await horizon.loadAccount(attackerPub);
const hasUsdc = acc.balances.some((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
if (hasUsdc) {
  console.log(`attacker ${attackerPub}: USDC trustline already present`);
} else {
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(attackerKp);
  const res = await horizon.submitTransaction(tx);
  console.log(`attacker ${attackerPub}: USDC trustline added, tx=${res.hash}`);
}
console.log("SETUP OK");
