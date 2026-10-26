// Config del agente: .env de la raíz (secretos) + deploy/*.json (IDs públicos), con
// override por variables de entorno. Nunca escribe secretos en archivos versionados.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Solo nombres explícitos (deploy/demo-register.json de la web tiene un "account" que
// no es la cuenta por defecto del agente).
const ALIASES = {
  PASSPORT_ACCOUNT_ID: ["PASSPORT_ACCOUNT_ID", "passportAccountId"],
  PASSPORT_FACTORY_ID: ["PASSPORT_FACTORY_ID", "passportFactoryId"],
};
const TXT = {
  "passport-account-agent42.txt": "PASSPORT_ACCOUNT_ID",
  "passport-factory.txt": "PASSPORT_FACTORY_ID",
};

function pick(obj, names) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const n of names) if (typeof obj[n] === "string" && obj[n]) return obj[n];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const hit = pick(v, names);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function readDeploy(dir = path.join(ROOT, "deploy")) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (TXT[f]) {
      const v = readFileSync(path.join(dir, f), "utf8").trim();
      if (/^C[A-Z2-7]{55}$/.test(v)) out[TXT[f]] = v;
      continue;
    }
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      for (const [k, names] of Object.entries(ALIASES)) {
        const v = pick(j, names);
        if (v) out[k] = v;
      }
    } catch {
      // json roto: lo ignoramos
    }
  }
  return out;
}

export function loadAgentConfig(env = process.env, { envFile = path.join(ROOT, ".env"), deployDir } = {}) {
  if (envFile && existsSync(envFile) && env === process.env) {
    // loadEnvFile no pisa variables ya definidas en el entorno.
    process.loadEnvFile(envFile);
  }
  const dep = readDeploy(deployDir);
  return {
    network: env.X402_NETWORK || "stellar:testnet",
    rpcUrl: env.RPC_URL || "https://soroban-testnet.stellar.org",
    horizonUrl: env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    serverUrl: (env.AGENT_SERVER_URL || `http://127.0.0.1:${env.PORT || 4021}`).replace(/\/$/, ""),
    accountId: env.PASSPORT_ACCOUNT_ID || dep.PASSPORT_ACCOUNT_ID,
    factoryId: env.PASSPORT_FACTORY_ID || dep.PASSPORT_FACTORY_ID,
    agentSecret: env.AGENT_SECRET,
    ownerSecret: env.OWNER_SECRET,
    asset: env.USDC_SAC || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    validatorId: env.VALIDATOR_ID || "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA",
    agentId: env.AGENT_ID || "42",
  };
}
