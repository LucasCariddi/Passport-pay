#!/usr/bin/env node
// Passport Pay MCP server (stdio). Turns any MCP client (Claude Code, Claude Desktop, ...)
// into a Passport Pay buyer that pays from its own PassportAccount on stellar:testnet.
//
// stdout is the MCP protocol: logs go to stderr only.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.mjs";
import { createPassportPay, ToolInputError } from "./core.mjs";

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const reply = (summary, data, isError = false) => ({
  content: [{ type: "text", text: `${summary}\n\n${json(data)}` }],
  isError,
});

function describeContractError(ce) {
  if (!ce) return "";
  return `${ce.raw} ${ce.name}: ${ce.es}`;
}

export function summarizePay(r) {
  if (r.status === "SUCCESS") return `La red ACEPTÓ el pago: ${r.amountUsdc} USDC de ${r.from} a ${r.to}. Tx SUCCESS ${r.hash} (${r.link}).`;
  if (r.status === "FAILED") {
    const who = r.rejectedBy ?? "la red";
    return `La red RECHAZÓ el pago: tx FAILED ${r.hash} (${r.link}). Lo rechazó ${who}${r.contractError ? ` con ${describeContractError(r.contractError)}` : ""}. No se movió plata.`;
  }
  if (r.status === "NOT_SENT") return `No se mandó ninguna tx: ${r.error}`;
  return `Resultado de la red: ${r.status}${r.hash ? ` (${r.hash})` : ""}.`;
}

export function summarizeBuy(r) {
  if (r.paid) return `Compra pagada: ${r.priceUsdc ?? "?"} USDC por "${r.service}". Tx ${r.hash ?? "(sin hash)"}${r.link ? ` (${r.link})` : ""}.`;
  if (r.outcome === "free") return `"${r.service}" respondió sin pedir pago.`;
  if (r.contractError) return `Compra rechazada por ${r.rejectedBy}: ${describeContractError(r.contractError)}. No se movió plata.`;
  return `Compra no realizada (${r.outcome}): ${r.rejectedBy ?? r.reason ?? r.error ?? "sin detalle"}.`;
}

export function buildServer(pp) {
  const server = new McpServer({ name: "passport-pay", version: "0.1.0" });

  const run = (fn, summarize) => async (args) => {
    try {
      const r = await fn(args ?? {});
      return reply(summarize(r), r);
    } catch (e) {
      const kind = e instanceof ToolInputError ? "Entrada inválida" : "Error";
      return reply(`${kind}: ${e.message}`, { error: e.message }, true);
    }
  };

  server.registerTool(
    "list_services",
    {
      title: "Ver servicios pagos",
      description:
        "Lista los servicios de datos que vende el servidor Passport Pay (id, qué devuelve, precio en USDC y parámetros). Es gratis y no mueve plata. Usala antes de buy para saber qué id pedir.",
      inputSchema: {},
    },
    run(() => pp.listServices(), (r) => `${r.services.length} servicios en ${r.server}.`),
  );

  server.registerTool(
    "buy",
    {
      title: "Comprar un servicio",
      description:
        "Compra un servicio del catálogo de Passport Pay y devuelve la respuesta. Paga por x402 en USDC (stellar:testnet) desde la cuenta del agente y devuelve el hash de la tx. Si el pago no entra en el tope de la cuenta o la cuenta está revocada, la cuenta lo rechaza y no se cobra nada. `service` es el id de list_services (insight, quote, report). `params` son los parámetros del servicio, por ejemplo {\"topic\":\"fees\"} o, para report, {\"usd\":\"0.05\"}.",
      inputSchema: {
        service: z.string().describe("id del servicio, de list_services"),
        params: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("parámetros de query del servicio"),
      },
    },
    run((a) => pp.buy(a), summarizeBuy),
  );

  server.registerTool(
    "spend_status",
    {
      title: "Ver gasto y tope",
      description:
        "Muestra el estado de la cuenta del agente leído de la red: saldo en USDC, tope por período, cuánto gastó, cuánto le queda, cuándo se renueva el período y si el dueño la revocó. No mueve plata.",
      inputSchema: {},
    },
    run(
      () => pp.spendStatus(),
      (r) => `Saldo ${r.balanceUsdc} USDC. Tope ${r.capUsdc} USDC por período, gastado ${r.spentUsdc}, disponible ${r.remainingUsdc}.${r.revoked ? " La cuenta está REVOCADA." : ""}`,
    ),
  );

  server.registerTool(
    "pay",
    {
      title: "Transferir USDC",
      description:
        "Transfiere USDC desde la cuenta del agente a cualquier dirección Stellar (G... o C...) y manda la tx a la red. Usala solo si tu usuario te pidió ese pago. Devuelve siempre lo que dijo la red: SUCCESS con el hash, o FAILED con el hash y el error del contrato de la cuenta (por ejemplo Error(Contract, #6) si supera el tope o #1 si el dueño la revocó). Las reglas las aplica la cuenta en la red, no esta herramienta.",
      inputSchema: {
        to: z.string().describe("dirección de destino G... o C..."),
        amount_usdc: z.union([z.string(), z.number()]).describe("monto en USDC, hasta 7 decimales, p. ej. 0.05"),
        memo: z
          .string()
          .optional()
          .describe("nota corta opcional (hasta 28 bytes). Vuelve en la respuesta; no queda en la red porque Stellar no admite memo en txs de Soroban"),
      },
    },
    run((a) => pp.pay(a), summarizePay),
  );

  return server;
}

export async function main() {
  const cfg = loadConfig();
  const pp = createPassportPay(cfg);
  const server = buildServer(pp);
  await server.connect(new StdioServerTransport());
  console.error(`[passport-pay-mcp] listo: cuenta ${cfg.accountId}, servidor ${cfg.serverUrl}, ${cfg.network}`);
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`[passport-pay-mcp] no arrancó: ${e.message}`);
    process.exit(1);
  });
}
