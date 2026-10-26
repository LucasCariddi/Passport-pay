#!/usr/bin/env node
// Prueba de punta a punta del panel contra testnet, en Chromium headless.
//
// Qué hace, todo con transacciones reales y hashes:
//  1. Levanta Vite con VITE_E2E_SIGNER=1 y abre el panel.
//  2. "Conecta" un firmante de prueba: Playwright expone una función que firma
//     en Node con OWNER_SECRET del .env de la raíz (la clave nunca entra al bundle).
//  3. Genera la prueba ZK del pasaporte EN EL NAVEGADOR y la registra con
//     verify_and_register firmado (o PassportFactory.register si está configurada).
//  4. Si no hay factory: despliega una PassportAccount para el agente nuevo
//     (lo que va a hacer la factory) y la opera desde la UI: depósito, set_cap,
//     revoke y reactivación. No toca la cuenta del agente #42.
//  5. Abre la cuenta del agente #42 y verifica que la tabla de pagos lee eventos.
//  6. Capturas de escritorio y móvil en web/e2e/out/.
//
// Uso: pnpm e2e            (todo)
//      pnpm e2e --only-prove   (solo la prueba en el navegador, sin escribir en la red)
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "vite";
import { chromium } from "playwright";
import {
  Address,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

const WEB = resolve(import.meta.dirname, "..");
const OUT = resolve(WEB, "e2e/out");
const ONLY_PROVE = process.argv.includes("--only-prove");
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- entorno
function loadEnv(file) {
  const env = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* sin archivo */
  }
  return env;
}
const ENV = { ...loadEnv(resolve(WEB, "../.env")), ...process.env };
const PASS = "Test SDF Network ; September 2015";
const RPC = ENV.RPC_URL || "https://soroban-testnet.stellar.org";
const USDC = ENV.USDC_SAC || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const VALIDATOR = ENV.VALIDATOR_ID || "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA";
const WASM_HASH = ENV.PASSPORT_ACCOUNT_WASM_HASH || "64a3db9529560c724756e8321e85822a5c4711d87188062576f7074e42fa2767";
// Cuenta con pagos x402 reales del spike, para la tabla de pagos (solo lectura).
const ACCOUNT_42 = ENV.PASSPORT_ACCOUNT_SPIKE_ID || "CBIRF3XX45F2I356XLDDALKSKQWRXMUNFVBF7A65TRSEWXVXHRYP56VS";
// --no-factory fuerza el camino viejo (verify_and_register directo + deploy aparte).
if (process.argv.includes("--no-factory")) process.env.VITE_PASSPORT_FACTORY_ID = "";
if (!ONLY_PROVE && !ENV.OWNER_SECRET) throw new Error("Falta OWNER_SECRET en ../.env (scripts/gen-keys.sh)");
const owner = ENV.OWNER_SECRET ? Keypair.fromSecret(ENV.OWNER_SECRET) : Keypair.random();
const agentPublic = ENV.AGENT_PUBLIC;
const server = new rpc.Server(RPC);

const evidence = { startedAt: new Date().toISOString(), owner: owner.publicKey(), txs: {} };
const log = (...a) => console.log("[e2e]", ...a);

// ---------------------------------------------------------------- vite
process.env.VITE_E2E_SIGNER = "1";
const vite = await createServer({ root: WEB, configFile: resolve(WEB, "vite.config.ts"), server: { port: 5179, host: "127.0.0.1", strictPort: false }, logLevel: "warn" });
await vite.listen();
const base = vite.resolvedUrls.local[0].replace(/\/$/, "");
log("vite en", base);

// Si el Chromium de esta versión de Playwright no está bajado, se puede usar
// otro con PW_CHROMIUM=/ruta/al/chrome-headless-shell.
const browser = await chromium.launch(ENV.PW_CHROMIUM ? { executablePath: ENV.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") log("consola:", m.text().slice(0, 300));
});
page.on("pageerror", (e) => log("pageerror:", e.message));
page.on("dialog", (d) => d.accept());

