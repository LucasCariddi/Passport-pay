// Catálogo público (gratis) de los servicios pagos que expone este servidor.
// No duplica precios: se arma a partir del MISMO objeto `routes` que recibe el
// paymentMiddleware de x402, así lo que muestra el catálogo es lo que se cobra.
// Acá solo vive el texto para personas (nombre, descripción corta, ejemplo).

const USDC_DECIMALS = 7;

/** Texto y ejemplo por ruta. La clave es la misma que en `routes` ("GET /ruta"). */
export const CATALOG_META = {
  "GET /api/premium/insight": {
    id: "insight",
    name: "Network insight",
    summary: "Latest ledger, protocol version and the suggested fee, so your transaction gets in without overpaying.",
    params: [{ name: "topic", optional: true, description: "Free-form tag echoed back in the response" }],
    example: {
      topic: "network",
      insight: "Ledger 2456500, protocol 23. Soroban inclusion fee p50=100 p90=100 stroops: quiet network, p50 is enough.",
      suggestedInclusionFeeStroops: "100",
      network: { latestLedger: 2456500, protocolVersion: 23, sorobanInclusionFee: { p50: "100", p90: "100" } },
    },
  },
  "GET /api/premium/quote": {
    id: "quote",
    name: "XLM/USDC quote",
    summary: "Best bid and ask on the Stellar DEX, spread and book depth. With ?xlm= it estimates how much USDC you get.",
    params: [{ name: "xlm", optional: true, description: "Amount of XLM to estimate the exchange for" }],
    example: {
      pair: "XLM/USDC",
      venue: "Stellar DEX (testnet)",
      bestBid: 0.25,
      bestAsk: 0.88,
      mid: 0.565,
      spreadBps: 11150,
      at: "2026-10-25T12:00:00.000Z",
    },
  },
  "GET /api/premium/report": {
    id: "report",
    name: "Full report",
    summary: "Network state, quote and the paying account's spend, all together. The agent picks how much to pay with ?usd=.",
    params: [{ name: "usd", optional: true, description: "Amount to pay, within the price range" }],
    example: {
      report: {
        insight: { topic: "report", insight: "Ledger 2456500, protocol 23. …" },
        quote: { pair: "XLM/USDC", mid: 0.565 },
        payerAccount: { config: { cap: "500000" }, spendStatus: { remaining: "100000" }, balance: "1000000" },
      },
      priceUsd: "0.05",
    },
  },
};

/** "0.01" -> "100000" (unidades base de USDC, 7 decimales). */
export function usdcToBase(s) {
  const [i, f = ""] = String(s).split(".");
  return (BigInt(i || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt((f + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS))).toString();
}

const stripDollar = (p) => String(p).replace(/^\$/, "");

/**
 * @param {Record<string, {accepts: {price: string|Function, network: string, payTo: string, scheme: string}, description?: string, mimeType?: string}>} routes
 *        el mismo objeto que se le pasa a paymentMiddleware
 * @param {{ asset: string, network: string, payTo: string, prices: {reportMin: string, reportMax: string} }} cfg
 */
export function buildCatalog(routes, cfg) {
  const services = Object.entries(routes).map(([key, route]) => {
    const [method, path] = key.split(" ");
    const meta = CATALOG_META[key] ?? {};
    const acc = Array.isArray(route.accepts) ? route.accepts[0] : route.accepts;
    // Precio fijo: string "$0.01". Precio dinámico (función): el rango configurado.
    const dynamic = typeof acc.price === "function";
    const priceUsdc = dynamic ? stripDollar(cfg.prices.reportMin) : stripDollar(acc.price);
    const id = meta.id ?? path.split("/").pop();
    return {
      id,
      name: meta.name ?? id,
      summary: meta.summary ?? route.description ?? "",
      description: route.description ?? "",
      method,
      path,
      mimeType: route.mimeType ?? "application/json",
      price: {
        usdc: priceUsdc,
        base: usdcToBase(priceUsdc),
        ...(dynamic ? { kind: "range", min: stripDollar(cfg.prices.reportMin), max: stripDollar(cfg.prices.reportMax), param: "usd" } : { kind: "fixed" }),
      },
      scheme: acc.scheme,
      network: acc.network,
      payTo: acc.payTo,
      asset: cfg.asset,
      buyers: "passport-accounts",
      params: meta.params ?? [],
      exampleResponse: meta.example ?? null,
    };
  });
  return {
    network: cfg.network,
    asset: { code: "USDC", contract: cfg.asset, decimals: USDC_DECIMALS },
    payTo: cfg.payTo,
    protocol: "x402",
    buyers: "Only PassportAccount smart accounts, checked onchain before every payment",
    services,
  };
}
