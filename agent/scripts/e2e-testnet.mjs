#!/usr/bin/env node
// E2E REAL en stellar:testnet: levanta el servidor, corre la CLI del agente como proceso
// aparte y verifica cada resultado. Gasta USDC de testnet de la PassportAccount (~0.04 por
// corrida) y XLM del dueño y del agente (fees). Al final deja el tope como estaba.
//
//   node agent/scripts/e2e-testnet.mjs            (lee .env y deploy/ de la raíz)
//   node agent/scripts/e2e-testnet.mjs --skip-revoke --skip-concurrent
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as OfficialClientScheme } from "@x402/stellar/exact/client";
import { loadAgentConfig, ROOT } from "../src/config.mjs";
import { baseToUsdc, createOnchain } from "../src/onchain.mjs";

const run = promisify(execFile);
const args = new Set(process.argv.slice(2));
const CLI = path.join(ROOT, "agent", "src", "cli.mjs");
const cfg = loadAgentConfig();
const oc = createOnchain({ rpcUrl: cfg.rpcUrl });
const evidence = [];
const failures = [];

function check(cond, label, extra = "") {
  console.log(`${cond ? "  PASA " : "  FALLA"} ${label}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures.push(label);
  return cond;
}
const note = (label, hash) => {
  if (hash) evidence.push({ label, hash, link: `https://stellar.expert/explorer/testnet/tx/${hash}` });
};

async function freePort() {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
}

async function cli(...a) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...a, "--json", "--server", SERVER], { cwd: ROOT, maxBuffer: 1 << 24, timeout: 240_000 });
    return { code: 0, ...JSON.parse(stdout) };
  } catch (e) {
    if (e.stdout) {
      try {
        return { code: e.code, ...JSON.parse(e.stdout) };
      } catch {
        // no era JSON
      }
    }
    return { code: e.code ?? 1, error: String(e.stderr || e.message).trim() };
  }
}

const status = () => oc.read(cfg.accountId, "spend_status");
const config = () => oc.read(cfg.accountId, "config");

// --- servidor ---------------------------------------------------------------
const PORT = await freePort();
const SERVER = `http://127.0.0.1:${PORT}`;
const srvLog = [];
const srv = spawn(process.execPath, [path.join(ROOT, "server", "src", "index.mjs")], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) } });
srv.stdout.on("data", (d) => srvLog.push(...String(d).split("\n").filter(Boolean)));
srv.stderr.on("data", (d) => srvLog.push(...String(d).split("\n").filter(Boolean).map((l) => `stderr: ${l}`)));
for (let i = 0; i < 60; i++) {
  if (await fetch(`${SERVER}/health`).then((r) => r.ok, () => false)) break;
  await new Promise((ok) => setTimeout(ok, 500));
}

