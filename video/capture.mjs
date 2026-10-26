// Records the Passport Pay demo video with Chrome's screencast (CDP Page.startScreencast),
// frame by frame, with the time of each frame. render.mjs then builds the mp4 with ffmpeg-static
// and burns in the English captions (drawtext). Script and order: docs/VIDEO.md.
//
//   node capture.mjs [baseUrl] [outDir] [--dry]
//
// In order: the landing (the problem); Story A: the trap page, the real LLM agent run replayed
// from scenario/last-run.txt and its FAILED #10 transaction on stellar.expert; a legitimate x402
// purchase in /app ("Try as an agent", a fresh real payment) and its SUCCESS transaction; the
// owner panel (cap and payees); the fire test pressed live; the catalog; the marketplace vision
// on the landing; the closing card with the real hashes of this recording.
//
// --dry skips the two live actions (no payment, no fire test), to check the layout for free.
// It uses no secret: the live actions are signed by the server with the public demo account.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closingHtml, terminalHtml } from "./scenes.mjs";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const pos = argv.filter((a) => !a.startsWith("--"));
const BASE = (pos[0] || "https://passport-pay-stellar.vercel.app").replace(/\/$/, "");
const OUT = path.resolve(pos[1] || "/var/tmp/pp-video/run");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FR = path.join(OUT, "frames");
const EXPLORER = "https://stellar.expert/explorer/testnet";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(FR, { recursive: true });

// Public evidence: the official LLM run comes from site/evidence.js (valid JSON inside).
const evSrc = fs.readFileSync(path.join(ROOT, "site/evidence.js"), "utf8");
const EV = JSON.parse(evSrc.slice(evSrc.indexOf("{"), evSrc.lastIndexOf("}") + 1));
const INJ = EV.injection;
if (!INJ?.tx) throw new Error("site/evidence.js has no injection run: nothing real to show for Story A");
const RUN_TXT = fs.readFileSync(path.join(ROOT, "scenario/last-run.txt"), "utf8");
if (!RUN_TXT.includes(INJ.tx)) throw new Error("scenario/last-run.txt is not the run in site/evidence.js");

