#!/usr/bin/env node
// Demo de punta a punta de Passport Pay en stellar:testnet (todo real, con hashes y links).
//
//   1. El dueño registra un pasaporte ZK nuevo (prueba Groth16 + PassportFactory.register,
//      firmado por pp-owner) o reutiliza el último, deposita USDC y fija el tope.
//   2. El agente llama al endpoint pago, recibe 402, paga por x402 y obtiene la respuesta.
//   3. El agente repite hasta agotar el tope: el siguiente pago lo rechaza el CONTRATO
//      (simulación con Error(Contract, #6)) y, mandado igual a la red, queda FAILED.
//   4. El dueño revoca: el próximo pago falla con Error(Contract, #1), también onchain.
//
// Uso (desde la raíz, en WSL):
//   bash scripts/demo.sh             registra un pasaporte nuevo (~0.02 XLM + 0.05 USDC del dueño)
//   bash scripts/demo.sh --reuse     reutiliza la cuenta de la corrida anterior
//   bash scripts/demo.sh --cap 0.03  tope por período en USDC (default 0.03 = 3 pagos de insight)
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { Keypair } from "@stellar/stellar-sdk";
import { loadAgentConfig, ROOT } from "../agent/src/config.mjs";
import { addr, baseToUsdc, createOnchain, usdcToBase } from "../agent/src/onchain.mjs";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const CAP_USDC = opt("--cap", "0.03");
const LAST = path.join(ROOT, ".secrets", "demo-last.json"); // ignorado por git
const CLI = path.join(ROOT, "agent", "src", "cli.mjs");
const EXPLORER = "https://stellar.expert/explorer/testnet";

const cfg = loadAgentConfig(); // carga .env de la raíz
const oc = createOnchain({ rpcUrl: cfg.rpcUrl });
const evidence = [];
const checks = [];
const t0 = Date.now();

const title = (s) => console.log(`\n${"=".repeat(78)}\n${s}\n${"=".repeat(78)}`);
const step = (s) => console.log(`\n--- ${s}`);
function check(cond, label, extra = "") {
  checks.push({ ok: Boolean(cond), label });
  console.log(`${cond ? "  [PASA] " : "  [FALLA]"} ${label}${extra ? `  ${extra}` : ""}`);
  return cond;
}
function note(label, hash, status = "SUCCESS") {
  if (hash) evidence.push({ label, hash, status, link: `${EXPLORER}/tx/${hash}` });
}

async function freePort() {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
}

let ENV = { ...process.env };
let SERVER;

/** Corre la CLI del agente con --json, imprime su log legible y devuelve el resultado. */
async function cli(...a) {
  let res;
  try {
    const { stdout } = await run(process.execPath, [CLI, ...a, "--json", "--server", SERVER], { cwd: ROOT, env: ENV, maxBuffer: 1 << 24, timeout: 300_000 });
    res = { code: 0, ...JSON.parse(stdout) };
  } catch (e) {
    try {
      res = { code: e.code, ...JSON.parse(e.stdout) };
    } catch {
      res = { code: e.code ?? 1, error: String(e.stderr || e.message).trim() };
    }
  }
  console.log(`  $ passport-agent ${a.join(" ")}`);
  for (const l of res.log ?? []) for (const ll of l.split("\n")) console.log(`    ${ll}`);
  if (res.error) console.log(`    error: ${res.error}`);
  return res;
}

// --- servidor x402 (con facilitador local) en un puerto libre -------------------------
const PORT = await freePort();
SERVER = `http://127.0.0.1:${PORT}`;
const srvLog = [];
const srv = spawn(process.execPath, [path.join(ROOT, "server", "src", "index.mjs")], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) } });
srv.stdout.on("data", (d) => srvLog.push(...String(d).split("\n").filter(Boolean)));
srv.stderr.on("data", (d) => srvLog.push(...String(d).split("\n").filter(Boolean).map((l) => `stderr: ${l}`)));
const stop = () => srv.kill();
process.on("exit", stop);