let signCount = 0;
await page.exposeFunction("__ppSignNode", async (txXdr) => {
  const tx = TransactionBuilder.fromXDR(txXdr, PASS);
  tx.sign(owner);
  signCount++;
  return tx.toXDR();
});
await page.addInitScript((address) => {
  window.__ppTestSigner = { address: async () => address, sign: (x) => window.__ppSignNode(x) };
}, owner.publicKey());

async function waitTx(locatorRoot, label) {
  const ok = locatorRoot.locator(".note.ok[data-tx]");
  const err = locatorRoot.locator(".note.err");
  await Promise.race([ok.first().waitFor({ timeout: 120_000 }), err.first().waitFor({ timeout: 120_000 })]);
  if (await err.count()) throw new Error(`${label}: ${await err.first().innerText()}`);
  const hash = await ok.first().getAttribute("data-tx");
  evidence.txs[label] = hash;
  log(`${label}: ${hash}`);
  return hash;
}

try {
  // ------------------------------------------------------------ 1. prueba ZK en el navegador
  await page.goto(`${base}/#mint`);
  if (!ONLY_PROVE) {
    await page.getByTestId("connect").click();
    await page.getByTestId("wallet-address").waitFor();
  }
  await page.getByTestId("tab-mint").click();
  await page.locator('input[name="passportCap"]').fill("50");
  await page.getByTestId("prove").click();
  const proofBox = page.getByTestId("proof");
  await proofBox.waitFor({ timeout: 180_000 });
  const agentId = await proofBox.getAttribute("data-agent-id");
  const provingText = await page.getByTestId("proving-ms").innerText();
  evidence.proof = { agentId, proving: provingText };
  log(`prueba generada en el navegador: agente #${agentId}, ${provingText}`);
  await page.screenshot({ path: resolve(OUT, "1-prueba.png"), fullPage: true });

  if (ONLY_PROVE) throw Object.assign(new Error("only-prove"), { done: true });

  // ------------------------------------------------------------ 2. registro onchain firmado
  const mint = page.locator("#mint");
  const keyInput = mint.locator('input[name="agentKey"]');
  if (await keyInput.count()) {
    // Con factory: clave del agente y tope inicial van en la misma tx.
    evidence.via = "factory";
    await keyInput.fill(agentPublic);
    await mint.locator('input[name="initialCap"]').fill("0,03");
  } else {
    evidence.via = "validator";
  }
  await page.getByTestId("register").click();
  await waitTx(mint, evidence.via === "factory" ? "factory.register" : "verify_and_register");
  await page.getByTestId("registered").waitFor();
  log("validador:", (await page.getByTestId("registered").innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: resolve(OUT, "2-registrado.png"), fullPage: true });

  // ------------------------------------------------------------ 3. cuenta para el agente nuevo
  let account = null;
  const openBtn = page.locator('[data-testid="registered"] button');
  if (await openBtn.count()) {
    await openBtn.click(); // vino de la factory
    account = new URL(page.url()).searchParams.get("account");
  } else {
    if (!agentPublic) throw new Error("Falta AGENT_PUBLIC en ../.env");
    log("sin factory: despliego una PassportAccount para el agente", agentId);
    const src = await server.getAccount(owner.publicKey());
    const op = Operation.createCustomContract({
      address: Address.fromString(owner.publicKey()),
      wasmHash: Buffer.from(WASM_HASH, "hex"),
      salt: randomBytes(32),
      constructorArgs: [
        Address.fromString(owner.publicKey()).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(StrKey.decodeEd25519PublicKey(agentPublic))),
        Address.fromString(VALIDATOR).toScVal(),
        nativeToScVal(BigInt(agentId), { type: "u256" }),
        Address.fromString(USDC).toScVal(),
        nativeToScVal(300_000n, { type: "i128" }), // 0,03 USDC
        nativeToScVal(720, { type: "u32" }), // ~1 hora
      ],
    });
    const tx = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(owner);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error("deploy rechazado " + JSON.stringify(sent.errorResult));
    const done = await server.pollTransaction(sent.hash, { attempts: 40, sleepStrategy: () => 1500 });
    if (done.status !== "SUCCESS") throw new Error(`deploy ${sent.hash}: ${done.status}`);
    account = Address.fromScVal(done.returnValue).toString();
    evidence.txs.deploy_account = sent.hash;
    log(`deploy de PassportAccount ${account}: ${sent.hash}`);
    await page.goto(`${base}/?account=${account}`);
    await page.getByTestId("connect").click();
    await page.getByTestId("wallet-address").waitFor();
  }
  evidence.account = account;

  const badge = page.locator("#cuenta .badge");
  await badge.waitFor({ timeout: 60_000 });
  log("estado de la cuenta nueva:", await badge.getAttribute("data-state"));

  // ------------------------------------------------------------ 4. depósito, tope, revocar, reactivar
  const dep = page.locator("#deposito");
  await dep.locator('input[name="amount"]').fill("0,05");
  await dep.locator('button[type="submit"]').click();
  await waitTx(dep, "deposit");

  const capCard = page.locator("#tope");
  await capCard.locator('input[name="cap"]').fill("0,04");
  await capCard.locator('select[name="period"]').selectOption("17280");
  await capCard.locator('button[type="submit"]').click();
  await waitTx(capCard, "set_cap");

  const acc = page.locator("#acceso");
  await acc.getByRole("button", { name: "Revoke agent" }).click();
  await waitTx(acc, "revoke");
  await page.locator('#cuenta [data-state="revocada"]').waitFor({ timeout: 30_000 });
  log("badge tras revocar: revocada");
  await page.screenshot({ path: resolve(OUT, "3-revocada.png"), fullPage: true });

  await acc.getByRole("button", { name: "Reactivate with the same key" }).click();
  // El TxNote anterior se reemplaza al arrancar la acción nueva.
  await acc.locator(".note.busy").first().waitFor({ timeout: 10_000 }).catch(() => {});
  await waitTx(acc, "set_agent_key (reactivar)");
  await page.locator('#cuenta .badge[data-state="activa"]').waitFor({ timeout: 30_000 });
  log("badge tras reactivar: activa");
  evidence.spentText = await page.getByTestId("spent").innerText();

  // ------------------------------------------------------------ 5. pagos del agente #42 (solo lectura)
  await page.goto(`${base}/?account=${ACCOUNT_42}`);
  await page.locator("#cuenta .badge").waitFor({ timeout: 60_000 });
  const moves = page.getByTestId("movements");
  await moves.waitFor({ timeout: 120_000 });
  const rows = await moves.locator("li").count();
  const pagos = await moves.locator("li.pago").count();
  evidence.account42 = { rows, pagos, hint: await page.locator("#pagos .hint").innerText() };
  log(`cuenta #42: ${rows} movimientos (${pagos} pagos). ${evidence.account42.hint}`);
  await page.screenshot({ path: resolve(OUT, "4-cuenta-42.png"), fullPage: true });

  // ------------------------------------------------------------ 6. móvil
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await mobile.newPage();
  await mp.goto(`${base}/?account=${ACCOUNT_42}`);
  await mp.getByTestId("movements").waitFor({ timeout: 120_000 });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  evidence.mobileOverflowPx = overflow;
  log("desborde horizontal en móvil (px):", overflow);
  await mp.screenshot({ path: resolve(OUT, "5-movil.png"), fullPage: true });
  await mobile.close();

  evidence.ok = true;
} catch (e) {
  if (e.done) {
    evidence.ok = true;
  } else {
    evidence.ok = false;
    evidence.error = String(e?.message ?? e);
    log("FALLÓ:", evidence.error);
    await page.screenshot({ path: resolve(OUT, "error.png"), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  }
} finally {
  evidence.signatures = signCount;
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
  log("evidencia en", resolve(OUT, "evidence.json"));
  await browser.close();
  await vite.close();
}