// 1440x810 CSS px at a device scale of 4/3: 1920x1080 frames, every page 33% larger.
const VW = 1440, VH = 810, DSF = 4 / 3, W = 1920, H = 1080;
const browser = await chromium.launch({ args: ["--hide-scrollbars", "--force-color-profile=srgb", "--allow-file-access-from-files"] });
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, colorScheme: "light", locale: "en-US", timezoneId: "UTC" });
// Visible cursor (headless draws none): a ring that glides to each target before a click.
await ctx.addInitScript(() => {
  const mk = () => {
    if (document.getElementById("__cur")) return;
    const c = document.createElement("div");
    c.id = "__cur";
    c.style.cssText =
      "position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;" +
      "background:rgba(230,211,163,.6);border:3px solid #0C1A13;z-index:2147483647;pointer-events:none;" +
      "transition:transform .7s cubic-bezier(.4,0,.2,1),opacity .3s;transform:translate(720px,420px);opacity:0";
    document.documentElement.appendChild(c);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mk);
  else mk();
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const frames = [];
const marks = [];
const cdp = await ctx.newCDPSession(page);
let n = 0;
let frameSize = null;
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const file = `f_${String(n++).padStart(5, "0")}.jpg`;
  const buf = Buffer.from(data, "base64");
  fs.writeFileSync(path.join(FR, file), buf);
  if (!frameSize) frameSize = jpegSize(buf);
  frames.push({ file, t: metadata.timestamp });
  try { await cdp.send("Page.screencastFrameAck", { sessionId }); } catch {}
});
function jpegSize(b) {
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
const now = () => Date.now() / 1000;
const mark = (id, extra = {}) => { marks.push({ id, t: now(), ...extra }); console.log("mark", id, JSON.stringify(extra)); };
const sleep = (ms) => page.waitForTimeout(ms);
const hashOf = (href) => (/([0-9a-f]{64})/.exec(href || "") || [])[1] || null;

async function cursorTo(loc) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox();
  if (!b) return;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.evaluate(([x, y]) => {
    const c = document.getElementById("__cur");
    if (c) { c.style.opacity = "1"; c.style.transform = `translate(${x}px,${y}px)`; }
  }, [x, y]);
  await sleep(800);
}
async function click(loc) {
  await cursorTo(loc);
  await page.evaluate(() => { const c = document.getElementById("__cur"); if (c) c.animate([{ scale: 1 }, { scale: 0.7 }, { scale: 1 }], { duration: 250 }); });
  await loc.click();
  await sleep(300);
}
// Smooth scroll (rAF) to y px in ms.
async function scrollTo(y, ms = 1500) {
  await page.evaluate(([y, ms]) => new Promise((res) => {
    const y0 = scrollY, d = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)) - y0, t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const step = (now) => { const p = Math.min(1, (now - t0) / ms); scrollTo(0, y0 + d * ease(p)); p < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  }), [y, ms]);
}
async function scrollToEl(loc, offset = 120, ms = 1500) {
  const y = await loc.first().evaluate((el, off) => el.getBoundingClientRect().top + scrollY - off, offset);
  await scrollTo(y, ms);
}
// Frame box drawn over the page (document coordinates), with an optional label above it.
const HL = (el, [label, pad, color]) => {
  const r = el.getBoundingClientRect();
  const d = document.createElement("div");
  d.className = "__hl";
  d.style.cssText = `position:absolute;left:${r.left + scrollX - pad}px;top:${r.top + scrollY - pad}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px;` +
    `border:4px solid ${color};border-radius:14px;box-shadow:0 0 0 6px ${color}2e;z-index:2147483646;pointer-events:none;opacity:0;transition:opacity .45s`;
  if (label) {
    const t = document.createElement("span");
    t.textContent = label;
    t.style.cssText = `position:absolute;left:-4px;top:-38px;white-space:nowrap;background:${color};color:#fff;font:600 15px/1 "Public Sans",system-ui,sans-serif;letter-spacing:.02em;padding:8px 12px;border-radius:999px`;
    d.appendChild(t);
  }
  document.documentElement.appendChild(d);
  requestAnimationFrame(() => requestAnimationFrame(() => { d.style.opacity = "1"; }));
  return true;
};
async function highlight(loc, label = "", { pad = 10, color = "#C23A1A" } = {}) {
  const ok = await loc.first().evaluate(HL, [label, pad, color]).catch(() => false);
  await sleep(450);
  return ok;
}
// Highlights the smallest visible element whose text matches re (pages we do not control).
async function highlightText(re, label = "", { pad = 8, color = "#C23A1A" } = {}) {
  const ok = await page.evaluate(([src, flags, label, pad, color, hl]) => {
    const re = new RegExp(src, flags);
    let best = null, area = Infinity;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || !re.test((el.innerText || "").trim())) continue;
      if (r.width * r.height < area) { area = r.width * r.height; best = el; }
    }
    if (!best) return false;
    return new Function("return " + hl)()(best, [label, pad, color]);
  }, [re.source, re.flags, label, pad, color, HL.toString()]).catch(() => false);
  await sleep(450);
  return ok;
}
const clearHighlights = () => page.evaluate(() => document.querySelectorAll(".__hl").forEach((e) => e.remove()));
// Forces a frame even when nothing changes (the screencast only sends frames on change).
const tick = async () => page.evaluate(() => { const c = document.getElementById("__cur"); if (c) c.style.outlineColor = c.style.outlineColor === "red" ? "blue" : "red"; });

