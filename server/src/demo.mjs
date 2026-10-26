// "Probar como agente": el servidor corre el flujo x402 del agente con la cuenta de demo
// PUBLICA (deploy/demo-public.json). Ver docs/DEPLOY.md, sección 2.5.
//
// Reglas de seguridad:
//  - La cuenta NUNCA viene del cliente: siempre DEMO_ACCOUNT_ID (o deploy/demo-public.json).
//  - Antes de usarla se lee su wasm onchain: si no es f5ec1e6d… (el wasm nuevo), el endpoint
//    responde 503. Las cuentas del wasm viejo 72f52276… son bloqueables por terceros.
//  - Un pago de demo a la vez por instancia (la clave del facilitador y la del agente son
//    una sola), con espera corta en cola y 429 si no entra. Límite básico por IP.
//
// El flujo es HTTP de verdad: el pedido sale contra este mismo proceso por 127.0.0.1 (un
// listener efímero), así se ve el 402 real, la firma del agente y el settle del facilitador,
// igual que desde la CLI. No depende del dominio público ni de Deployment Protection.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { PassportAccountExactScheme } from "../../agent/src/passport-account-scheme.mjs";
import { payAndFetch } from "../../agent/src/pay.mjs";
import { addr, baseToUsdc, createOnchain, usdcToBase } from "../../agent/src/onchain.mjs";
import { ROOT } from "./config.mjs";
import { txLink } from "./chain.mjs";

export const DEMO_WASM_HASH = "f5ec1e6d5eb29e1975542e87d59655d9628e8606a60a8946bb17d9cd15aff903";
/** Wasm with the payee list (ARCHITECTURE 4.9): the demo account's wasm since the fire test. */
export const ALLOWLIST_WASM_HASH = "b9dfc7c63110619e104fbeb8e912b1b004a4d7709bec57f5d2fbaef90197dd26";
/** The two fixed wasms that third parties cannot block. Never the old 72f52276…. */
export const DEMO_WASM_HASHES = [DEMO_WASM_HASH, ALLOWLIST_WASM_HASH];
const SECONDS_PER_LEDGER = 5;
const DEMO_DEADLINE_MS = 50_000;

/** Cuenta de demo y clave del agente: env primero, después deploy/demo-public.json (solo el ID). */
export function loadDemoConfig(env = process.env, file = path.join(ROOT, "deploy", "demo-public.json")) {
  let pub = {};
  try {
    if (existsSync(file)) pub = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // json roto: se usa solo el env
  }
  const requiredWasm = (env.DEMO_ACCOUNT_WASM_HASH || pub.accountWasmHash || DEMO_WASM_HASH).trim().toLowerCase();
  const accountId = (env.DEMO_ACCOUNT_ID || pub.account || "").trim();
  return {
    accountId,
    agentSecret: (env.DEMO_AGENT_SECRET || "").trim(),
    requiredWasm,
    // Either fixed wasm is accepted, so an older DEMO_ACCOUNT_ID in the env (an f5ec1e6d…
    // account) keeps working even though deploy/demo-public.json now says b9dfc7c6….
    allowedWasms: [...new Set([requiredWasm, ...DEMO_WASM_HASHES])],
    // The agentId from the json only applies when the json describes the same account.
    agentId: !pub.account || pub.account === accountId ? pub.agentId : pub.previous?.account === accountId ? pub.previous.agentId : undefined,
  };
}

/** Mutex con espera acotada: run(fn) o tira { busy: true } si no entra en `waitMs`. */
export function createBoundedMutex(waitMs = 20_000) {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    async run(fn) {
      const prev = tail;
      let release;
      const mine = new Promise((r) => (release = r));
      tail = prev.then(() => mine);
      pending++;
      let timer;
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error("busy"), { busy: true })), waitMs);
      });
      try {
        await Promise.race([prev, timeout]);
      } catch (e) {
        // no entró: se libera su lugar para que la cola siga
        pending--;
        prev.then(() => release());
        throw e;
      } finally {
        clearTimeout(timer);
      }
      try {
        return await fn();
      } finally {
        pending--;
        release();
      }
    },
  };
}

/** Límite por IP en ventana fija (memoria de la instancia: es un freno básico). */
export function createRateLimiter({ max = 10, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.start >= windowMs) {
      h = { start: now, n: 0 };
      hits.set(ip, h);
    }
    h.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
    return h.n <= max ? { ok: true } : { ok: false, retryAfterSec: Math.ceil((h.start + windowMs - now) / 1000) };
  };
}

