import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// IDs públicos que la web toma del .env de la raíz (lo escriben los scripts de
// deploy), para no duplicarlos. Es una lista cerrada: ningún *_SECRET entra al
// bundle. Un VITE_* puesto a mano en web/.env.local tiene prioridad.
const PUBLIC_FROM_ROOT: Record<string, string> = {
  PASSPORT_FACTORY_ID: "VITE_PASSPORT_FACTORY_ID",
  PASSPORT_ACCOUNT_ID: "VITE_PASSPORT_ACCOUNT_ID",
  USDC_SAC: "VITE_USDC_SAC",
  VALIDATOR_ID: "VITE_VALIDATOR_ID",
  RPC_URL: "VITE_RPC_URL",
  MERCHANT_PUBLIC: "VITE_READ_SOURCE",
};
// Último recurso: los IDs versionados en deploy/*.txt. Un .env recién generado por
// scripts/gen-keys.sh trae solo claves, y sin esto la web quedaba sin factory.
const DEPLOY_TXT: Record<string, string> = {
  PASSPORT_FACTORY_ID: "passport-factory.txt",
};
// La cuenta que abre la web por defecto es la de demo pública (wasm b9dfc7c6). Gana sobre
// PASSPORT_ACCOUNT_ID del .env raíz, que suele ser la del #42 (wasm viejo 72f52276, bloqueable
// por terceros). Un VITE_PASSPORT_ACCOUNT_ID explícito sigue ganando sobre esto.
function demoPublicAccount(): string | undefined {
  const f = resolve(import.meta.dirname, "../deploy/demo-public.json");
  if (!existsSync(f)) return undefined;
  try {
    const v = String(JSON.parse(readFileSync(f, "utf8")).account ?? "");
    return /^C[A-Z2-7]{55}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
function deployTxt(key: string): string | undefined {
  const name = DEPLOY_TXT[key];
  if (!name) return undefined;
  const f = resolve(import.meta.dirname, "../deploy", name);
  if (!existsSync(f)) return undefined;
  const v = readFileSync(f, "utf8").trim();
  return /^C[A-Z2-7]{55}$/.test(v) ? v : undefined;
}
function publicRootEnv(mode: string): Record<string, string> {
  const root = loadEnv(mode, resolve(import.meta.dirname, ".."), "");
  const web = loadEnv(mode, import.meta.dirname, "VITE_");
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(PUBLIC_FROM_ROOT)) {
    // `??`: un VITE_* vacío a propósito (p. ej. e2e --no-factory) no cae al deploy.
    const demo = from === "PASSPORT_ACCOUNT_ID" ? demoPublicAccount() : undefined;
    const v = process.env[to] ?? web[to] ?? demo ?? root[from] ?? deployTxt(from);
    if (v && !/SECRET/i.test(from)) out[`import.meta.env.${to}`] = JSON.stringify(v);
  }
  return out;
}

// Artefactos ZK de open-stellar-passport (Apache-2.0), copiados en vendor/osp/zk.
// No se duplican en web/public: este plugin los sirve en /zk/* durante el dev y
// los emite en dist/zk/ al compilar.
const ZK_DIR = resolve(import.meta.dirname, "../vendor/osp/zk");
const ZK_FILES = [
  "agent_passport.wasm",
  "agent_passport_final.zkey",
  "passport_witness.wasm",
  "verification_key.json",
];

function osspZkArtifacts(): Plugin {
  return {
    name: "osp-zk-artifacts",
    configureServer(server) {
      server.middlewares.use("/zk", (req, res, next) => {
        const name = (req.url ?? "").replace(/^\//, "").split("?")[0];
        if (!ZK_FILES.includes(name)) return next();
        const file = join(ZK_DIR, name);
        if (!existsSync(file)) return next();
        res.setHeader(
          "Content-Type",
          name.endsWith(".json") ? "application/json" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
        );
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const name of readdirSync(ZK_DIR)) {
        if (!ZK_FILES.includes(name)) continue;
        this.emitFile({ type: "asset", fileName: `zk/${name}`, source: readFileSync(join(ZK_DIR, name)) });
      }
    },
  };
}

// vendor/osp queda sin modificar en disco (librería previa). Su prover trae un mensaje con
// raya larga (U+2014); al compilar se cambia por dos puntos para que no llegue al bundle.
// La web además traduce ese error al castellano (lib/passport.ts).
function ospProverText(): Plugin {
  const dash = String.fromCharCode(0x2014);
  return {
    name: "osp-prover-text",
    transform(code, id) {
      if (!id.replace(/\\/g, "/").endsWith("vendor/osp/sdk/src/prover.ts") || !code.includes(dash)) return null;
      return { code: code.split(` ${dash} `).join(": ").split(dash).join("-"), map: null };
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), osspZkArtifacts(), ospProverText()],
  // En el deploy único de Vercel la app vive en /app/ (WEB_BASE=/app/, ver docs/DEPLOY.md).
  // Los artefactos ZK se piden con import.meta.env.BASE_URL, así que siguen el prefijo.
  base: process.env.WEB_BASE || "/",
  // Lee VITE_* de web/.env (o web/.env.local). Nunca poner secretos acá: todo
  // lo que empieza con VITE_ termina en el bundle público.
  envDir: import.meta.dirname,
  resolve: {
    // vendor/osp/sdk/src/prover.ts importa "snarkjs" desde fuera de web/: se
    // resuelve contra las dependencias de este paquete.
    alias: [{ find: /^snarkjs$/, replacement: resolve(import.meta.dirname, "node_modules/snarkjs/build/browser.esm.js") }],
  },
  define: { global: "globalThis", ...publicRootEnv(mode) },
  server: { host: "0.0.0.0", port: 5173, fs: { allow: [resolve(import.meta.dirname, "..")] } },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
}));
