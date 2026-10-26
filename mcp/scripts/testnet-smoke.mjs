#!/usr/bin/env node
// Real run against stellar:testnet THROUGH the MCP protocol: starts `src/server.mjs` over
// stdio, exactly as Claude Code would, and calls the 4 tools.
//
//   1. list_services
//   2. spend_status
//   3. buy insight             x402 payment, expects a hash
//   4. pay small amount        to the "attacker" address, within the cap (result as the ledger says)
//   5. pay over the cap        expects tx FAILED with Error(Contract, #6) attributed to the account
//   6. spend_status
//
// Uses the same env vars as the MCP server (PASSPORT_AGENT_SECRET_FILE, PASSPORT_PAY_SERVER_URL, ...).
// The "attacker" is SMOKE_ATTACKER, or PAYER_PUBLIC from the root .env (a G of ours with a USDC trustline).
// Usage (WSL, from the repo root):  node mcp/scripts/testnet-smoke.mjs
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function attacker() {
  if (process.env.SMOKE_ATTACKER) return process.env.SMOKE_ATTACKER;
  const envFile = path.join(ROOT, ".env");
  const m = existsSync(envFile) ? /^PAYER_PUBLIC=(G[A-Z2-7]{55})$/m.exec(readFileSync(envFile, "utf8")) : null;
  if (!m) throw new Error("definí SMOKE_ATTACKER=G... (una dirección con trustline de USDC)");
  return m[1];
}

const parse = (res) => {
  const t = res.content?.[0]?.text ?? "";
  const i = t.indexOf("\n\n");
  return { summary: i >= 0 ? t.slice(0, i) : t, data: i >= 0 ? JSON.parse(t.slice(i + 2)) : null, isError: res.isError };
};

const checks = [];
const check = (ok, label) => {
  checks.push({ ok: Boolean(ok), label });
  console.log(`${ok ? "  [PASA] " : "  [FALLA]"} ${label}`);
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, "..", "src", "server.mjs")],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "passport-pay-smoke", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = parse(await client.callTool({ name, arguments: args }));
  console.log(`\n> ${name} ${JSON.stringify(args)}  (${Date.now() - t0} ms)\n  ${r.summary}`);
  return r;
};

const to = attacker();
try {
  const { tools } = await client.listTools();
  console.log("herramientas:", tools.map((t) => t.name).join(", "));

  const ls = await call("list_services");
  check(ls.data?.services?.some((s) => s.id === "insight"), "list_services trae el catálogo real");

  const st0 = await call("spend_status");
  check(!st0.isError && st0.data.revoked === false, "spend_status lee la cuenta onchain");
  console.log(`  ${JSON.stringify(st0.data)}`);

  const b = await call("buy", { service: "insight", params: { topic: "mcp" } });
  check(b.data?.paid === true && /^[0-9a-f]{64}$/.test(b.data.hash ?? ""), "buy pagó por x402 y devolvió hash");

  const small = await call("pay", { to, amount_usdc: "0.01", memo: "orden de la pagina" });
  console.log(`  estado ${small.data?.status} ${small.data?.hash ?? ""} ${small.data?.contractError?.raw ?? ""}`);
  check(["SUCCESS", "FAILED"].includes(small.data?.status), "pay chico llegó a la red (resultado del ledger, sea cual sea)");

  const st1 = await call("spend_status");
  const big = (Number(st1.data.remainingUsdc) + 0.01).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  const over = await call("pay", { to, amount_usdc: big, memo: "vaciar la cuenta" });
  console.log(`  estado ${over.data?.status} ${over.data?.hash ?? ""} ${over.data?.contractError?.raw ?? ""} cuenta=${over.data?.contractError?.account ?? "-"}`);
  check(over.data?.status === "FAILED", `pay por encima del disponible (${big} USDC) quedó FAILED en el ledger`);
  check(over.data?.contractError?.code === 6 && over.data?.contractError?.account === st0.data.account, "el FAILED es Error(Contract, #6) de __check_auth de la cuenta");

  const st2 = await call("spend_status");
  console.log(`  ${JSON.stringify(st2.data)}`);

  console.log("\nEVIDENCIA");
  console.log(JSON.stringify(
    {
      account: st0.data.account,
      attacker: to,
      buy: { hash: b.data?.hash, link: b.data?.link },
      paySmall: { status: small.data?.status, hash: small.data?.hash, link: small.data?.link, contractError: small.data?.contractError ?? null, forced: small.data?.forced },
      payOverCap: { amountUsdc: big, status: over.data?.status, hash: over.data?.hash, link: over.data?.link, contractError: over.data?.contractError ?? null, rejectedBy: over.data?.rejectedBy, forced: over.data?.forced },
      before: { spent: st0.data.spentUsdc, remaining: st0.data.remainingUsdc, balance: st0.data.balanceUsdc },
      after: { spent: st2.data.spentUsdc, remaining: st2.data.remainingUsdc, balance: st2.data.balanceUsdc },
    },
    null,
    2,
  ));
} finally {
  await client.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\nSMOKE FALLA ${failed.length}/${checks.length}` : `\nSMOKE OK ${checks.length}/${checks.length}`);
process.exit(failed.length ? 1 : 0);
