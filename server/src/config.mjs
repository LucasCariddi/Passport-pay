// Configuracion del servidor: .env de la raiz + IDs de /deploy (si existen).
// Los secretos se leen SOLO del entorno (.env o variables), nunca de archivos versionados.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Nombres aceptados en deploy/*.json para cada variable. Solo nombres explícitos: un
// json de otra herramienta (p. ej. deploy/demo-register.json de la web) puede tener un
// campo "account" que NO es la cuenta del agente por defecto.
const DEPLOY_ALIASES = {
  PASSPORT_FACTORY_ID: ["PASSPORT_FACTORY_ID", "passportFactoryId"],
  PASSPORT_ACCOUNT_ID: ["PASSPORT_ACCOUNT_ID", "passportAccountId"],
  PASSPORT_ACCOUNT_WASM_HASH: ["PASSPORT_ACCOUNT_WASM_HASH", "passportAccountWasmHash"],
};
// deploy/*.txt del frente de contratos: un valor por archivo.
export const DEPLOY_TXT = {
  "passport-factory.txt": "PASSPORT_FACTORY_ID",
  "passport-account-agent42.txt": "PASSPORT_ACCOUNT_ID",
  "passport-account.wasm-hash.txt": "PASSPORT_ACCOUNT_WASM_HASH",
};

function pick(obj, names) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null && obj[n] !== "") return String(obj[n]);
  }
  // un nivel de anidamiento (p. ej. { contracts: { factory: "C..." } })
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const hit = pick(v, names);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Lee deploy/*.json y deploy/*.env. Devuelve { values, files }. */
export function readDeployDir(dir = path.join(ROOT, "deploy")) {
  const values = {};
  const files = [];
  if (!existsSync(dir)) return { values, files };
  for (const f of readdirSync(dir).sort()) {
    const full = path.join(dir, f);
    try {
      if (DEPLOY_TXT[f]) {
        const v = readFileSync(full, "utf8").trim();
        if (/^[A-Za-z0-9]+$/.test(v)) values[DEPLOY_TXT[f]] = v;
        files.push(f);
      } else if (f.endsWith(".json")) {
        const j = JSON.parse(readFileSync(full, "utf8"));
        let hit = false;
        for (const [k, names] of Object.entries(DEPLOY_ALIASES)) {
          const v = pick(j, names);
          if (v) {
            values[k] = v;
            hit = true;
          }
        }
        if (hit) files.push(f);
      } else if (f.endsWith(".env")) {
        for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
          const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
          if (m && DEPLOY_ALIASES[m[1]] && m[2] && !/SECRET/.test(m[1])) values[m[1]] = m[2].replace(/^"|"$/g, "");
        }
        files.push(f);
      }
    } catch {
      // archivo de deploy ilegible: se ignora, el .env manda
    }
  }
  return { values, files };
}

export function loadEnvFile(file = path.join(ROOT, ".env")) {
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Config efectiva. `env` permite inyectar valores en tests. */
export function loadConfig(env = process.env, { deployDir } = {}) {
  const deploy = readDeployDir(deployDir);
  // Lo de /deploy pisa al .env solo si el .env no lo define, salvo DEPLOY_OVERRIDES=1.
  const prefer = env.DEPLOY_OVERRIDES === "1";
  const get = (k, d) => {
    const fromDeploy = deploy.values[k];
    if (prefer && fromDeploy) return fromDeploy;
    return env[k] || fromDeploy || d;
  };
  const network = env.X402_NETWORK || "stellar:testnet";
  if (network !== "stellar:testnet") throw new Error(`Passport Pay solo corre en stellar:testnet (X402_NETWORK=${network})`);
  return {
    network,
    rpcUrl: env.RPC_URL || "https://soroban-testnet.stellar.org",
    horizonUrl: env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    port: Number(env.PORT || 4021),
    host: env.HOST || "127.0.0.1",
    payTo: env.MERCHANT_PUBLIC,
    facilitatorSecret: env.FACILITATOR_SECRET,
    facilitatorPublic: env.FACILITATOR_PUBLIC,
    maxFeeStroops: Number(env.FACILITATOR_MAX_FEE_STROOPS || 100_000_000),
    asset: env.USDC_SAC || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    validatorId: env.VALIDATOR_ID || "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA",
    factoryId: get("PASSPORT_FACTORY_ID"),
    accountWasmHash: get("PASSPORT_ACCOUNT_WASM_HASH"),
    // Todos los wasm de PassportAccount aceptados (el del #42 y el que use la factory).
    accountWasmHashes: [...new Set(
      [env.PASSPORT_ACCOUNT_WASM_HASH, deploy.values.PASSPORT_ACCOUNT_WASM_HASH, ...(env.ACCOUNT_WASM_HASHES || "").split(",")]
        .map((s) => (s || "").trim().toLowerCase())
        .filter(Boolean),
    )],
    defaultAccountId: get("PASSPORT_ACCOUNT_ID"),
    prices: {
      insight: env.PRICE_INSIGHT_USD || env.PRICE_USD || "0.01",
      quote: env.PRICE_QUOTE_USD || "0.02",
      reportMin: env.PRICE_REPORT_MIN_USD || "0.05",
      reportMax: env.PRICE_REPORT_MAX_USD || "100",
    },
    corsOrigin: env.CORS_ORIGIN || "*",
    deployFiles: deploy.files,
  };
}
