#!/usr/bin/env node
// Servidor x402 de Passport Pay. Ver docs/ARCHITECTURE.md (sección 4.4).
//   node server/src/index.mjs            (lee .env de la raíz y deploy/*.json si existe)
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApp, createRecentLog } from "./app.mjs";
import { contractLink, createChain, TESTNET_PASSPHRASE } from "./chain.mjs";
import { loadConfig, loadEnvFile } from "./config.mjs";
import { createDataSources } from "./data.mjs";
import { createOfficialFacilitator, createPassportFacilitatorClient } from "./facilitator.mjs";
import { mountDemo } from "./demo.mjs";
import { mountInject } from "./inject.mjs";

/**
 * Arma la app de Express sin hacer `listen`. La usa startServer() (local) y la función de
 * Vercel (api/index.mjs), que exporta la app como handler. Ver docs/DEPLOY.md.
 */
export function buildServerApp({ env = process.env, log = console.log } = {}) {
  const cfg = loadConfig(env);
  const chain = createChain({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: TESTNET_PASSPHRASE,
    asset: cfg.asset,
    factoryId: cfg.factoryId,
    accountWasmHashes: cfg.accountWasmHashes,
    validatorId: cfg.validatorId,
  });
  const recent = createRecentLog();
  const inner = createOfficialFacilitator(cfg);
  const facilitator = createPassportFacilitatorClient({
    inner: {
      verify: (p, r) => inner.verify(p, r),
      settle: (p, r) => inner.settle(p, r),
      getSupported: async () => inner.getSupported(),
    },
    chain,
    networkPassphrase: TESTNET_PASSPHRASE,
    log,
    record: (r) => recent.push(r),
  });
  const data = createDataSources(chain, { horizonUrl: cfg.horizonUrl });
  const app = createApp({ cfg, chain, facilitator, data, recent, log });
  // Detrás del proxy de Vercel: req.protocol sale de X-Forwarded-Proto, así el `resource.url`
  // del 402 dice https:// y no http://.
  if (env.VERCEL) app.set("trust proxy", true);
  // "Probar como agente" (POST /api/demo/pay, GET /api/demo/status). Ver server/src/demo.mjs.
  const { demo, mutex } = mountDemo({ app, cfg, chain, env, log });
  // Fire test (GET/POST /api/demo/inject), same mutex as the demo. See server/src/inject.mjs.
  mountInject({ app, cfg, chain, demo, mutex, env, log });
  return { app, cfg };
}

export async function startServer({ env = process.env, port, host, log = console.log } = {}) {
  const { app, cfg } = buildServerApp({ env, log });
  const srv = await new Promise((resolve, reject) => {
    const s = app.listen(port ?? cfg.port, host ?? cfg.host, () => resolve(s));
    s.on("error", reject);
  });
  const { address, port: p } = srv.address();
  log(`Passport Pay server en http://${address}:${p}  (red ${cfg.network})`);
  log(`  payTo ${cfg.payTo}  asset ${contractLink(cfg.asset)}`);
  log(`  precios: insight $${cfg.prices.insight}, quote $${cfg.prices.quote}, report ?usd=[${cfg.prices.reportMin}, ${cfg.prices.reportMax}]`);
  log(
    `  admisión: ${cfg.factoryId ? `factory ${cfg.factoryId} o ` : ""}wasm de PassportAccount [${cfg.accountWasmHashes.join(", ") || "ninguno"}] con validador ${cfg.validatorId}`,
  );
  if (cfg.deployFiles.length) log(`  IDs leídos de deploy/: ${cfg.deployFiles.join(", ")}`);
  return { srv, app, cfg, url: `http://${address}:${p}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadEnvFile();
  startServer().catch((e) => {
    console.error("no pude arrancar el servidor:", e.message);
    process.exit(1);
  });
}
