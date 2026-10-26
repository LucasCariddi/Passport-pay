// App Express de Passport Pay: rutas pagas x402 + lecturas onchain para la web.
// Se arma con dependencias inyectables (chain, facilitador, datos) para poder testear
// con mocks; index.mjs la arma con las reales.
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactStellarScheme as ServerScheme } from "@x402/stellar/exact/server";
import { decodeTransferFromTxXdr, isContractAddress, jsonSafe } from "./chain.mjs";
import { buildCatalog } from "./catalog.mjs";

export const USD_RE = /^\d{1,6}(\.\d{1,7})?$/;

/** Precio en USD del endpoint `report`: lo elige el cliente con ?usd= dentro de [min, max]. */
export function parseReportPrice(q, { reportMin, reportMax }) {
  const raw = q ?? reportMin;
  if (typeof raw !== "string" || !USD_RE.test(raw)) return { error: "usd must be a decimal number (up to 7 decimals)" };
  const v = Number(raw);
  if (v < Number(reportMin) || v > Number(reportMax)) return { error: `usd out of range [${reportMin}, ${reportMax}]` };
  return { usd: raw };
}

/**
 * @param {object} deps
 * @param {ReturnType<import("./config.mjs").loadConfig>} deps.cfg
 * @param {object} deps.chain        createChain(...)
 * @param {object} deps.facilitator  FacilitatorClient {verify, settle, getSupported}
 * @param {object} deps.data         createDataSources(...)
 * @param {object} deps.recent       { list(), push(rec) }
 * @param {(s: string) => void} [deps.log]
 * @param {boolean} [deps.syncFacilitatorOnStart]
 */
