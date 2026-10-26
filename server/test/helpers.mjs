// Mocks compartidos por los tests del servidor. Nada acá toca la red.
import { Account, Keypair, nativeToScVal, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";

export const NETWORK = "stellar:testnet";
export const PASS = "Test SDF Network ; September 2015";
export const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const PAY_TO = Keypair.random().publicKey();
export const GOOD = StrKey.encodeContract(Buffer.alloc(32, 7));
export const BAD = StrKey.encodeContract(Buffer.alloc(32, 9));

/** XDR de una tx SAC.transfer(from, to, amount), armada offline (sin RPC). */
export function transferXdr({ from, to, amount, asset = USDC }) {
  const src = new Account(Keypair.random().publicKey(), "1");
  return new TransactionBuilder(src, { fee: "100", networkPassphrase: PASS })
    .addOperation(
      Operation.invokeContractFunction({
        contract: asset,
        function: "transfer",
        args: [nativeToScVal(from, { type: "address" }), nativeToScVal(to, { type: "address" }), nativeToScVal(BigInt(amount), { type: "i128" })],
      }),
    )
    .setTimeout(60)
    .build()
    .toXDR();
}

/** Esquema cliente x402 falso: firma "de mentira" pagando desde `from`. */
export function fakeClientScheme(from) {
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version, req) {
      return { x402Version, payload: { transaction: transferXdr({ from, to: req.payTo, amount: req.amount, asset: req.asset }) } };
    },
  };
}

/**
 * Facilitador oficial de x402 (x402Facilitator) con un esquema falso adentro: así
 * getSupported tiene la forma real. `behavior` decide verify/settle.
 */
export function fakeInnerFacilitator(behavior = {}) {
  const calls = { verify: 0, settle: 0, settleSpans: [] };
  let n = 0;
  const scheme = {
    scheme: "exact",
    caipFamily: "stellar:*",
    getExtra: () => ({ areFeesSponsored: true }),
    getSigners: () => [Keypair.random().publicKey()],
    async verify(payload, req) {
      calls.verify++;
      if (behavior.verify) return behavior.verify(payload, req);
      return { isValid: true, payer: "x" };
    },
    async settle(payload, req) {
      calls.settle++;
      const span = { start: Date.now() };
      await new Promise((ok) => setTimeout(ok, behavior.settleDelayMs ?? 0));
      span.end = Date.now();
      calls.settleSpans.push(span);
      if (behavior.settle) return behavior.settle(payload, req, n++);
      const tx = (++n).toString(16).padStart(64, "a");
      return { success: true, transaction: tx, network: req.network, payer: "x" };
    },
  };
  const f = new x402Facilitator().register(NETWORK, scheme);
  return {
    calls,
    client: { verify: (p, r) => f.verify(p, r), settle: (p, r) => f.settle(p, r), getSupported: async () => f.getSupported() },
  };
}

export function fakeChain(overrides = {}) {
  return {
    server: {},
    isPassportAccount: async (a) => ({ ok: a === GOOD, via: "mock" }),
    simulationError: async () => "HostError: Error(Auth, InvalidAction) ... failed account authentication with error, C..., Error(Contract, #6)",
    getAccountView: async (id) => ({ id, config: { cap: "500000" }, spendStatus: { remaining: "100000" }, balance: "1000000" }),
    getPayments: async (q) => [{ tx: "ff", query: q }],
    ...overrides,
  };
}

export const fakeData = {
  insight: async (topic) => ({ topic, insight: "red tranquila" }),
  quote: async () => ({ pair: "XLM/USDC", bestBid: 0.25, bestAsk: 0.88, mid: 0.56 }),
};

export function testConfig(extra = {}) {
  return {
    network: NETWORK,
    payTo: PAY_TO,
    asset: USDC,
    facilitatorPublic: "GFAC",
    corsOrigin: "*",
    accountWasmHashes: ["aa"],
    prices: { insight: "0.01", quote: "0.02", reportMin: "0.05", reportMax: "100" },
    ...extra,
  };
}

export async function listen(app) {
  const srv = await new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  return { srv, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((ok) => srv.close(ok)) };
}
