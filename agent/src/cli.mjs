#!/usr/bin/env node
// passport-agent: CLI del agente de Passport Pay. Ver docs/ARCHITECTURE.md 4.5.
//
// El agente paga x402 desde su PassportAccount (cuenta contrato C...). El tope de gasto,
// el pasaporte y la revocación los aplica el contrato onchain en __check_auth: si un pago
// no entra, lo rechaza la simulación onchain o la tx sale FAILED en el ledger.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { loadAgentConfig, ROOT } from "./config.mjs";
import { addr, baseToUsdc, bytes32, createOnchain, i128, txLink, u256, u32, usdcToBase } from "./onchain.mjs";
import { PassportAccountExactScheme } from "./passport-account-scheme.mjs";
import { payAndFetch } from "./pay.mjs";

const HELP = `passport-agent <comando> [opciones]

Comandos del agente:
  setup                          revisa config, cuenta, pasaporte, saldo y servidor
  status                         tope, gasto del período, saldo y pasaporte (lecturas onchain)
  call <endpoint>                GET con pago x402 desde la PassportAccount
       endpoint: insight | quote | report | /ruta | http://url
       --amount <usdc>           precio a pagar (endpoint report: ?usd=); sirve para pasarse del tope
       --param k=v               query extra (repetible), p. ej. --param topic=fees
       --no-preflight            no simular antes: que lo rechace la simulación del facilitador
       --force-onchain           si el contrato lo rechaza, mandar igual la tx a la red (sale FAILED)
       --max <usd>               límite local del cliente por pago (default 1)
  loop <endpoint> --n <N>        paga N veces (o hasta que el contrato lo rechace)
  payments                       pagos de la cuenta (eventos transfer de la SAC vía servidor)
  keygen                         genera una clave ed25519 nueva para un agente

Comandos del dueño (en la web los firma Freighter; acá usan OWNER_SECRET del .env):
  fund --usdc <monto>            deposita USDC del dueño en la PassportAccount
  set-cap --usdc <monto> [--period <ledgers>]   tope por período (onchain)
  revoke                         revoca la cuenta: todo pago falla onchain con Error(Contract, #1)
  unrevoke                       vuelve a fijar la clave del agente (des-revoca)

Opciones comunes: --server <url> (default AGENT_SERVER_URL o http://127.0.0.1:4021),
  --account <C...> (default PASSPORT_ACCOUNT_ID), --json (salida en JSON)`;

const OPTIONS = {
  amount: { type: "string" },
  param: { type: "string", multiple: true },
  preflight: { type: "boolean", default: true },
  "force-onchain": { type: "boolean", default: false },
  max: { type: "string", default: "1" },
  server: { type: "string" },
  account: { type: "string" },
  json: { type: "boolean", default: false },
  usdc: { type: "string" },
  period: { type: "string" },
  n: { type: "string" },
  help: { type: "boolean", short: "h" },
};

export function parseCli(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });
  return { cmd: positionals[0], rest: positionals.slice(1), opts: values };
}

