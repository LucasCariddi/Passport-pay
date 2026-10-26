// Config of the Passport Pay MCP server. Everything comes from environment variables
// (set in the MCP client config: `claude mcp add ... -e ...` or `.mcp.json`).
//
// The agent key is NEVER read from an env var: only from a file (by default
// `.secrets/mcp-agent.json`, ignored by git). That keeps secrets out of `.mcp.json`,
// which people tend to commit.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_SERVER_URL = "https://passport-pay-stellar.vercel.app";
export const DEFAULT_SECRET_FILE = path.join(ROOT, ".secrets", "mcp-agent.json");
export const TESTNET = "stellar:testnet";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

const C_ADDR = /^C[A-Z2-7]{55}$/;
const S_KEY = /^S[A-Z2-7]{55}$/;

export class ConfigError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ConfigError";
  }
}

/**
 * Reads the agent secret file. Accepted formats:
 *  - a JSON object with `agentSecret` (and optionally `account`), like `.secrets/mcp-agent.json`
 *    or the `.secrets/demo-agent-<id>.json` files written by `register-demo.mjs`;
 *  - a plain text file whose only content is the `S...` secret.
 */
export function readSecretFile(file, { readFile = readFileSync, exists = existsSync } = {}) {
  if (!exists(file)) throw new ConfigError(`no existe el archivo de la clave del agente: ${file}`);
  const raw = String(readFile(file, "utf8")).trim();
  if (S_KEY.test(raw)) return { agentSecret: raw };
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new ConfigError(`el archivo ${file} no es JSON ni una clave S... sola`);
  }
  const agentSecret = j.agentSecret ?? j.secret;
  if (!S_KEY.test(String(agentSecret ?? ""))) throw new ConfigError(`el archivo ${file} no tiene un agentSecret S... válido`);
  return { agentSecret, account: j.account ?? j.passportAccountId };
}

export function loadConfig(env = process.env, io) {
  if (env.PASSPORT_AGENT_SECRET || env.AGENT_SECRET_INLINE) {
    throw new ConfigError("la clave del agente no se pasa por variable de entorno: usá PASSPORT_AGENT_SECRET_FILE");
  }
  const network = env.X402_NETWORK || TESTNET;
  if (network !== TESTNET) throw new ConfigError(`solo testnet: X402_NETWORK=${network} no está permitido`);

  const secretFile = path.resolve(ROOT, env.PASSPORT_AGENT_SECRET_FILE || DEFAULT_SECRET_FILE);
  const secret = readSecretFile(secretFile, io);
  const accountId = env.PASSPORT_ACCOUNT_ID || secret.account;
  if (!C_ADDR.test(String(accountId ?? ""))) {
    throw new ConfigError("falta la cuenta del agente: PASSPORT_ACCOUNT_ID=C... o `account` en el archivo de la clave");
  }
  let feePayerSecret = secret.agentSecret;
  if (env.PASSPORT_FEE_PAYER_SECRET_FILE) {
    feePayerSecret = readSecretFile(path.resolve(ROOT, env.PASSPORT_FEE_PAYER_SECRET_FILE), io).agentSecret;
  }

  const maxPerBuy = env.PASSPORT_PAY_MAX_PER_BUY_USDC || "1";
  if (!/^\d+(\.\d{1,7})?$/.test(maxPerBuy)) throw new ConfigError(`PASSPORT_PAY_MAX_PER_BUY_USDC inválido: ${maxPerBuy}`);

  return {
    network,
    networkPassphrase: TESTNET_PASSPHRASE,
    serverUrl: (env.PASSPORT_PAY_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/$/, ""),
    rpcUrl: env.RPC_URL || "https://soroban-testnet.stellar.org",
    asset: env.USDC_SAC || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    accountId,
    agentSecret: secret.agentSecret,
    feePayerSecret,
    secretFile,
    maxPerBuyUsdc: maxPerBuy,
  };
}
