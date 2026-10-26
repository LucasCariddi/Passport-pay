// Smoke test of the public landing and docs pages in headless Chromium.
// Usage: node e2e/landing-smoke.mjs <base-url> [--shots <dir>] [--skip-external]
// Checks: renders in English, no horizontal scroll at phone width, no em dash in visible text,
// light and dark theme, internal links and in-page anchors resolve, every tx link goes to
// stellar.expert, no [PLACEHOLDER] left, CTAs reach /app, the demo video plays from /video and the landing.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:/.test(a)) ?? "http://localhost:4174").replace(/\/$/, "");
const shotsIdx = args.indexOf("--shots");
const shots = shotsIdx >= 0 ? args[shotsIdx + 1] : null;
const skipExternal = args.includes("--skip-external");
const DASH = String.fromCharCode(0x2014);
const failures = [];
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures.push(msg); };
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const errors = [];
async function open(path, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 }, colorScheme: opts.scheme ?? "light" });
  const page = await ctx.newPage();
  // Only landing/docs errors count here; /app has its own smoke test (panel-smoke.mjs).
  const mine = () => !new URL(page.url()).pathname.startsWith("/app");
  page.on("pageerror", (e) => { if (mine()) errors.push(`${path}: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && mine()) errors.push(`${path}: ${m.text()}`); });
  const res = await page.goto(base + path, { waitUntil: "networkidle" });
  return { ctx, page, status: res?.status() ?? 0 };
}

// 1. Landing, desktop light
{
  const { ctx, page, status } = await open("/");
  ok(status === 200, `/ answers 200 (${status})`);
  ok((await page.title()) === "Passport Pay", `title "Passport Pay"`);
  ok((await page.getAttribute("html", "lang")) === "en", "html lang=en");
  const h1 = await page.locator("h1").innerText();
  ok(/Give your agent money/.test(h1), `h1: ${h1.replace(/\n/g, " ")}`);
  for (const id of ["top", "incident", "demo", "how", "proof", "market", "stack"]) ok((await page.locator(`#${id}`).count()) === 1, `section #${id}`);
  const text = await page.locator("body").innerText();
  ok(!text.includes(DASH), "no em dash in the visible text");
  ok(!/\[[A-Z][A-Z ]+\]/.test(text), "no [PLACEHOLDER] left in the visible text");
  ok(!/\b(Probar|cuenta|tope|Ver presentación)\b/.test(text), "no Spanish UI copy left");
  const cta = page.locator(".hero a", { hasText: "Run the injection test" });
  ok((await cta.getAttribute("href")) === "/app#fire", "hero CTA -> /app#fire");
  ok((await page.locator(".hero a", { hasText: "See the 2:30 pitch" }).getAttribute("href")) === "/presentacion", "secondary CTA -> /presentacion");
  ok((await page.locator(".hero a", { hasText: "Watch the demo (2:23)" }).getAttribute("href")) === "/video", "video CTA -> /video");
  ok((await page.locator(".site-nav a[href='/video']").count()) === 1, "the nav links the demo video");
  const embed = await page.evaluate(() => { const v = document.querySelector("#demo video"); return v && { controls: v.controls, autoplay: v.autoplay, poster: v.getAttribute("poster"), src: v.querySelector("source")?.getAttribute("src") }; });
  ok(embed && embed.controls && !embed.autoplay && embed.poster === "/media/demo-poster.png" && embed.src === "/media/demo.mp4", `#demo embeds the video with poster and controls, no autoplay (${JSON.stringify(embed)})`);
  const txs = await page.locator("a[href*='stellar.expert']").evaluateAll((as) => as.map((a) => a.href));
  ok(txs.length >= 5 && txs.every((h) => /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/.test(h)), `${txs.length} tx links to stellar.expert, all real hashes`);
  const stamp = await page.locator(".hero-stamp").innerText();
  ok(/REJECTED/.test(stamp) && /#10/.test(stamp) && /tx [0-9a-f]{8}…[0-9a-f]{4}/.test(stamp), `stamp: ${stamp.replace(/\s+/g, " ")}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(bg === "rgb(255, 255, 255)", `light ground (${bg})`);
  if (shots) await page.screenshot({ path: join(shots, "landing-desktop-light.png"), fullPage: true });

  // keyboard: the skip link is the first stop, then the brand link shows a visible focus ring
  await page.keyboard.press("Tab");
  const skip = await page.evaluate(() => document.activeElement?.className);
  ok(skip === "skip", `first Tab lands on the skip link (${skip})`);
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  ok(ring === "solid", `focus ring visible on the next stop (${ring})`);

  await page.click("[data-theme-toggle]");
  const bg2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(bg2 === "rgb(9, 9, 11)", `the toggle switches to dark (${bg2})`);

  const hrefs = await page.locator("a[href^='/']").evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
  const html = new Map();
  for (const h of hrefs) {
    const [p, hash] = h.split("#");
    const r = await page.request.get(base + (p || "/"));
    ok(r.status() === 200, `${h} -> ${r.status()}`);
    // Static pages (landing, /docs/*) must carry the anchor in their HTML. /app is a React app:
    // its #fire is checked after it mounts, below.
    if (hash && !(p || "/").startsWith("/app")) {
      if (!html.has(p)) html.set(p, await r.text());
      ok(new RegExp(`\\sid="${hash}"`).test(html.get(p)), `${h}: anchor #${hash} exists on ${p || "/"}`);
    }
  }
  // The landing points at the English README sections on /docs (README.md headings).
  for (const a of ["honest-limitations", "prior-work-declared", "security-fix-during-the-event", "evidence-on-testnet"]) {
    ok(hrefs.includes(`/docs#${a}`), `the landing links /docs#${a}`);
  }
  ok(!hrefs.some((h) => /#(limitaciones|trabajo-previo|evidencia|arreglo)/.test(h)), "no link to a Spanish /docs anchor");
  if (!skipExternal) {
    const ext = await page.locator("a[href^='https://']").evaluateAll((as) => [...new Set(as.map((a) => a.href))]);
    for (const h of ext) {
      const r = await page.request.get(h, { maxRedirects: 5, timeout: 20000 }).catch((e) => ({ status: () => `error ${e.message}` }));
      ok(r.status() === 200, `external ${h} -> ${r.status()}`);
    }
  }
  await cta.click();
  await page.waitForLoadState("networkidle");
  ok(new URL(page.url()).pathname.replace(/\/$/, "") === "/app", `the CTA opens ${page.url()}`);
  const rootLen = await page.evaluate(() => document.getElementById("root")?.innerHTML.length ?? 0);
  ok(rootLen > 100, `the app mounts at /app (#root with ${rootLen} chars)`);
  const fire = await page.waitForSelector("#fire", { timeout: 15000 }).then(() => true).catch(() => false);
  ok(fire, "/app#fire: the fire test section exists");
  await ctx.close();
}

// 2. Landing, dark by system preference
{
  const { ctx, page } = await open("/", { scheme: "dark" });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(bg === "rgb(9, 9, 11)", `system dark mode (${bg})`);
  if (shots) await page.screenshot({ path: join(shots, "landing-desktop-dark.png"), fullPage: true });
  await ctx.close();
}

// 3. Phone width, both themes, and reduced motion
for (const scheme of ["light", "dark"]) {
  const { ctx, page } = await open("/", { viewport: { width: 375, height: 812 }, scheme });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 0, `375 px ${scheme}: no horizontal scroll (${over}px extra)`);
  if (shots) await page.screenshot({ path: join(shots, `landing-mobile-${scheme}.png`), fullPage: true });
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(base + "/", { waitUntil: "networkidle" });
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector(".hero-stamp")).animationName);
  ok(anim === "none", `reduced motion: the stamp does not animate (${anim})`);
  await ctx.close();
}

// 4. Docs pages
for (const path of ["/docs", "/docs/arquitectura", "/docs/ia"]) {
  const { ctx, page, status } = await open(path, { viewport: { width: 375, height: 812 } });
  ok(status === 200, `${path} answers 200 (${status})`);
  const h1 = await page.locator("main h1").first().innerText().catch(() => "");
  ok(h1.length > 0, `${path} h1: ${h1}`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 0, `${path} at 375 px: no horizontal scroll (${over}px extra)`);
  const text = await page.locator("body").innerText();
  ok(!text.includes(DASH), `${path} no em dash`);
  ok(!text.includes("<!--"), `${path} no HTML comment shown as text`);
  const srcs = await page.evaluate(() => [...document.images].map((i) => i.src));
  const broken = [];
  for (const s of srcs) {
    const r = await page.request.get(s);
    if (r.status() !== 200 || !(r.headers()["content-type"] ?? "").startsWith("image/")) broken.push(s);
  }
  ok(broken.length === 0, `${path} images load ${broken.join(" ")}`);
  if (shots && path === "/docs") await page.screenshot({ path: join(shots, "docs-mobile.png") });
  await ctx.close();
}

// 5. Demo video page (site/video, published as /video)
for (const [w, scheme] of [[1440, "light"], [375, "dark"]]) {
  const { ctx, page, status } = await open("/video", { viewport: { width: w, height: w > 800 ? 900 : 812 }, scheme });
  ok(status === 200, `/video at ${w} px ${scheme} answers 200 (${status})`);
  const h1 = await page.locator("main h1").innerText().catch(() => "");
  ok(/Watch the demo \(2:23\)/.test(h1), `/video h1: ${h1}`);
  const v = await page.evaluate(() => { const el = document.querySelector("main video"); return el && { controls: el.controls, autoplay: el.autoplay, poster: el.getAttribute("poster"), src: el.querySelector("source")?.getAttribute("src") }; });
  ok(v && v.controls && !v.autoplay && v.poster === "/media/demo-poster.png" && v.src === "/media/demo.mp4", `/video player: controls, no autoplay, poster and mp4 (${JSON.stringify(v)})`);
  for (const h of ["/app#fire", "/presentacion", "/media/demo.mp4"]) ok((await page.locator(`main a[href='${h}']`).count()) > 0, `/video links ${h}`);
  const text = await page.locator("body").innerText();
  ok(!text.includes(DASH), "/video no em dash");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 0, `/video at ${w} px: no horizontal scroll (${over}px extra)`);
  await ctx.close();
}

await browser.close();
ok(errors.length === 0, `no console errors on the landing and docs${errors.length ? ": " + errors.join(" | ") : ""}`);
console.log(failures.length ? `\nLANDING FAIL (${failures.length})` : "\nLANDING OK");
process.exit(failures.length ? 1 : 0);