export function clientIp(req) {
  const xf = req.header("x-vercel-forwarded-for") || req.header("x-forwarded-for") || req.header("x-real-ip") || "";
  return xf.split(",")[0].trim() || req.socket?.remoteAddress || "?";
}

/** Error(Contract, #n) atribuido a una cuenta en el texto de la simulación (event log del host). */
export function attributeContractError(raw, accountId) {
  const s = String(raw ?? "");
  const re = /failed account authentication with error"?,\s*"?(C[A-Z2-7]{55})"?,\s*Error\(Contract, #(\d+)\)/g;
  for (const m of s.matchAll(re)) {
    if (!accountId || m[1] === accountId) return { account: m[1], code: Number(m[2]) };
  }
  return null;
}

const dec = (s) => String(s ?? "");
const minutesUntil =(endsLedger, latest) => Math.max(1, Math.ceil(((Number(endsLedger) - Number(latest)) * SECONDS_PER_LEDGER) / 60));

/**
 * Monta /api/demo/status y /api/demo/pay en `app`.
 * @param {object} o
 * @param {import("express").Express} o.app
 * @param {object} o.cfg    loadConfig(...)
 * @param {object} o.chain  createChain(...)
 * @param {object} [o.env]
 * @param {(s: string) => void} [o.log]
 */