/** insight | quote | report | /ruta | URL completa -> URL con ?usd= y params extra. */
export function resolveEndpoint(endpoint, { serverUrl, amount, params = [] }) {
  if (!endpoint) throw new Error("falta <endpoint> (insight, quote, report, /ruta o URL)");
  let u;
  if (/^https?:\/\//.test(endpoint)) u = new URL(endpoint);
  else if (endpoint.startsWith("/")) u = new URL(serverUrl + endpoint);
  else u = new URL(`${serverUrl}/api/premium/${endpoint}`);
  if (amount !== undefined) {
    if (!/^\d+(\.\d{1,7})?$/.test(amount)) throw new Error(`--amount inválido: ${amount}`);
    u.searchParams.set("usd", amount);
  }
  for (const p of params) {
    const i = p.indexOf("=");
    if (i < 1) throw new Error(`--param tiene que ser k=v: ${p}`);
    u.searchParams.set(p.slice(0, i), p.slice(i + 1));
  }
  return u.toString();
}

function makeOut(json) {
  const lines = [];
  return {
    log: (...a) => (json ? lines.push(a.join(" ")) : console.log(...a)),
    lines,
  };
}

async function spendLine(oc, accountId) {
  try {
    const s = await oc.read(accountId, "spend_status");
    return {
      s,
      text: `tope efectivo ${baseToUsdc(s.effective_cap)} USDC, gastado ${baseToUsdc(s.spent)}, disponible ${baseToUsdc(s.remaining)} (período ${s.period}, termina en el ledger ${s.period_ends_ledger})`,
    };
  } catch (e) {
    return { s: null, text: `spend_status falló onchain: ${e.contractError ? `${e.contractError.raw} ${e.contractError.name}` : e.message}` };
  }
}

function need(v, msg) {
  if (!v) throw new Error(msg);
  return v;
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, rest, opts } = parseCli(argv);
  if (!cmd || opts.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  const cfg = loadAgentConfig();
  const serverUrl = (opts.server ?? cfg.serverUrl).replace(/\/$/, "");
  const accountId = opts.account ?? cfg.accountId;
  const oc = createOnchain({ rpcUrl: cfg.rpcUrl });
  const out = makeOut(opts.json);
  const result = {};

  switch (cmd) {
    case "keygen": {
      const kp = Keypair.random();
      const dir = path.join(ROOT, ".secrets");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `agent-${kp.publicKey().slice(0, 8)}.secret`);
      writeFileSync(file, kp.secret() + "\n", { mode: 0o600 });
      Object.assign(result, { public: kp.publicKey(), agentKeyHex: kp.rawPublicKey().toString("hex"), secretFile: file });
      out.log(`clave nueva del agente: ${kp.publicKey()}`);
      out.log(`agent_key (hex, para PassportFactory.register): ${result.agentKeyHex}`);
      out.log(`secreto guardado en ${file} (600, ignorado por git). Para usarla: AGENT_SECRET en .env`);
      break;
    }

    case "setup":
    case "status": {
      const checks = [];
      const ok = (cond, label, detail = "") => {
        checks.push({ ok: Boolean(cond), label, detail });
        out.log(`${cond ? "[ok]   " : "[falta]"} ${label}${detail ? `: ${detail}` : ""}`);
        return cond;
      };
      ok(cfg.network === "stellar:testnet", "red", cfg.network);
      const agent = cfg.agentSecret ? Keypair.fromSecret(cfg.agentSecret) : null;
      ok(agent, "clave del agente (AGENT_SECRET)", agent ? agent.publicKey() : "corré passport-agent keygen");
      ok(accountId, "PassportAccount (PASSPORT_ACCOUNT_ID o deploy/)", accountId ?? "");
      if (!accountId) break;
      let config = null;
      try {
        config = await oc.read(accountId, "config");
      } catch (e) {
        ok(false, "config() de la cuenta", e.message);
      }
      if (config) {
        ok(true, "cuenta desplegada", `https://stellar.expert/explorer/testnet/contract/${accountId}`);
        const keyMatch = agent && Buffer.from(config.agent_key).equals(agent.rawPublicKey());
        ok(keyMatch, "la clave del agente es la que acepta la cuenta", keyMatch ? "" : "agent_key distinta: los pagos van a fallar con Error(Contract, #3)");
        ok(!config.revoked, "cuenta no revocada", config.revoked ? "revocada por el dueño" : "");
        ok(config.token === cfg.asset, "token de la cuenta = USDC SAC", config.token);
        ok(config.validator === cfg.validatorId, "validador OSP", config.validator);
        let passport = null;
        try {
          passport = await oc.read(config.validator, "get_passport", [u256(config.agent_id)]);
        } catch (e) {
          ok(false, "pasaporte", e.message);
        }
        ok(passport, `pasaporte ZK del agente #${config.agent_id}`, passport ? `spend_cap ${baseToUsdc(passport.spend_cap)} USDC, ledger ${passport.ledger}` : "sin pasaporte: Error(Contract, #4)");
        const bal = await oc.read(cfg.asset, "balance", [addr(accountId)]).catch(() => null);
        ok(bal !== null && BigInt(bal) > 0n, "saldo USDC de la cuenta", bal !== null ? `${baseToUsdc(bal)} USDC` : "?");
        const sl = await spendLine(oc, accountId);
        ok(sl.s && BigInt(sl.s.remaining) > 0n, "tope disponible en el período", sl.text);
        Object.assign(result, { config, passport, balance: bal, spendStatus: sl.s });
      }
      if (agent) {
        const r = await fetch(`${cfg.horizonUrl}/accounts/${agent.publicKey()}`).then((x) => x.json()).catch(() => null);
        const xlm = r?.balances?.find((b) => b.asset_type === "native")?.balance;
        ok(xlm, "XLM del agente (solo para --force-onchain, los pagos x402 los paga el facilitador)", xlm ? `${xlm} XLM` : "cuenta G sin fondear (friendbot)");
      }
      const h = await fetch(`${serverUrl}/api/health`).then((x) => x.json()).catch((e) => ({ error: e.message }));
      ok(h?.ok, `servidor ${serverUrl}`, h?.ok ? `payTo ${h.payTo}` : `no responde (${h?.error ?? "?"}); arrancalo con: node server/src/index.mjs`);
      if (h?.ok && accountId) {
        const a = await fetch(`${serverUrl}/api/accounts/${accountId}`).then((x) => x.json()).catch(() => null);
        ok(a?.admitted, "el servidor admite esta cuenta como pagadora", a?.admission ? `vía ${a.admission.via}` : "");
      }
      result.checks = checks;
      if (cmd === "setup" && checks.some((c) => !c.ok)) result.exitCode = 1;
      break;
    }

    case "call":
    case "loop": {
      need(cfg.agentSecret, "falta AGENT_SECRET en .env");
      need(accountId, "falta PASSPORT_ACCOUNT_ID (o deploy/*.json)");
      const url = resolveEndpoint(rest[0], { serverUrl, amount: opts.amount, params: opts.param ?? [] });
      const n = cmd === "loop" ? Number(opts.n ?? 10) : 1;
      const scheme = new PassportAccountExactScheme({
        accountId,
        agentSecret: cfg.agentSecret,
        rpcConfig: { url: cfg.rpcUrl },
        preflight: opts.preflight,
      });
      result.calls = [];
      out.log(`agente ${Keypair.fromSecret(cfg.agentSecret).publicKey()} paga desde la PassportAccount ${accountId}`);
      out.log(`antes: ${(await spendLine(oc, accountId)).text}`);
      for (let i = 1; i <= n; i++) {
        out.log(`\n${n > 1 ? `#${i} ` : ""}GET ${url}`);
        const r = await payAndFetch({ url, scheme, network: cfg.network, maxAmountUsd: `$${opts.max}` });
        const rec = { i, url, outcome: r.outcome, status: r.status, amount: r.requirement?.amount, payTo: r.requirement?.payTo };
        if (r.requirement) out.log(`  402 Payment Required: ${baseToUsdc(r.requirement.amount)} USDC a ${r.requirement.payTo} (${r.requirement.scheme}, ${r.requirement.network})`);
        if (r.outcome === "paid") {
          rec.tx = r.settle?.transaction;
          rec.link = rec.tx ? txLink(rec.tx) : undefined;
          rec.body = r.body;
          out.log(`  PAGADO: tx ${rec.tx}`);
          out.log(`          ${rec.link}`);
          out.log(`  respuesta: ${summarize(r.body)}`);
        } else if (r.outcome === "rejected_onchain_simulation") {
          rec.contractError = r.contractError?.raw;
          rec.reason = r.contractError?.reason;
          out.log(`  RECHAZADO ONCHAIN por el contrato PassportAccount (simulación ${r.stage} contra testnet): ${r.error}`);
          out.log("  No se mandó nada al servidor: el __check_auth de la cuenta no autoriza este transfer.");
          if (opts["force-onchain"]) {
            need(cfg.agentSecret, "falta AGENT_SECRET");
            out.log("  --force-onchain: mando la tx firmada directo a la red, sin servidor ni facilitador (fee la paga la cuenta G del agente)...");
            const f = await oc.forceTransferOnchain({
              accountId,
              agentSecret: cfg.agentSecret,
              feePayerSecret: cfg.agentSecret,
              asset: r.requirement.asset,
              payTo: r.requirement.payTo,
              amount: r.requirement.amount,
            });
            rec.forced = f;
            out.log(`  resultado en el ledger: ${f.status}${f.resultCode ? ` (${f.resultCode})` : ""}${f.contractError ? `, ${f.contractError.raw} ${f.contractError.name}: ${f.contractError.es}` : ""}`);
            out.log(`  tx ${f.hash}`);
            out.log(`     ${f.link}`);
          } else {
            out.log("  (con --force-onchain la mando igual a la red y queda FAILED en el ledger)");
          }
        } else if (r.outcome === "rejected_by_server") {
          rec.reason = r.reason;
          rec.contractError = r.contractError?.raw;
          const why = r.contractError ? ` = ${r.contractError.raw} ${r.contractError.name}: ${r.contractError.es} (lo devolvió el contrato en la simulación onchain del facilitador)` : "";
          out.log(`  RECHAZADO por el servidor: HTTP ${r.status} motivo "${r.reason}"${why}`);
          if (r.settle?.transaction) out.log(`  tx ${r.settle.transaction} ${txLink(r.settle.transaction)}`);
        } else if (r.outcome === "rejected_client_limit") {
          out.log(`  NO PAGADO por el límite LOCAL del cliente (--max ${opts.max}): ${r.error}`);
          out.log("  Esto no es el tope onchain; subí --max para que decida el contrato.");
        } else {
          rec.body = r.body;
          out.log(`  HTTP ${r.status}: ${summarize(r.body)}`);
        }
        result.calls.push(rec);
        if (r.outcome !== "paid") break;
      }
      out.log(`\ndespués: ${(await spendLine(oc, accountId)).text}`);
      const last = result.calls.at(-1);
      result.exitCode = last?.outcome === "paid" || last?.outcome === "free" ? 0 : 2;
      break;
    }

    case "payments": {
      need(accountId, "falta PASSPORT_ACCOUNT_ID");
      const list = await fetch(`${serverUrl}/api/payments?account=${accountId}&limit=${opts.n ?? 20}`).then((r) => r.json());
      result.payments = list;
      if (!Array.isArray(list)) {
        out.log(`error: ${JSON.stringify(list)}`);
        result.exitCode = 1;
        break;
      }
      out.log(`${list.length} pagos desde ${accountId}:`);
      for (const p of list) out.log(`  ${p.at}  ${baseToUsdc(p.amount).padStart(8)} USDC -> ${p.to}  ${p.link}`);
      break;
    }

    case "fund":
    case "set-cap":
    case "revoke":
    case "unrevoke": {
      const owner = Keypair.fromSecret(need(cfg.ownerSecret, "falta OWNER_SECRET en .env (operación del dueño)"));
      need(accountId, "falta PASSPORT_ACCOUNT_ID");
      let r;
      if (cmd === "fund") {
        const amount = usdcToBase(need(opts.usdc, "falta --usdc"));
        out.log(`dueño ${owner.publicKey()} deposita ${baseToUsdc(amount)} USDC en ${accountId}...`);
        r = await oc.invoke(owner, cfg.asset, "transfer", [addr(owner.publicKey()), addr(accountId), i128(amount)]);
      } else if (cmd === "set-cap") {
        const cap = usdcToBase(need(opts.usdc, "falta --usdc"));
        const cur = await oc.read(accountId, "config");
        const period = Number(opts.period ?? cur.period_ledgers);
        out.log(`dueño fija el tope en ${baseToUsdc(cap)} USDC cada ${period} ledgers...`);
        r = await oc.invoke(owner, accountId, "set_cap", [i128(cap), u32(period)]);
      } else if (cmd === "revoke") {
        out.log("dueño revoca la cuenta...");
        r = await oc.invoke(owner, accountId, "revoke");
      } else {
        const agent = Keypair.fromSecret(need(cfg.agentSecret, "falta AGENT_SECRET"));
        out.log(`dueño vuelve a fijar la clave del agente ${agent.publicKey()} (des-revoca)...`);
        r = await oc.invoke(owner, accountId, "set_agent_key", [bytes32(agent.rawPublicKey())]);
      }
      result.tx = r;
      out.log(`  ${r.status} tx ${r.hash}`);
      out.log(`  ${r.link}`);
      out.log(`  ${(await spendLine(oc, accountId)).text}`);
      if (r.status !== "SUCCESS") result.exitCode = 1;
      break;
    }

    default:
      console.error(`comando desconocido: ${cmd}\n\n${HELP}`);
      return 64;
  }

  if (opts.json) console.log(JSON.stringify({ cmd, ...result, log: out.lines }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return result.exitCode ?? 0;
}

function summarize(body) {
  if (body === undefined) return "(vacía)";
  if (typeof body === "string") return body.slice(0, 200);
  if (body.insight) return body.insight;
  if (body.pair) return `${body.pair} bid ${body.bestBid} ask ${body.bestAsk} mid ${body.mid} (${body.venue})`;
  if (body.report) return `informe: ${body.report.insight?.insight ?? ""} | ${body.report.quote?.pair ?? ""} mid ${body.report.quote?.mid ?? ""}`;
  return JSON.stringify(body).slice(0, 200);
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    },
  );
}
