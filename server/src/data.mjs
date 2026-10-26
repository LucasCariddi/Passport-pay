// Datos que vende la API. Son datos reales de testnet, útiles para un agente que opera
// en Stellar: resumen de la red con fees sugeridos y cotización XLM/USDC del DEX.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function cached(ttlMs, fn) {
  const store = new Map();
  return async (key = "") => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await fn(key);
    store.set(key, { at: Date.now(), value });
    return value;
  };
}

/**
 * @param {{ server: import("@stellar/stellar-sdk").rpc.Server }} chain
 * @param {{ horizonUrl: string, fetchImpl?: typeof fetch }} opts
 */
export function createDataSources(chain, { horizonUrl, fetchImpl = fetch }) {
  const network = cached(10_000, async () => {
    const [latest, fees, info] = await Promise.all([
      chain.server.getLatestLedger(),
      chain.server.getFeeStats(),
      chain.server.getNetwork(),
    ]);
    const sf = fees.sorobanInclusionFee;
    return {
      latestLedger: latest.sequence,
      protocolVersion: latest.protocolVersion ?? info.protocolVersion,
      passphrase: info.passphrase,
      sorobanInclusionFee: { p50: sf.p50, p90: sf.p90, max: sf.max, ledgerCount: sf.ledgerCount },
      classicInclusionFee: { p50: fees.inclusionFee.p50, p90: fees.inclusionFee.p90 },
    };
  });

  const book = cached(10_000, async () => {
    const u = new URL("/order_book", horizonUrl);
    u.searchParams.set("selling_asset_type", "native");
    u.searchParams.set("buying_asset_type", "credit_alphanum4");
    u.searchParams.set("buying_asset_code", "USDC");
    u.searchParams.set("buying_asset_issuer", USDC_ISSUER);
    u.searchParams.set("limit", "5");
    const r = await fetchImpl(u);
    if (!r.ok) throw new Error(`horizon order_book ${r.status}`);
    return r.json();
  });

  async function insight(topic = "network") {
    const n = await network();
    const p90 = Number(n.sorobanInclusionFee.p90);
    const busy = p90 > 1000;
    return {
      topic,
      insight:
        `Ledger ${n.latestLedger}, protocol ${n.protocolVersion}. Soroban inclusion fee p50=${n.sorobanInclusionFee.p50} ` +
        `p90=${n.sorobanInclusionFee.p90} stroops: ${busy ? "busy network, bid at least p90" : "quiet network, p50 is enough"}.`,
      suggestedInclusionFeeStroops: busy ? n.sorobanInclusionFee.p90 : n.sorobanInclusionFee.p50,
      network: n,
    };
  }

  async function quote({ xlm } = {}) {
    const b = await book();
    const bid = b.bids?.[0] ? Number(b.bids[0].price) : null; // USDC por XLM que pagan
    const ask = b.asks?.[0] ? Number(b.asks[0].price) : null;
    const mid = bid && ask ? (bid + ask) / 2 : (bid ?? ask);
    const out = {
      pair: "XLM/USDC",
      venue: "Stellar DEX (testnet)",
      bestBid: bid,
      bestAsk: ask,
      mid,
      spreadBps: bid && ask ? Math.round(((ask - bid) / mid) * 10_000) : null,
      depth: { bids: (b.bids ?? []).slice(0, 5), asks: (b.asks ?? []).slice(0, 5) },
      at: new Date().toISOString(),
    };
    if (xlm && mid) out.estimateUsdcForXlm = { xlm: Number(xlm), usdc: Number((Number(xlm) * (bid ?? mid)).toFixed(7)) };
    return out;
  }

  return { insight, quote, network };
}
