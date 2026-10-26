// Smoke test of the fire test card (FireTest.tsx) against a real URL (vite dev, preview or the
// deploy). Read only by default. With --send it presses "Send the attacker's order", which makes
// the server sign a 5 USDC transfer to the attacker and send it to Stellar testnet: the network
// rejects it (FAILED, PayeeNotAllowed) and only a testnet fee is spent.
// Usage: node e2e/fire-test-smoke.mjs <url> [--send] [--shot out.png] [--shot-phone out.png]
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const url = (argv.find((a) => /^https?:/.test(a)) ?? "http://127.0.0.1:5173/").replace(/#.*$/, "");
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const send = argv.includes("--send");
const DASH = String.fromCharCode(0x2014);
const ATTACKER = "GCCZXNV7U6MY6APDCWFXLAUTUOB63N6LTXZEMJ2Y4JJUJVGFEXQ7SNIN";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const posts = [];
page.on("response", (r) => {
  if (r.url().includes("/api/demo/inject") && r.request().method() === "POST") posts.push(r.status());
});
await page.goto(`${url}#fire`, { waitUntil: "networkidle", timeout: 60_000 });
const fire = page.locator("#fire");
await page.getByTestId("fire-stamp").waitFor({ timeout: 60_000 });
await page.waitForFunction(() => !document.querySelector("#fire")?.textContent?.includes("(loading)"), null, { timeout: 30_000 }).catch(() => {});

const out = {
  url,
  order: (await page.getByTestId("fire-order").textContent())?.trim(),
  sendEnabled: await page.getByTestId("fire-send").isEnabled(),
  sourceBefore: await page.locator(".fire-result").getAttribute("data-source"),
  stampBefore: await page.getByTestId("fire-stamp").getAttribute("href"),
};
if (opt("--shot")) await fire.screenshot({ path: opt("--shot").replace(/\.png$/, "-before.png") });

if (send) {
  await page.getByTestId("fire-send").click();
  await page.getByTestId("fire-live-tx").waitFor({ timeout: 90_000 });
  out.sourceAfter = await page.locator(".fire-result").getAttribute("data-source");
  out.liveTx = await page.getByTestId("fire-live-tx").getAttribute("href");
  out.stampAfter = await page.getByTestId("fire-stamp").getAttribute("href");
  out.resultText = (await page.locator(".fire-result-text").innerText()).replace(/\s+/g, " ").trim();
  out.posts = posts;
  if (opt("--shot")) await fire.screenshot({ path: opt("--shot") });
}

const text = await fire.innerText();
out.emDash = text.includes(DASH);
await page.setViewportSize({ width: 375, height: 800 });
await page.waitForTimeout(400);
out.phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (opt("--shot-phone")) await fire.screenshot({ path: opt("--shot-phone") });
out.errors = errors;
await browser.close();

const ok =
  out.order?.includes(ATTACKER) &&
  out.stampBefore?.includes("/tx/") &&
  !out.emDash &&
  out.phoneOverflow <= 0 &&
  errors.length === 0 &&
  (!send || (out.sourceAfter === "live" && out.liveTx === out.stampAfter && /PayeeNotAllowed/.test(out.resultText ?? "")));
console.log(JSON.stringify(out, null, 2));
console.log(ok ? "FIRE SMOKE OK" : "FIRE SMOKE FAIL");
process.exit(ok ? 0 : 1);