let exitCode = 1;
try {
  title("Passport Pay: demo de punta a punta en stellar:testnet");
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${SERVER}/health`).then((r) => r.ok, () => false);
    if (!up) await new Promise((ok) => setTimeout(ok, 500));
  }
  if (!check(up, `servidor x402 + facilitador local en ${SERVER}`)) throw new Error(`el servidor no levantó:\n${srvLog.join("\n")}`);
  const health = await fetch(`${SERVER}/api/health`).then((r) => r.json());
  console.log(`  cobra en USDC (SAC ${cfg.asset}) a ${health.payTo}`);
  console.log(`  factory ${cfg.factoryId}  validador OSP ${cfg.validatorId}`);

  // ============ 1) el dueño registra o reutiliza un pasaporte y fija el tope ============
  title("1) El dueño registra un pasaporte ZK y configura el tope");
  let demo;
  if (flag("--reuse") && existsSync(LAST)) {
    demo = JSON.parse(readFileSync(LAST, "utf8"));
    step(`reutilizo el pasaporte #${demo.agentId}, cuenta ${demo.account}`);
  } else {
    step("prueba Groth16 (BN254) + PassportFactory.register: verifica la prueba y despliega la cuenta en la misma tx");
    const reg = await new Promise((ok) => {
      const p = spawn(process.execPath, [path.join(ROOT, "contracts", "scripts", "register-demo.mjs"), "--cap", "500000", "--period", "17280"], { cwd: ROOT });
      let out = "";
      const indent = (s) => String(s).replace(/(^|\n)(?=.)/g, "$1    ");
      p.stdout.on("data", (d) => {
        out += d;
        process.stdout.write(indent(d));
      });
      p.stderr.on("data", (d) => process.stderr.write(indent(d)));
      p.on("close", (code) => ok({ code, out }));
    });
    const m = /REGISTER_RESULT=(\{.*\})/.exec(reg.out);
    if (!check(reg.code === 0 && m, "register onchain (firma real del dueño pp-owner)")) throw new Error("register falló");
    const r = JSON.parse(m[1]);
    demo = { agentId: r.agentId, account: r.account, registerTx: r.tx, secretFile: path.join(ROOT, ".secrets", `demo-agent-${r.agentId}.json`) };
    note(`PassportFactory.register (pasaporte #${r.agentId} + cuenta ${r.account})`, r.tx);
    writeFileSync(LAST, JSON.stringify(demo, null, 2), { mode: 0o600 });
  }
  const secret = JSON.parse(readFileSync(demo.secretFile, "utf8"));
  ENV = { ...process.env, PASSPORT_ACCOUNT_ID: demo.account, AGENT_SECRET: secret.agentSecret, AGENT_ID: String(demo.agentId) };
  const agentPub = Keypair.fromSecret(secret.agentSecret).publicKey();
  console.log(`  cuenta del agente (contrato): ${EXPLORER}/contract/${demo.account}`);
  console.log(`  clave del agente: ${agentPub}`);

  // La G del agente solo paga fees de --force-onchain (los pagos x402 los paga el facilitador).
  const hz = await fetch(`${cfg.horizonUrl}/accounts/${agentPub}`);
  if (hz.status === 404) {
    const fb = await fetch(`https://friendbot.stellar.org?addr=${agentPub}`);
    console.log(`  friendbot para la clave del agente: HTTP ${fb.status}`);
  }

  const cfg0 = await oc.read(demo.account, "config");
  if (cfg0.revoked) {
    step("la cuenta venía revocada de la corrida anterior: el dueño la reactiva");
    const u = await cli("unrevoke");
    check(u.tx?.status === "SUCCESS", "set_agent_key (des-revoca)", u.tx?.hash);
    note("set_agent_key del dueño (reactiva la cuenta)", u.tx?.hash);
  }
  const bal0 = BigInt(await oc.read(cfg.asset, "balance", [addr(demo.account)]));
  if (bal0 < usdcToBase(CAP_USDC) + usdcToBase("0.01")) {
    step("el dueño deposita 0.05 USDC en la cuenta del agente");
    const r = await cli("fund", "--usdc", "0.05");
    check(r.tx?.status === "SUCCESS", "depósito del dueño", r.tx?.hash);
    note("depósito del dueño 0.05 USDC (transfer de la SAC)", r.tx?.hash);
  }
  step(`el dueño fija el tope: ${CAP_USDC} USDC disponibles en el período de 17280 ledgers (~1 día)`);
  const st0 = await oc.read(demo.account, "spend_status");
  const cap = BigInt(st0.spent) + usdcToBase(CAP_USDC);
  let r = await cli("set-cap", "--usdc", baseToUsdc(cap), "--period", "17280");
  check(r.tx?.status === "SUCCESS", "set_cap onchain", r.tx?.hash);
  note(`set_cap del dueño (${baseToUsdc(cap)} USDC por período)`, r.tx?.hash);

  step("setup del agente: cuenta, pasaporte, saldo y admisión del servidor");
  r = await cli("setup");
  check(r.code === 0, "setup sin faltantes (el servidor admite la cuenta vía factory.is_account)");

  // ============ 2) 402 -> pago x402 -> respuesta ============
  title("2) El agente llama al endpoint pago: 402, paga por x402 y recibe la respuesta");
  step("GET sin pago");
  const raw = await fetch(`${SERVER}/api/premium/insight?topic=fees`);
  const pr = raw.headers.get("payment-required");
  const req = pr ? decodePaymentRequiredHeader(pr) : null;
  const acc = req?.accepts?.[0];
  console.log(`  HTTP ${raw.status} ${raw.statusText}`);
  if (acc) console.log(`  PAYMENT-REQUIRED: x402 v${req.x402Version}, ${acc.scheme} en ${acc.network}, ${baseToUsdc(acc.amount)} USDC (asset ${acc.asset}) a ${acc.payTo}`);
  check(raw.status === 402 && acc?.network === "stellar:testnet", "el servidor responde 402 Payment Required con requisitos x402");
  step("el agente paga con su PassportAccount (firma el auth entry; __check_auth corre onchain)");
  r = await cli("call", "insight", "--param", "topic=fees");
  const c1 = r.calls?.[0];
  check(c1?.outcome === "paid" && /^[0-9a-f]{64}$/.test(c1.tx ?? ""), "pago x402 liquidado y respuesta recibida", c1?.tx);
  note("pago x402 #1: insight 0.01 USDC", c1?.tx);

  // ============ 3) repetir hasta agotar el tope ============
  title("3) El agente repite hasta agotar el tope: el siguiente pago lo rechaza el contrato");
  r = await cli("loop", "insight", "--n", "20", "--force-onchain");
  const paid = (r.calls ?? []).filter((c) => c.outcome === "paid");
  paid.forEach((c, i) => note(`pago x402 #${i + 2}: insight 0.01 USDC`, c.tx));
  const last = r.calls?.at(-1);
  check(paid.length >= 1, `pagos dentro del tope en el loop: ${paid.length}`);
  check(last?.outcome === "rejected_onchain_simulation" && last.contractError === "Error(Contract, #6)", "pago por encima del tope: la simulación onchain devuelve Error(Contract, #6) CapExceeded");
  check(
    last?.forced?.status === "FAILED" && last.forced.contractError?.code === 6 && last.forced.contractError?.account === demo.account,
    "la misma tx mandada directo a la red queda FAILED con Error(Contract, #6), devuelto por __check_auth de la cuenta",
    last?.forced?.hash,
  );
  note("pago por encima del tope mandado a la red: FAILED Error(Contract, #6)", last?.forced?.hash, "FAILED");
  const st1 = await oc.read(demo.account, "spend_status");
  check(BigInt(st1.remaining) === 0n, "spend_status onchain: disponible 0", `gastado ${baseToUsdc(st1.spent)} de ${baseToUsdc(st1.effective_cap)}`);
  step("sin preflight del agente: lo rechaza la simulación del facilitador, el servidor devuelve 402");
  r = await cli("call", "insight", "--no-preflight");
  check(r.calls?.[0]?.outcome === "rejected_by_server" && r.calls[0].reason === "cap_exceeded", "402 cap_exceeded (Error(Contract, #6) en la simulación del facilitador)");

  // ============ 4) revocación ============
  title("4) El dueño revoca: el próximo pago falla onchain");
  step("primero el dueño sube el tope, para que el rechazo sea por la revocación y no por el tope");
  r = await cli("set-cap", "--usdc", baseToUsdc(BigInt(st1.spent) + usdcToBase("0.03")));
  check(r.tx?.status === "SUCCESS", "set_cap onchain", r.tx?.hash);
  note("set_cap del dueño (vuelve a haber lugar en el tope)", r.tx?.hash);
  r = await cli("revoke");
  check(r.tx?.status === "SUCCESS", "revoke onchain", r.tx?.hash);
  note("revoke del dueño", r.tx?.hash);
  r = await cli("call", "insight", "--force-onchain");
  const c4 = r.calls?.[0];
  check(c4?.contractError === "Error(Contract, #1)", "pago desde la cuenta revocada: la simulación onchain devuelve Error(Contract, #1) Revoked");
  check(
    c4?.forced?.status === "FAILED" && c4.forced.contractError?.code === 1 && c4.forced.contractError?.account === demo.account,
    "la misma tx mandada directo a la red queda FAILED con Error(Contract, #1), devuelto por __check_auth de la cuenta",
    c4?.forced?.hash,
  );
  note("pago desde cuenta revocada mandado a la red: FAILED Error(Contract, #1)", c4?.forced?.hash, "FAILED");
  r = await cli("call", "insight", "--no-preflight");
  check(r.calls?.[0]?.reason === "revoked", "sin preflight: el servidor devuelve 402 revoked");

  // ============ historial ============
  title("Historial de pagos de la cuenta (eventos transfer de la SAC, vía /api/payments)");
  r = await cli("payments", "--n", "20");
  const seen = new Set((r.payments ?? []).map((p) => p.tx));
  const paidHashes = evidence.filter((e) => e.label.startsWith("pago x402")).map((e) => e.hash);
  check(paidHashes.every((h) => seen.has(h)), "los pagos de esta corrida aparecen en el historial", `${paidHashes.filter((h) => seen.has(h)).length}/${paidHashes.length}`);
  console.log(`  panel del dueño: cd web && pnpm dev, y abrir http://localhost:5173/?account=${demo.account}`);
} catch (e) {
  checks.push({ ok: false, label: `excepción: ${e.message}` });
  console.error(e);
} finally {
  stop();
}

title("Evidencia onchain (stellar:testnet)");
for (const e of evidence) console.log(`${e.status.padEnd(7)} ${e.label}\n        ${e.hash}\n        ${e.link}`);
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} chequeos pasaron en ${Math.round((Date.now() - t0) / 1000)} s`);
console.log(failed.length ? `DEMO FALLÓ: ${failed.map((c) => c.label).join("; ")}` : "DEMO OK");
exitCode = failed.length ? 1 : 0;
process.exit(exitCode);
