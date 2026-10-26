// GET /catalog: gratis, y derivado de la misma config de precios que cobra x402.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createApp, createRecentLog } from "../src/app.mjs";
import { buildCatalog, CATALOG_META, usdcToBase } from "../src/catalog.mjs";
import { createPassportFacilitatorClient } from "../src/facilitator.mjs";
import { fakeChain, fakeData, fakeInnerFacilitator, listen, NETWORK, PASS, PAY_TO, testConfig, USDC } from "./helpers.mjs";

function build(cfgExtra) {
  const chain = fakeChain();
  const inner = fakeInnerFacilitator();
  const recent = createRecentLog();
  const facilitator = createPassportFacilitatorClient({ inner: inner.client, chain, networkPassphrase: PASS, log: () => {}, record: () => {} });
  return createApp({ cfg: testConfig(cfgExtra), chain, facilitator, data: fakeData, recent, log: () => {} });
}

describe("GET /catalog", () => {
  let s;
  before(async () => (s = await listen(build())));
  after(() => s.close());

  test("es gratis y lista los tres servicios pagos", async () => {
    for (const p of ["/catalog", "/api/catalog"]) {
      const r = await fetch(s.url + p);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("payment-required"), null);
      const j = await r.json();
      assert.equal(j.network, NETWORK);
      assert.equal(j.payTo, PAY_TO);
      assert.equal(j.asset.contract, USDC);
      assert.deepEqual(j.services.map((x) => x.id), ["insight", "quote", "report"]);
      for (const x of j.services) {
        assert.equal(x.method, "GET");
        assert.match(x.path, /^\/api\/premium\//);
        assert.equal(x.network, NETWORK);
        assert.equal(x.payTo, PAY_TO);
        assert.ok(x.name && x.summary && x.description);
        assert.ok(x.exampleResponse);
      }
    }
  });

  test("el precio del catálogo es el mismo que pide el 402", async () => {
    const j = await (await fetch(s.url + "/catalog")).json();
    for (const x of j.services) {
      const r = await fetch(s.url + x.path);
      assert.equal(r.status, 402);
      const req = decodePaymentRequiredHeader(r.headers.get("payment-required")).accepts[0];
      assert.equal(req.amount, x.price.base, `${x.id}: catálogo ${x.price.base} vs 402 ${req.amount}`);
      assert.equal(req.payTo, x.payTo);
      assert.equal(req.network, x.network);
      assert.equal(req.asset, x.asset);
    }
    const report = j.services.find((x) => x.id === "report");
    assert.deepEqual([report.price.kind, report.price.min, report.price.max], ["range", "0.05", "100"]);
  });
});

describe("catálogo sin precios duplicados", () => {
  test("si cambia la config de precios, cambia el catálogo", async () => {
    const s = await listen(build({ prices: { insight: "0.03", quote: "0.5", reportMin: "1", reportMax: "2" } }));
    try {
      const j = await (await fetch(s.url + "/catalog")).json();
      const by = Object.fromEntries(j.services.map((x) => [x.id, x.price]));
      assert.equal(by.insight.usdc, "0.03");
      assert.equal(by.quote.usdc, "0.5");
      assert.equal(by.report.min, "1");
      assert.equal(by.report.max, "2");
    } finally {
      await s.close();
    }
  });

  test("una ruta paga sin texto en CATALOG_META igual aparece", () => {
    const routes = { "GET /api/premium/nueva": { accepts: { scheme: "exact", price: "$0.07", network: NETWORK, payTo: PAY_TO }, description: "algo" } };
    const c = buildCatalog(routes, testConfig());
    assert.equal(c.services[0].id, "nueva");
    assert.equal(c.services[0].price.base, "700000");
    assert.equal(c.services[0].summary, "algo");
  });

  test("usdcToBase", () => {
    assert.equal(usdcToBase("0.01"), "100000");
    assert.equal(usdcToBase("1"), "10000000");
    assert.equal(usdcToBase("0.0000001"), "1");
    assert.equal(Object.keys(CATALOG_META).length, 3);
  });
});
