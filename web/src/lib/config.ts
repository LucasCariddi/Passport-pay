// Configuración pública del panel. Todo sale de variables VITE_* (web/.env.local);
// los valores por defecto son los IDs de testnet de docs/ARCHITECTURE.md, sección 6.
// Nada de esto es secreto: lo que empieza con VITE_ termina en el bundle.

const env = import.meta.env;
const pick = (v: string | undefined, fallback: string) => (v ?? "").trim() || fallback;
// VITE_API_URL="same-origin" (o "/"): el servidor x402 corre en el mismo dominio que la
// web (deploy único en Vercel, ver docs/DEPLOY.md).
const apiBase = (v: string | undefined) => {
  const s = (v ?? "").trim();
  if (s === "same-origin" || s === "/") return typeof location !== "undefined" ? location.origin : "";
  return s.replace(/\/$/, "");
};

export const CONFIG = {
  networkPassphrase: pick(env.VITE_NETWORK_PASSPHRASE, "Test SDF Network ; September 2015"),
  rpcUrl: pick(env.VITE_RPC_URL, "https://soroban-testnet.stellar.org"),
  explorer: pick(env.VITE_EXPLORER_URL, "https://stellar.expert/explorer/testnet"),
  usdcSac: pick(env.VITE_USDC_SAC, "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"),
  validatorId: pick(env.VITE_VALIDATOR_ID, "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA"),
  // Vacío mientras PassportFactory no esté desplegada: en ese caso el alta del
  // pasaporte llama directo a verify_and_register del validador.
  factoryId: pick(env.VITE_PASSPORT_FACTORY_ID, ""),
  // Cuenta que se abre por defecto: la cuenta de demo pública (deploy/demo-public.json,
  // wasm b9dfc7c6 con lista de destinos, tope 0,05 USDC por ~1 h). No usar las cuentas del
  // wasm viejo 72f52276.
  defaultAccount: pick(env.VITE_PASSPORT_ACCOUNT_ID, "CADZU573AKZ7WV4T5TPZRJOMFA2VTU4PTLXHP27R7WWDYJ2J7PFKNWFF"),
  // Servidor x402 (opcional): si está, la tabla de pagos usa /api/payments y se
  // muestra el precio del endpoint. Si no, se leen los eventos directo del RPC.
  apiUrl: apiBase(env.VITE_API_URL),
  // Cuenta G existente usada como origen de las simulaciones de solo lectura
  // (no firma nada). Por defecto, el merchant del spike.
  readSource: pick(env.VITE_READ_SOURCE, "GCLNNJKDE7YK5BYOCIW3SOZW7NBPBCKPKXONLRYVUQRO5VZCGLVCVPPJ"),
  usdcDecimals: 7,
  secondsPerLedger: 5,
  // Solo para la prueba automática (e2e/mint-e2e.mjs): habilita un firmante
  // inyectado por Playwright en lugar de la wallet. Nunca en producción.
  e2eSigner: env.VITE_E2E_SIGNER === "1",
} as const;

export const txLink = (hash: string) => `${CONFIG.explorer}/tx/${hash}`;
export const contractLink = (id: string) => `${CONFIG.explorer}/contract/${id}`;
export const accountLink = (id: string) =>
  id.startsWith("C") ? contractLink(id) : `${CONFIG.explorer}/account/${id}`;