export function mountDemo({ app, cfg, chain, env = process.env, log = console.log, rateMax = Number(env.DEMO_RATE_PER_MIN || 10) }) {
  const demo = loadDemoConfig(env);
  const oc = createOnchain({ rpcUrl: cfg.rpcUrl });
  const mutex = createBoundedMutex(20_000);
  const limit = createRateLimiter({ max: rateMax, windowMs: 60_000 });
  let wasmCheck = null; // { ok, wasmHash, at }
  let localBase = null;

  async function checkAccount() {
    if (wasmCheck && wasmCheck.ok && Date.now() - wasmCheck.at < 10 * 60_000) return wasmCheck;
    let h = null;
    try {
      h = await chain.getWasmHash(demo.accountId);
    } catch (e) {
      return { ok: false, wasmHash: null, detail: e.message };
    }
    wasmCheck = { ok: demo.allowedWasms.includes(h), wasmHash: h, at: Date.now() };
    return wasmCheck;
  }

  /** Listener efímero en 127.0.0.1 para que el agente le pegue a ESTE proceso por HTTP. */
  function getLocalBase() {
    if (!localBase) {
      localBase = new Promise((resolve, reject) => {
        const s = app.listen(0, "127.0.0.1", () => {
          s.unref?.();
          resolve(`http://127.0.0.1:${s.address().port}`);
        });
        s.on("error", (e) => {
          localBase = null;
          reject(e);
        });
      });
    }
    return localBase;
  }

  async function spendStatus() {
    const [s, latest] = await Promise.all([oc.read(demo.accountId, "spend_status"), oc.server.getLatestLedger()]);
    return {
      capUsdc: baseToUsdc(s.effective_cap),
      spentUsdc: baseToUsdc(s.spent),
      remainingUsdc: baseToUsdc(s.remaining),
      remainingBase: String(s.remaining),
      periodEndsLedger: Number(s.period_ends_ledger),
      latestLedger: latest.sequence,
      minutesToReset: minutesUntil(s.period_ends_ledger, latest.sequence),
    };
  }

  async function balanceUsdc() {
    try {
      const b = await oc.read(cfg.asset, "balance", [addr(demo.accountId)]);
      return baseToUsdc(b);
    } catch {
      return null;
    }
  }

  const ready = () => Boolean(demo.accountId && demo.agentSecret);

  app.get("/api/demo/status", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!ready()) return res.status(503).json({ enabled: false, error: "demo_not_configured", message: "The demo is not configured on this server." });
    try {
      const acc = await checkAccount();
      if (!acc.ok) return res.status(503).json({ enabled: false, error: "demo_account_wasm", account: demo.accountId, wasmHash: acc.wasmHash, message: "The demo account does not run the expected contract, so the demo is off." });
      const [spend, balance] = await Promise.all([spendStatus(), balanceUsdc()]);
      res.json({ enabled: true, account: demo.accountId, agentId: demo.agentId, wasmHash: acc.wasmHash, spend, balanceUsdc: balance, prices: cfg.prices, busy: mutex.pending > 0 });
    } catch (e) {
      log(`[demo] status: ${e.message}`);
      res.status(502).json({ enabled: false, error: "upstream", message: "Could not read the account on testnet. Try again in a few seconds." });
    }
  });

  app.post("/api/demo/pay", express.json({ limit: "2kb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const ip = clientIp(req);
    const rl = limit(ip);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return res.status(429).json({ error: "rate_limited", retryAfterSec: rl.retryAfterSec, message: `Too many attempts in a row. Try again in ${rl.retryAfterSec} s.` });
    }
    if (!ready()) return res.status(503).json({ error: "demo_not_configured", message: "The demo is not configured on this server." });
    const action = req.body?.action === "over-cap" ? "over-cap" : "pay";
    const endpoint = ["insight", "quote"].includes(req.body?.endpoint) ? req.body.endpoint : "insight";
    const force = action === "over-cap" && req.body?.force === true;

    // Tope de tiempo de la respuesta (la función de Vercel corta a los 60 s). Si se pasa, el
    // pago sigue en segundo plano y el mutex se libera recién cuando termina de verdad.
    let deadline;
    const tooSlow = new Promise((_, rej) => {
      deadline = setTimeout(() => rej(Object.assign(new Error("deadline"), { slow: true })), DEMO_DEADLINE_MS);
    });
    const running = mutex.run(() => runDemo({ action, endpoint, force }));
    running.catch(() => {}); // si gana el deadline, el rechazo tardío no queda sin manejar
    try {
      const out = await Promise.race([running, tooSlow]);
      res.status(200).json(out);
    } catch (e) {
      if (e.slow) {
        log(`[demo] ${action}: sin respuesta en ${DEMO_DEADLINE_MS} ms`);
        res.setHeader("Retry-After", "15");
        return res.status(504).json({ error: "slow_network", retryAfterSec: 15, message: "Stellar testnet is slower than usual. The payment may still land: check the account in a few seconds." });
      }
      if (e.busy) {
        res.setHeader("Retry-After", "5");
        return res.status(429).json({ error: "busy", retryAfterSec: 5, message: "Another demo transaction is running. Try again in a few seconds." });
      }
      log(`[demo] error: ${e.stack ?? e.message}`);
      res.status(502).json({ error: "demo_failed", message: "Something failed while talking to Stellar testnet. Try again in a few seconds.", detail: String(e.message).slice(0, 300) });
    } finally {
      clearTimeout(deadline);
    }
  });

  async function runDemo({ action, endpoint, force }) {
    const acc = await checkAccount();
    if (!acc.ok) {
      const err = new Error(`demo account wasm ${acc.wasmHash} != ${demo.requiredWasm}`);
      throw err;
    }
    const before = await spendStatus();
    const base = await getLocalBase();

    // Monto: pago normal = precio del endpoint; "pasar el tope" = report por más de lo que queda.
    let url;
    let askedUsdc;
    if (action === "over-cap") {
      const min = usdcToBase(cfg.prices.reportMin);
      const over = BigInt(before.remainingBase) + 100_000n; // queda + 0,01
      const amt = over > min ? over : min;
      askedUsdc = baseToUsdc(amt);
      url = `${base}/api/premium/report?usd=${askedUsdc}`;
    } else {
      askedUsdc = cfg.prices[endpoint];
      url = `${base}/api/premium/${endpoint}`;
    }
    const publicPath = new URL(url).pathname + new URL(url).search;

    // Se registra cada intercambio HTTP para mostrar el 402 tal cual llegó.
    const exchanges = [];
    const fetchImpl = async (u, init) => {
      const r = await fetch(u, { ...init, signal: AbortSignal.timeout(35_000) });
      const pr = r.headers.get("payment-required");
      const pres = r.headers.get("payment-response");
      let challenge;
      if (pr) {
        try {
          const d = decodePaymentRequiredHeader(pr);
          const a = d.accepts?.[0];
          challenge = a && { x402Version: d.x402Version, scheme: a.scheme, network: a.network, amount: a.amount, amountUsdc: baseToUsdc(a.amount), asset: a.asset, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds, error: d.error };
        } catch {
          // header ilegible
        }
      }
      exchanges.push({ request: { method: "GET", path: publicPath, paymentSignature: Boolean(init?.headers) }, status: r.status, paymentRequired: challenge, paymentResponse: Boolean(pres) });
      return r;
    };

    const scheme = new PassportAccountExactScheme({ accountId: demo.accountId, agentSecret: demo.agentSecret, rpcConfig: { url: cfg.rpcUrl }, preflight: true });
    // Se guarda el texto crudo de la simulación rechazada (trae el event log del host con
    // la cuenta que falló la autenticación) para atribuir el Error(Contract, #n).
    let lastRejection = null;
    const create = scheme.createPaymentPayload.bind(scheme);
    scheme.createPaymentPayload = async (...a) => {
      try {
        return await create(...a);
      } catch (e) {
        lastRejection = e;
        throw e;
      }
    };
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await payAndFetch({ url, scheme, network: cfg.network, maxAmountUsd: "$1", fetchImpl });
      const transient = r.outcome === "rejected_by_server" && /submission_failed|bad_seq|try_again|timeout/i.test(String(r.reason ?? ""));
      if (!transient || attempt === 2) break;
      log(`[demo] reintento ${attempt + 1} por ${r.reason}`);
      await new Promise((ok) => setTimeout(ok, 500 + Math.random() * 1000));
    }

    const challenge = exchanges.find((x) => x.status === 402 && x.paymentRequired)?.paymentRequired ?? null;
    const result = {
      action,
      endpoint: action === "over-cap" ? "report" : endpoint,
      path: publicPath,
      askedUsdc,
      account: demo.accountId,
      agentPublic: scheme.agent.publicKey(),
      challenge,
      exchanges,
      outcome: r.outcome,
      before,
    };

    if (r.outcome === "paid") {
      result.tx = r.settle?.transaction;
      result.link = result.tx ? txLink(result.tx) : undefined;
      result.response = trimBody(r.body);
      result.message = `Paid ${dec(askedUsdc)} USDC from the agent's account.`;
    } else if (r.outcome === "rejected_onchain_simulation") {
      const attributed = attributeContractError(lastRejection?.raw ?? r.error, demo.accountId);
      result.contractError = r.contractError ? { code: r.contractError.code, raw: r.contractError.raw, name: r.contractError.name, es: r.contractError.es, stage: r.stage } : null;
      result.attributedTo = attributed?.account ?? null;
      result.rejectedBy = "contract_simulation";
      if (r.contractError?.code === 6) {
        result.message =
          action === "over-cap"
            ? `The account contract refused the payment: it asked for ${dec(askedUsdc)} USDC and this period has ${dec(before.remainingUsdc)} of ${dec(before.capUsdc)} USDC left.`
            : `This period's cap is used up: ${dec(before.remainingUsdc)} of ${dec(before.capUsdc)} USDC left and the call costs ${dec(askedUsdc)}. It opens again in ${before.minutesToReset} min.`;
      } else if (r.contractError?.code === 1) {
        result.message = "The owner revoked this account: the contract refuses every payment.";
      } else {
        result.message = `The account contract refused the payment: ${r.contractError ? `${r.contractError.raw} ${r.contractError.name}` : r.error}`;
      }
      if (force && r.requirement) {
        // Envío forzado directo a la red, sin servidor ni facilitador: el ledger corre
        // __check_auth de verdad y la tx queda FAILED. El fee lo paga la G del agente.
        try {
          const f = await oc.forceTransferOnchain({
            accountId: demo.accountId,
            agentSecret: demo.agentSecret,
            feePayerSecret: demo.agentSecret,
            asset: r.requirement.asset,
            payTo: r.requirement.payTo,
            amount: r.requirement.amount,
          });
          result.forced = { hash: f.hash, status: f.status, link: f.link, resultCode: f.resultCode, contractError: f.contractError ?? null, feeChargedStroops: f.feeChargedStroops };
        } catch (e) {
          result.forced = { status: "ERROR", error: String(e.message).slice(0, 300) };
        }
      }
    } else if (r.outcome === "rejected_by_server") {
      result.reason = r.reason;
      result.contractError = r.contractError ? { code: r.contractError.code, raw: r.contractError.raw, name: r.contractError.name, es: r.contractError.es } : null;
      result.rejectedBy = "server";
      result.message =
        r.reason === "cap_exceeded"
          ? `This period's cap is used up. It opens again in ${before.minutesToReset} min.`
          : `The server did not accept the payment (${r.reason ?? `HTTP ${r.status}`}).`;
      if (r.settle?.transaction) {
        result.tx = r.settle.transaction;
        result.link = txLink(r.settle.transaction);
      }
    } else {
      result.status = r.status;
      result.message = `Unexpected server response (HTTP ${r.status}).`;
      result.response = trimBody(r.body);
    }

    try {
      result.after = await spendStatus();
    } catch {
      result.after = null;
    }
    log(`[demo] ${action} ${publicPath} -> ${r.outcome}${result.tx ? ` tx=${result.tx}` : ""}${result.contractError ? ` ${result.contractError.raw}` : ""}${result.forced ? ` forzado=${result.forced.status}` : ""}`);
    return result;
  }

  return { demo, mutex };
}

function trimBody(b) {
  if (b === undefined || b === null) return b;
  const s = JSON.stringify(b);
  if (s.length <= 4000) return b;
  return { truncated: true, preview: s.slice(0, 4000) };
}
