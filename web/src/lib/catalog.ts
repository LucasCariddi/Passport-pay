// Catálogo de servicios pagos: lo lee del servidor x402 (GET /catalog, gratis) y
// cruza los pagos onchain de la cuenta con los precios para saber qué compró.
import { CONFIG } from "./config";
import { parseUsdc } from "./format";
import type { Movement } from "./account";

export interface CatalogService {
  id: string;
  name: string;
  summary: string;
  description: string;
  method: string;
  path: string;
  price: { usdc: string; base: string; kind: "fixed" | "range"; min?: string; max?: string; param?: string };
  network: string;
  payTo: string;
  asset: string;
  params: { name: string; optional?: boolean; description: string }[];
  exampleResponse: unknown;
}

export interface Catalog {
  network: string;
  payTo: string;
  asset: { code: string; contract: string; decimals: number };
  services: CatalogService[];
}

/** URL del servidor: VITE_API_URL o, si no está, el puerto por defecto en el mismo host. */
export const serverUrl = () => CONFIG.apiUrl || `${location.protocol}//${location.hostname}:4021`;

export async function fetchCatalog(signal?: AbortSignal): Promise<Catalog> {
  const r = await fetch(`${serverUrl()}/catalog`, { signal });
  if (!r.ok) throw new Error(`the server answered HTTP ${r.status}`);
  const j = (await r.json()) as Catalog;
  if (!Array.isArray(j?.services)) throw new Error("the answer has no services");
  return j;
}

/** Comando de la CLI del agente para comprar este servicio. */
export function agentCommand(s: CatalogService, account?: string): string {
  const parts = ["node agent/src/cli.mjs call", s.id];
  if (s.price.kind === "range") parts.push(`--amount ${s.price.min}`);
  if (account) parts.push(`--account ${account}`);
  if (CONFIG.apiUrl && CONFIG.apiUrl !== "http://127.0.0.1:4021") parts.push(`--server ${CONFIG.apiUrl}`);
  return parts.join(" ");
}

export interface Purchase {
  movement: Movement;
  service: CatalogService | null;
}

/**
 * Pagos de la cuenta al comercio del catálogo, con el servicio que corresponde al
 * monto. El pago onchain no dice la ruta: se deduce por precio (fijo primero, después
 * el rango del precio elegido por el agente).
 */
export function matchPurchases(movements: Movement[], catalog: Catalog): Purchase[] {
  const fixed = catalog.services.filter((s) => s.price.kind === "fixed");
  const ranged = catalog.services.filter((s) => s.price.kind === "range");
  return movements
    .filter((m) => m.kind === "pago" && m.to === catalog.payTo)
    .map((m) => {
      const amount = BigInt(m.amount);
      let service = fixed.find((s) => BigInt(s.price.base) === amount) ?? null;
      if (!service)
        service =
          ranged.find((s) => {
            try {
              return amount >= parseUsdc(s.price.min ?? s.price.usdc) && amount <= parseUsdc(s.price.max ?? s.price.usdc);
            } catch {
              return false;
            }
          }) ?? null;
      return { movement: m, service };
    });
}
