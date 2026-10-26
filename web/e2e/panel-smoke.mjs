// Smoke test of the owner panel against a real URL (vite preview, or the deploy): opens the
// default account in the Owner panel view, reads the cap meter and checks there is no em dash
// (U+2014) in the visible text. Read only, it never signs anything.
// Usage: node e2e/panel-smoke.mjs <url> [--account C...] [--expect-account C...] [--shot out.png]
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const url = (argv.find((a) => /^https?:/.test(a)) ?? "http://127.0.0.1:4173/").replace(/#.*$/, "");
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const account = opt("--account");
const expectAccount = opt("--expect-account");
const shot = opt("--shot");
const DASH = String.fromCharCode(0x2014);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const target = (account ? `${url}${url.includes("?") ? "&" : "?"}account=${account}` : url) + "#panel";
await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
await page.getByTestId("spent").waitFor({ timeout: 60_000 });
await page.waitForTimeout(1500);

const result = {
  url: target,
  title: await page.locator(".card h2").first().textContent().catch(() => null),
  accountInput: await page.locator("form.lookup input").inputValue(),
  lead: (await page.locator(".lead-line").textContent())?.trim(),
  spent: await page.getByTestId("spent").textContent(),
  effectiveCap: await page.getByTestId("effective-cap").textContent(),
  meterNote: await page.getByTestId("meter-note").textContent(),
  state: await page.locator("[data-state]").first().getAttribute("data-state"),
  emDashInVisibleText: (await page.locator("body").innerText()).includes(DASH),
  pageErrors: errors,
};
if (shot) await page.screenshot({ path: shot, fullPage: true });
await browser.close();
console.log(JSON.stringify(result, null, 2));
const ok = !result.emDashInVisibleText && errors.length === 0 && (!expectAccount || result.accountInput === expectAccount);
console.log(ok ? "PANEL SMOKE OK" : "PANEL SMOKE FAIL");
process.exit(ok ? 0 : 1);