let original;
try {
  console.log(`\nservidor ${SERVER}, cuenta ${cfg.accountId}`);
  const cfg0 = await config();
  const st0 = await status();
  original = { cap: BigInt(cfg0.cap), period: cfg0.period_ledgers };
  console.log(`estado inicial: tope del dueño ${baseToUsdc(cfg0.cap)} USDC, gastado ${baseToUsdc(st0.spent)}, disponible ${baseToUsdc(st0.remaining)}, revocada=${cfg0.revoked}`);

  console.log("\n1) el dueño deja exactamente 0.03 USDC disponibles (0.01 insight + 0.02 quote)");
  if (cfg0.revoked) await cli("unrevoke");
  const cap1 = BigInt(st0.spent) + 300_000n;
  let r = await cli("set-cap", "--usdc", baseToUsdc(cap1));
  check(r.tx?.status === "SUCCESS", "set_cap onchain", r.tx?.hash);
  note("set_cap (dueño)", r.tx?.hash);

  console.log("\n2) setup");
  r = await cli("setup");
  check(r.code === 0, "setup sin faltantes", r.checks?.filter((c) => !c.ok).map((c) => c.label).join(", "));

  console.log("\n3) pagos dentro del tope");
  r = await cli("call", "insight", "--param", "topic=fees");
  check(r.calls?.[0]?.outcome === "paid" && /^[0-9a-f]{64}$/.test(r.calls[0].tx ?? ""), "insight pagado (0.01)", r.calls?.[0]?.tx);
  note("pago x402 insight 0.01 USDC", r.calls?.[0]?.tx);
  r = await cli("call", "quote", "--param", "xlm=10");
  check(r.calls?.[0]?.outcome === "paid", "quote pagado (0.02)", r.calls?.[0]?.tx);
  note("pago x402 quote 0.02 USDC", r.calls?.[0]?.tx);
  const st1 = await status();
  check(BigInt(st1.remaining) === 0n, "el contrato registró el gasto: disponible 0", `gastado ${baseToUsdc(st1.spent)}`);

  console.log("\n4) pasarse del tope: lo rechaza el CONTRATO");
  r = await cli("call", "report", "--amount", "0.05");
  check(r.calls?.[0]?.outcome === "rejected_onchain_simulation" && r.calls[0].contractError === "Error(Contract, #6)", "simulación onchain del agente: Error(Contract, #6)");
  r = await cli("call", "report", "--amount", "0.05", "--no-preflight");
  check(r.calls?.[0]?.outcome === "rejected_by_server" && r.calls[0].reason === "cap_exceeded", "sin preflight: 402 cap_exceeded desde la simulación del facilitador");
  r = await cli("call", "report", "--amount", "0.05", "--force-onchain");
  const forced = r.calls?.[0]?.forced;
  check(forced?.status === "FAILED" && forced?.contractError?.code === 6, "tx mandada directo a la red: FAILED con Error(Contract, #6)", forced?.hash);
  note("tx directa por encima del tope: FAILED, Error(Contract, #6)", forced?.hash);

  if (!args.has("--skip-concurrent")) {
    console.log("\n5) dos pagos en paralelo con lugar para uno solo");
    r = await cli("set-cap", "--usdc", baseToUsdc(BigInt((await status()).spent) + 100_000n));
    note("set_cap (dueño)", r.tx?.hash);
    const both = await Promise.all([cli("call", "insight"), cli("call", "insight")]);
    const outs = both.map((b) => b.calls?.[0]?.outcome ?? `error: ${b.error}`);
    const paid = both.filter((b) => b.calls?.[0]?.outcome === "paid");
    const rejected = both.filter((b) => b.calls?.[0] && b.calls[0].outcome !== "paid");
    check(paid.length === 1 && rejected.length === 1, "liquida uno solo", outs.join(" / "));
    check(rejected.every((b) => b.calls[0].reason === "cap_exceeded" || b.calls[0].contractError === "Error(Contract, #6)"), "el perdedor recibe cap_exceeded limpio (no fetch failed)", rejected.map((b) => b.calls[0].reason ?? b.calls[0].contractError).join(""));
    note("pago x402 en carrera (el ganador)", paid[0]?.calls?.[0]?.tx);
  }

  if (!args.has("--skip-revoke")) {
    console.log("\n6) revocación del dueño");
    r = await cli("set-cap", "--usdc", baseToUsdc(BigInt((await status()).spent) + 1_000_000n));
    r = await cli("revoke");
    check(r.tx?.status === "SUCCESS", "revoke onchain", r.tx?.hash);
    note("revoke (dueño)", r.tx?.hash);
    r = await cli("call", "insight");
    check(r.calls?.[0]?.contractError === "Error(Contract, #1)", "cuenta revocada: Error(Contract, #1) en la simulación onchain");
    r = await cli("call", "insight", "--no-preflight");
    check(r.calls?.[0]?.reason === "revoked", "sin preflight: 402 revoked");
    r = await cli("unrevoke");
    check(r.tx?.status === "SUCCESS", "set_agent_key (des-revoca)", r.tx?.hash);
    note("set_agent_key (dueño)", r.tx?.hash);
  }

  console.log("\n7) admisión: una cuenta G con USDC no puede pagar");
  if (process.env.PAYER_SECRET) {
    const signer = createEd25519Signer(process.env.PAYER_SECRET, cfg.network);
    const fetchPay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: cfg.network, client: new OfficialClientScheme(signer) }] });
    const res = await fetchPay(`${SERVER}/api/premium/insight`);
    const why = res.headers.get("payment-required") ? decodePaymentRequiredHeader(res.headers.get("payment-required")).error : "";
    check(res.status === 402 && why === "payer_not_passport_account", "pagador G rechazado: payer_not_passport_account", `HTTP ${res.status} ${why}`);
  } else {
    console.log("  (sin PAYER_SECRET, salteado)");
  }

  console.log("\n8) el dueño deposita USDC");
  r = await cli("fund", "--usdc", "0.05");
  check(r.tx?.status === "SUCCESS", "depósito de 0.05 USDC", r.tx?.hash);
  note("depósito del dueño 0.05 USDC", r.tx?.hash);

  console.log("\n9) historial de pagos (eventos transfer de la SAC vía /api/payments)");
  r = await cli("payments", "--n", "10");
  const hashes = new Set((r.payments ?? []).map((p) => p.tx));
  const paidHashes = evidence.filter((e) => e.label.startsWith("pago x402")).map((e) => e.hash);
  check(paidHashes.every((h) => hashes.has(h)), "los pagos de esta corrida aparecen en /api/payments", `${paidHashes.filter((h) => hashes.has(h)).length}/${paidHashes.length}`);
  const recent = await fetch(`${SERVER}/api/payments/recent`).then((x) => x.json());
  check(recent.some((x) => x.kind === "rejected" && x.contractError === "Error(Contract, #6)"), "/api/payments/recent registra el rechazo del contrato");
} catch (e) {
  failures.push(`excepción: ${e.message}`);
  console.error(e);
} finally {
  if (original) {
    const r = await cli("set-cap", "--usdc", baseToUsdc(original.cap), "--period", String(original.period));
    console.log(`\ntope restaurado a ${baseToUsdc(original.cap)} USDC: ${r.tx?.status ?? r.error}`);
  }
  srv.kill();
}

console.log("\n--- log del servidor (resumen) ---");
for (const l of srvLog.filter((l) => /^\[(settle|verify|admisión)\]/.test(l))) console.log(l);
console.log("\n--- evidencia onchain ---");
for (const e of evidence) console.log(`${e.label}: ${e.hash}\n  ${e.link}`);
console.log(failures.length ? `\nE2E FALLÓ (${failures.length}): ${failures.join("; ")}` : "\nE2E OK");
process.exit(failures.length ? 1 : 0);