export function createApp({ cfg, chain, facilitator, data, recent, log = console.log, syncFacilitatorOnStart = true }) {
  if (!cfg.payTo) throw new Error("falta MERCHANT_PUBLIC (payTo) en .env");
  const app = express();
  app.disable("x-powered-by");

  // CORS para la web (Vite). Exponemos los headers x402 para que el navegador los lea.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", cfg.corsOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT");
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  // Log de cada pedido a rutas pagas: con o sin pago.
  app.use("/api/premium", (req, res, next) => {
    const t0 = Date.now();
    const paid = Boolean(req.header("payment-signature") || req.header("x-payment"));
    res.on("finish", () => {
      const pr = res.getHeader("payment-response");
      log(`[http] ${req.method} ${req.originalUrl} ${paid ? "con pago" : "sin pago"} -> ${res.statusCode} (${Date.now() - t0} ms)${pr ? " PAYMENT-RESPONSE" : ""}`);
    });
    next();
  });

  // HEAD no pasa por el cobro (el middleware x402 matchea "GET ...") y Express lo resolvería
  // con el handler de GET: el dato se armaría gratis. Las rutas pagas solo aceptan GET.
  app.use("/api/premium", (req, res, next) => {
    if (req.method !== "HEAD") return next();
    res.setHeader("Allow", "GET");
    res.status(405).end();
  });

  // Validamos ?usd= antes del middleware de pago: un precio inválido es 400, no 402.
  app.use("/api/premium/report", (req, res, next) => {
    const p = parseReportPrice(req.query.usd, cfg.prices);
    if (p.error) return res.status(400).json({ error: p.error });
    next();
  });

  const resourceServer = new x402ResourceServer(facilitator).register(cfg.network, new ServerScheme());
  const accepts = (price) => ({ scheme: "exact", price, network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 });
  const routes = {
    "GET /api/premium/insight": {
      accepts: accepts(`$${cfg.prices.insight}`),
      description: "Stellar testnet network summary with a suggested fee for agents",
      mimeType: "application/json",
    },
    "GET /api/premium/quote": {
      accepts: accepts(`$${cfg.prices.quote}`),
      description: "XLM/USDC quote from the Stellar testnet DEX (best bid and ask, spread, depth)",
      mimeType: "application/json",
    },
    "GET /api/premium/report": {
      accepts: accepts((ctx) => `$${parseReportPrice(ctx.adapter.getQueryParam?.("usd"), cfg.prices).usd}`),
      description: "Full report (network, quote and the payer's spend). Price chosen with ?usd=",
      mimeType: "application/json",
    },
  };
  // Catálogo gratis: se deriva del mismo `routes` que cobra el middleware (ver catalog.mjs).
  const catalog = (_req, res) => res.json(buildCatalog(routes, cfg));
  app.get("/catalog", catalog);
  app.get("/api/catalog", catalog);
  app.use(paymentMiddleware(routes, resourceServer, undefined, undefined, syncFacilitatorOnStart));

  /** Quién pagó: lo leemos del transfer firmado que vino en PAYMENT-SIGNATURE. */
  function paidBy(req) {
    try {
      const h = req.header("payment-signature") || req.header("x-payment");
      const p = decodePaymentSignatureHeader(h);
      const t = decodeTransferFromTxXdr(p.payload.transaction, cfg.networkPassphrase);
      return t ? { payer: t.from, amount: t.amount, asset: t.contract } : null;
    } catch {
      return null;
    }
  }
  // El hash de la tx no existe todavía acá: el settle corre después del handler y viaja
  // en el header PAYMENT-RESPONSE.
  const settleNote = "el hash de la tx viene en el header PAYMENT-RESPONSE";

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      log(`[error] ${req.originalUrl}: ${e.message}`);
      res.status(502).json({ error: "upstream", detail: e.message });
    }
  };

  app.get("/api/premium/insight", wrap(async (req, res) => {
    const topic = String(req.query.topic ?? "network").slice(0, 64);
    res.json({ ...(await data.insight(topic)), paidBy: paidBy(req), tx: settleNote });
  }));

  app.get("/api/premium/quote", wrap(async (req, res) => {
    const xlm = req.query.xlm && USD_RE.test(String(req.query.xlm)) ? String(req.query.xlm) : undefined;
    res.json({ ...(await data.quote({ xlm })), paidBy: paidBy(req), tx: settleNote });
  }));

  app.get("/api/premium/report", wrap(async (req, res) => {
    const pb = paidBy(req);
    const [insight, quote, account] = await Promise.all([
      data.insight("report"),
      data.quote({}),
      pb?.payer && isContractAddress(pb.payer) ? chain.getAccountView(pb.payer) : null,
    ]);
    res.json({ report: { insight, quote, payerAccount: account }, priceUsd: req.query.usd ?? cfg.prices.reportMin, paidBy: pb, tx: settleNote });
  }));

  // --- sin pago --------------------------------------------------------------
  const health = (_req, res) =>
    res.json({
      ok: true,
      network: cfg.network,
      facilitator: { kind: "local", address: cfg.facilitatorPublic ?? null },
      payTo: cfg.payTo,
      asset: cfg.asset,
      admission: cfg.factoryId ? { factory: cfg.factoryId, wasmHashes: cfg.accountWasmHashes } : { wasmHashes: cfg.accountWasmHashes },
      prices: {
        "/api/premium/insight": `$${cfg.prices.insight}`,
        "/api/premium/quote": `$${cfg.prices.quote}`,
        "/api/premium/report": `?usd= entre $${cfg.prices.reportMin} y $${cfg.prices.reportMax}`,
      },
    });
  app.get("/health", health);
  app.get("/api/health", health);

  app.get("/api/accounts/:id", wrap(async (req, res) => {
    if (!isContractAddress(req.params.id)) return res.status(400).json({ error: "id must be a C... contract address" });
    const [view, adm] = await Promise.all([chain.getAccountView(req.params.id), chain.isPassportAccount(req.params.id)]);
    res.json({ ...view, admitted: adm.ok, admission: jsonSafe(adm) });
  }));

  app.get("/api/payments", wrap(async (req, res) => {
    const account = req.query.account ? String(req.query.account) : undefined;
    if (account && !isContractAddress(account) && !/^G[A-Z2-7]{55}$/.test(account)) return res.status(400).json({ error: "invalid account: expected a G... or C... address" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const to = account ? undefined : cfg.payTo; // sin account: todo lo que cobró el comercio
    const lookbackLedgers = Math.min(120_000, Math.max(100, Number(req.query.lookback ?? 30_000) || 30_000));
    const list = await chain.getPayments({ from: account, to, limit, lookbackLedgers });
    // Si el RPC no pudo procesar alguna ventana vieja, la lista puede estar incompleta.
    if (list.skippedWindows?.length) res.setHeader("X-Payments-Partial", JSON.stringify(list.skippedWindows));
    res.json(list);
  }));

  // Lo que vio ESTE proceso (incluye rechazos con el error del contrato). Se pierde al reiniciar.
  app.get("/api/payments/recent", (_req, res) => res.json(recent.list()));

  return app;
}

/** Registro en memoria, acotado, de pagos y rechazos. */
export function createRecentLog(max = 200) {
  const items = [];
  return {
    push(rec) {
      items.unshift({ at: new Date().toISOString(), ...rec });
      if (items.length > max) items.length = max;
    },
    list: () => items.slice(),
  };
}