// A page load: the whole stretch is a "wait" that render.mjs shortens and labels as sped up.
async function load(url, why, ready) {
  mark("wait-start", { why });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  if (ready) await ready();
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await sleep(700);
  mark("wait-end");
}
// stellar.expert may need a few seconds to index a fresh transaction: reload until it shows.
async function explorerTx(hash, why) {
  await load(`${EXPLORER}/tx/${hash}`, why, async () => {
    for (let k = 0; k < 8; k++) {
      const ok = await page.getByText(/Status:/).first().waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
      if (ok) return;
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    throw new Error("stellar.expert did not show tx " + hash);
  });
  return page.evaluate(() => (/Status:\s*(\w+)/.exec(document.body.innerText) || [])[1] || null);
}

const result = { base: BASE, dry: DRY, llmTx: INJ.tx };
await page.goto("about:blank");
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

// 1. The problem, on the landing hero
await load(BASE + "/", "landing");
mark("pain");
await sleep(7000);

// 2. Story A: the staged trap page and its hidden order
await load(BASE + "/trampa", "trap");
mark("trap");
await sleep(2200);
const notice = page.locator(".service-notice");
await scrollToEl(notice, 150, 1800);
await sleep(400);
await highlight(notice, "Hidden order for AI agents");
await sleep(6200);

// 3. The real LLM agent run, replayed from scenario/last-run.txt
fs.writeFileSync(path.join(OUT, "terminal.html"), terminalHtml(RUN_TXT));
await load("file://" + path.join(OUT, "terminal.html"), "terminal");
mark("terminal");
await sleep(1600);
await page.evaluate(() => window.__start());
await page.waitForFunction(() => window.__phase === "pay", null, { timeout: 60_000 });
mark("agent-pays");
await page.waitForFunction(() => window.__phase === "failed", null, { timeout: 60_000 });
mark("ledger-failed");
await page.waitForFunction(() => window.__phase === "done", null, { timeout: 60_000 });
await sleep(4200);

// 4. The same transaction on stellar.expert
result.llmStatus = await explorerTx(INJ.tx, "expert");
if (result.llmStatus !== "Failed") throw new Error("stellar.expert shows " + result.llmStatus + " for the LLM run");
mark("expert-llm");
await sleep(1200);
await highlightText(/^Status:\s*Failed$/i, "FAILED on the ledger");
await sleep(900);
await highlightText(/invoked contract[\s\S]*transfer\(/, "5 USDC to the attacker", { pad: 6 });
await sleep(5600);

// 5. A legitimate purchase over x402 in /app ("Try as an agent")
await load(BASE + "/app#try", "app", () => page.getByTestId("demo-status").waitFor({ timeout: 60_000 }));
await scrollToEl(page.locator("#try"), 16, 900);
mark("try");
result.statusBefore = (await page.getByTestId("demo-status").innerText()).replace(/\s+/g, " ");
await sleep(3800);
if (!DRY) {
  mark("pay-click");
  await click(page.getByTestId("demo-pay"));
  mark("wait-start", { why: "pay" });
  await page.getByTestId("demo-paid").or(page.getByTestId("demo-fail")).first().waitFor({ timeout: 90_000 });
  mark("wait-end");
  if (await page.getByTestId("demo-fail").isVisible()) throw new Error("payment failed: " + (await page.getByTestId("demo-fail").innerText()));
  const outcome = await page.getByTestId("demo-paid").getAttribute("data-outcome");
  if (outcome !== "paid") throw new Error("payment outcome: " + outcome + ": " + (await page.getByTestId("demo-paid").innerText()));
  result.payTx = hashOf(await page.getByTestId("demo-tx").getAttribute("href"));
  result.payText = (await page.getByTestId("demo-paid").innerText()).replace(/\s+/g, " ").slice(0, 400);
  mark("paid", { tx: result.payTx });
  await scrollToEl(page.getByTestId("demo-paid"), 70, 1300);
  await sleep(600);
  await highlight(page.getByTestId("demo-paid"), "HTTP 402, then paid and 200", { pad: 6, color: "#0B6B5C" });
  await sleep(3000);
  await cursorTo(page.getByTestId("demo-tx"));
  await sleep(2200);

  // 6. Its SUCCESS on stellar.expert
  result.payStatus = await explorerTx(result.payTx, "expert");
  mark("expert-pay");
  await sleep(1200);
  await highlightText(/^Status:\s*\w+$/i, "SUCCESS", { color: "#0B6B5C" });
  await sleep(900);
  await highlightText(/invoked contract[\s\S]*transfer\(/, "0.01 USDC to the merchant", { pad: 6, color: "#0B6B5C" });
  await sleep(4800);
}

// 7. Owner panel: the cap and the payee list, read from the contract
await load(BASE + "/app#panel", "app", async () => {
  await page.getByTestId("spent").waitFor({ timeout: 60_000 });
  await page.locator("#payees .payees li").first().waitFor({ timeout: 60_000 });
});
await scrollTo(0, 10);
mark("panel");
await sleep(1200);
await highlight(page.locator("#gasto"), "Cap per period, enforced onchain", { pad: 6 });
await sleep(3800);
await scrollToEl(page.locator("#payees"), 230, 1400);
await sleep(300);
await highlight(page.locator("#payees"), "The only allowed payee: the merchant", { pad: 6 });
await sleep(4200);
result.panelSpent = (await page.getByTestId("spent").innerText()).trim();

// 8. Fire test: the trap page's order, signed and sent from the live app
await clearHighlights();
await scrollTo(0, 900);
await sleep(300);
await click(page.getByTestId("tab-probar"));
await page.getByTestId("fire-order").waitFor({ timeout: 30_000 });
await sleep(1200);
await scrollToEl(page.locator("#fire"), 16, 900);
mark("fire");
await sleep(5200);
if (!DRY) {
  await scrollToEl(page.locator("#fire .fire-tiles"), 16, 1000);
  await sleep(400);
  mark("fire-click");
  await click(page.getByTestId("fire-send"));
  mark("wait-start", { why: "fire" });
  await page.getByTestId("fire-live-tx").or(page.locator("#fire .note.err")).first().waitFor({ timeout: 90_000 });
  mark("wait-end");
  if (!(await page.getByTestId("fire-live-tx").isVisible().catch(() => false))) throw new Error("fire test: " + (await page.locator("#fire .note.err").innerText()));
  result.fireTx = hashOf(await page.getByTestId("fire-live-tx").getAttribute("href"));
  result.fireText = (await page.locator("#fire .fire-result").innerText()).replace(/\s+/g, " ");
  if (!/FAILED onchain/.test(result.fireText) || !/#10\) PayeeNotAllowed/.test(result.fireText) || !/Live result/.test(result.fireText))
    throw new Error("fire test result is not a live FAILED #10: " + result.fireText);
  mark("fire-rejected", { tx: result.fireTx });
  await scrollToEl(page.locator("#fire .fire-actions"), 40, 1200);
  await sleep(500);
  await highlight(page.locator("#fire .fire-result"), "Live result, just now", { pad: 8, color: "#FF6A3D" });
  await sleep(6200);
}

// 9. Catalog
await clearHighlights();
await scrollTo(0, 900);
await sleep(300);
await click(page.getByTestId("tab-catalogo"));
await page.getByTestId("catalog").waitFor({ timeout: 30_000 });
await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
mark("catalog");
await sleep(1800);
await scrollToEl(page.getByTestId("catalog"), 90, 1500);
await sleep(4600);

// 10. The vision, on the landing
await load(BASE + "/", "landing");
mark("vision");
await sleep(600);
await scrollToEl(page.locator("#market"), 30, 2200);
await sleep(6400);

// 11. Closing card with this recording's real hashes
if (DRY) {
  const rec = await (await fetch(BASE + "/api/demo/inject")).json().catch(() => ({}));
  result.dryPayTx = EV.paid.tx;
  result.dryFireTx = rec?.recorded?.hash ?? EV.payeeNotAllowed.tx;
}
fs.writeFileSync(path.join(OUT, "closing.html"), closingHtml({ llmTx: INJ.tx, payTx: result.payTx ?? result.dryPayTx, fireTx: result.fireTx ?? result.dryFireTx }));
await load("file://" + path.join(OUT, "closing.html"), "outro");
mark("outro");
await sleep(7000);
await tick();
mark("end");
await sleep(300);
await cdp.send("Page.stopScreencast");
await browser.close();
result.frames = frames.length;
result.frameSize = frameSize;
result.pageErrors = errors;
fs.writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify({ viewport: { width: W, height: H, css: [VW, VH], dsf: DSF }, frames, marks, result }, null, 1));
console.log(JSON.stringify(result, null, 2));
