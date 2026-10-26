// Prueba de "Probar como agente" en un navegador headless contra una URL real.
// Hace pagos REALES en testnet con la cuenta de demo pública (los firma el servidor).
// Uso: node e2e/agent-demo-smoke.mjs <url de /app/> [--shot out.png] [--no-force] [--mobile]
// Para un preview con Deployment Protection: VERCEL_BYPASS=<secreto> en el entorno (solo se
// manda a ese dominio, nunca a terceros como el RPC de Stellar).
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:/.test(a)) ?? "http://127.0.0.1:4173/";
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const shot = opt("--shot");
const noForce = argv.includes("--no-force");
const DASH = String.fromCharCode(0x2014);
const host = new URL(url).host;
const bypass = process.env.VERCEL_BYPASS;

const browser = await chromium.launch();
const mobile = argv.includes("--mobile");
const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
if (bypass) {
  await page.route("**/*", (route) => {
    const req = route.request();
    if (new URL(req.url()).host !== host) return route.continue();
    return route.continue({ headers: { ...req.headers(), "x-vercel-protection-bypass": bypass } });
  });
}
const t0 = Date.now();
const target = url.replace(/#.*$/, "") + "#probar";
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.getByTestId("demo-status").waitFor({ timeout: 60_000 });
const result = { url: target, statusLine: (await page.getByTestId("demo-status").innerText()).replace(/\s+/g, " ") };

// 1 y 2: 402 + pago
await page.getByTestId("demo-pay").click();
const paidOrRejected = page.getByTestId("demo-paid").or(page.getByTestId("demo-fail"));
await paidOrRejected.first().waitFor({ timeout: 70_000 });
if (await page.getByTestId("demo-fail").isVisible()) {
  result.payFail = await page.getByTestId("demo-fail").innerText();
} else {
  result.payOutcome = await page.getByTestId("demo-paid").getAttribute("data-outcome");
  result.http402 = (await page.getByTestId("demo-402").innerText()).replace(/\s+/g, " ");
  result.payText = (await page.getByTestId("demo-paid").innerText()).replace(/\s+/g, " ").slice(0, 400);
  result.payTx = await page.getByTestId("demo-tx").getAttribute("href").catch(() => null);
}

// 3: pasar el tope
if (noForce) await page.locator(".demo-check input").uncheck();
await page.getByTestId("demo-over").click();
const overOrFail = page.getByTestId("demo-overcap").or(page.getByTestId("demo-fail"));
await page.waitForFunction(() => !document.querySelector('[data-testid="demo-over"]')?.hasAttribute("disabled") || false, null, { timeout: 70_000 }).catch(() => {});
await page.waitForTimeout(500);
await overOrFail.first().waitFor({ timeout: 70_000 });
if (await page.getByTestId("demo-overcap").isVisible()) {
  result.overOutcome = await page.getByTestId("demo-overcap").getAttribute("data-outcome");
  result.overMsg = await page.getByTestId("demo-reject-msg").innerText().catch(() => null);
  result.contractError = await page.getByTestId("demo-contract-error").innerText().catch(() => null);
  result.forcedStatus = await page.getByTestId("demo-forced").getAttribute("data-status").catch(() => null);
  result.forcedTx = await page.getByTestId("demo-forced-tx").getAttribute("href").catch(() => null);
} else {
  result.overFail = await page.getByTestId("demo-fail").innerText();
}
result.statusAfter = (await page.getByTestId("demo-status").innerText()).replace(/\s+/g, " ");
result.emDashInVisibleText = (await page.locator("body").innerText()).includes(DASH);
result.pageErrors = errors;
result.horizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
result.seconds = Math.round((Date.now() - t0) / 1000);
if (shot) await page.screenshot({ path: shot, fullPage: true });
await browser.close();
console.log(JSON.stringify(result, null, 2));
const ok = !result.emDashInVisibleText && errors.length === 0 && (result.payOutcome || result.payFail) && (result.overOutcome || result.overFail);
process.exit(ok ? 0 : 1);
