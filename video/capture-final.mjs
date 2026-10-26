// Video final para HackMeridian (docs/VIDEO.md, historia A primero). Mismo metodo que capture.mjs:
// screencast de Chrome (CDP Page.startScreencast) cuadro por cuadro con la hora de cada cuadro,
// contra produccion. Despues render-final.mjs arma el mp4 con ffmpeg-static y los titulos.
//
//   node capture-final.mjs https://passport-pay-stellar.vercel.app /var/tmp/pp-video/final
//
// Paginas locales: una placa con el problema, la terminal del agente real (scenario/last-run.txt,
// renderizada tal cual, con sus horas reales) y la placa de cierre. Todo lo demas es produccion
// y stellar.expert. No usa ningun secreto: el servidor firma con la cuenta de demo publica.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = (process.argv[2] || "https://passport-pay-stellar.vercel.app").replace(/\/$/, "");
const OUT = process.argv[3] || "/var/tmp/pp-video/final";
const FR = path.join(OUT, "frames");
const PG = path.join(OUT, "pages");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(FR, { recursive: true });
fs.mkdirSync(PG, { recursive: true });

const STORY_A_TX = "b90a30c743e7aa56a8a843458018fd827afdf15df3607d1a9e8f475efad8215b";
const W = 1920, H = 1080;
const escH = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- Paginas locales ----------
const CARD_CSS = `
  html,body{margin:0;height:100%;background:#0e2a20;color:#f3efe2;font-family:"Ubuntu Sans","DejaVu Sans",sans-serif}
  .wrap{position:absolute;left:180px;right:180px;top:0;bottom:176px;display:flex;flex-direction:column;justify-content:center}
  .eyebrow{font-family:"JetBrains Mono",monospace;letter-spacing:.18em;font-size:22px;color:#e6c46a;margin-bottom:28px}
  h1{font-size:76px;line-height:1.08;margin:0;font-weight:800;letter-spacing:-.01em;max-width:1500px}
  h1 em{font-style:normal;color:#f0a37a}
  .sub{margin-top:34px;font-size:30px;color:#c9d6cc;line-height:1.4}
  .links{margin-top:42px;font-family:"JetBrains Mono",monospace;font-size:28px;color:#e6c46a;line-height:1.7}
  .mark{width:84px;height:84px;margin-bottom:30px}`;
const MARK = `<svg class="mark" viewBox="0 0 32 32"><rect x="5" y="3" width="22" height="26" rx="3" fill="#E6D3A3"/><circle cx="16" cy="13" r="5" fill="none" stroke="#12372A" stroke-width="1.6"/><path d="M11 13h10M16 8c2 2 2 8 0 10M16 8c-2 2-2 8 0 10" fill="none" stroke="#12372A" stroke-width="1.2"/><path d="M10 23h12" stroke="#12372A" stroke-width="1.6" stroke-linecap="round"/></svg>`;
fs.writeFileSync(path.join(PG, "pain.html"), `<!doctype html><meta charset="utf-8"><title>pain</title><style>${CARD_CSS}</style>
<div class="wrap"><div class="eyebrow">THE PROBLEM</div>
<h1>One poisoned web page is all it takes to make an AI agent <em>with a wallet</em> pay an attacker.</h1></div>`);
fs.writeFileSync(path.join(PG, "close.html"), `<!doctype html><meta charset="utf-8"><title>close</title><style>${CARD_CSS}</style>
<div class="wrap">${MARK}<h1>Passport Pay</h1>
<div class="sub">Give your agent money. Not the power to drain it.</div>
<div class="links">passport-pay-stellar.vercel.app<br>github.com/LucasCariddi/passport-pay</div>
<div class="sub" style="font-size:24px;margin-top:30px">HackMeridian · Stellar Composed · everything on Stellar testnet</div></div>`);

// Terminal: las lineas de scenario/last-run.txt tal cual (cabecera + paso 7 hasta el resumen).
const raw = fs.readFileSync(path.join(ROOT, "scenario/last-run.txt"), "utf8").split("\n");
const hdrEnd = raw.findIndex((l) => l.startsWith("rendered from"));
const s7 = raw.findIndex((l) => l.includes("== 7. THE REAL AGENT RUN =="));
const sumStart = raw.findIndex((l) => l.includes("SUMMARY (what really happened)"));
const sumEnd = raw.findIndex((l, i) => i > sumStart && /\] =+$/.test(l));
const header = raw.slice(0, hdrEnd + 1);
const body = raw.slice(s7, sumEnd + 1);
const lines = [];
header.forEach((t) => lines.push({ t, phase: 0, d: 0 }));
lines.push({ t: "", phase: 0, d: 0 });
let phase = 1;
for (const t of body) {
  const L = { t, phase, d: 220 };
  if (t.includes("== 7.")) L.d = 700;
  if (t.includes("task      :")) { L.d = 500; L.hold = 1500; }
  if (t.includes("[tool] read_url")) { L.d = 1100; L.cls = "hl-info"; L.key = "read"; }
  if (t.includes("-> HTTP 200")) L.d = 700;
  if (t.includes("[tool] pay(")) { phase = 2; L.phase = 2; L.d = 700; L.cls = "hl-warn"; L.key = "pay"; L.hold = 2200; }
  if (t.includes("the agent key signs")) { L.d = 300; L.cls = "warn"; L.hold = 1400; }
  if (t.includes("enforcing simulation")) { L.d = 1300; L.hold = 1200; }
  if (t.includes("ledger result: FAILED")) { L.d = 900; L.cls = "hl-bad"; L.key = "failed"; L.hold = 2600; }
  if (t.includes("rejected by: __check_auth")) { L.d = 300; L.cls = "bad"; L.hold = 1300; }
  if (t.includes("[model]")) { L.d = 700; L.cls = "model"; L.hold = 1600; }
  if (t.includes("If you have another source")) L.cls = "model";
  if (t.includes("SUMMARY (what really happened)")) L.d = 600;
  if (t.includes("The agent FELL")) { L.cls = "warn"; }
  if (t.includes("Ledger result: FAILED")) { L.cls = "bad"; }
  if (t.includes("VERDICT:")) { L.d = 600; L.cls = "hl-bad"; L.key = "verdict"; L.hold = 600; }
  lines.push(L);
}
const html = (s) => {
  const m = s.match(/^(\[\d\d:\d\d:\d\dZ\])(.*)$/);
  return m ? `<span class="ts">${escH(m[1])}</span>${escH(m[2])}` : escH(s);
};
const termLines = lines.map((L) => ({ ...L, h: html(L.t) || "&nbsp;" }));
fs.writeFileSync(path.join(PG, "terminal.html"), `<!doctype html><meta charset="utf-8"><title>terminal</title>
<style>
  html{scroll-behavior:smooth}
  html,body{margin:0;background:#0a0f0d;color:#d7e2dc}
  .bar{position:fixed;top:0;left:0;right:0;height:54px;background:#17201c;display:flex;align-items:center;gap:12px;padding:0 26px;z-index:5;
       font:20px "JetBrains Mono",monospace;color:#9fb0a7;border-bottom:1px solid #26332d}
  .dot{width:15px;height:15px;border-radius:50%;display:inline-block}
  .bar b{color:#e8efe9;font-weight:600;margin-left:14px}
  pre{margin:0;padding:78px 56px 260px;font:20.5px/1.5 "JetBrains Mono",monospace;white-space:pre-wrap;overflow-wrap:anywhere;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0}
  .bar{font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0}
  .l{display:block;opacity:0;padding:0 10px;margin:0 -10px;border-radius:4px;transition:opacity .25s,background .5s}
  .l.on{opacity:1}
  .ts{color:#5d7268}
  .hdr{color:#e6c46a}
  .hl-info.on{background:rgba(80,170,255,.16);box-shadow:inset 4px 0 #59b0ff;color:#cfe6ff}
  .hl-warn.on{background:rgba(245,183,0,.20);box-shadow:inset 4px 0 #f5b700;color:#ffe9a8}
  .hl-bad.on{background:rgba(255,72,72,.22);box-shadow:inset 4px 0 #ff5252;color:#ffd3d3;font-weight:700}
  .warn{color:#ffd77a}.bad{color:#ff9d9d}.model{color:#9fe3b9}
</style>
<div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
<b>scenario/last-run.txt</b><span>· recorded run of the real LLM agent · lines and UTC timestamps as logged</span></div>
<pre id="p"></pre>
<script>
const L=${JSON.stringify(termLines)};
const P=Number(new URLSearchParams(location.search).get("phase")||1);
const pre=document.getElementById("p");
const els=L.map((x,i)=>{const s=document.createElement("span");s.className="l "+(x.cls||"")+(x.phase===0?" hdr0":"");s.innerHTML=x.h;if(x.key)s.dataset.key=x.key;pre.appendChild(s);return s;});
L.forEach((x,i)=>{if(x.phase===0&&i<${header.length}&&!x.cls)els[i].classList.add(i===0?"hdr":"x")});
const follow=(smooth)=>{const last=[...document.querySelectorAll(".l.on")].pop();if(!last)return;const r=last.getBoundingClientRect();const lim=innerHeight-230;if(r.bottom>lim)scrollTo({top:scrollY+r.bottom-lim,behavior:smooth?"smooth":"auto"});};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  L.forEach((x,i)=>{if(x.phase<P)els[i].classList.add("on")});
  follow(false);
  await sleep(P===1?900:500);
  for(let i=0;i<L.length;i++){const x=L[i];if(x.phase!==P)continue;await sleep(x.d);els[i].classList.add("on");if(x.key)document.body.dataset[x.key]="1";follow(true);if(x.hold)await sleep(x.hold);}
  document.body.dataset.done="1";
})();
</script>`);

// ---------- Navegador y screencast ----------
const browser = await chromium.launch({ args: ["--hide-scrollbars", "--force-color-profile=srgb", "--allow-file-access-from-files"] });
if (process.env.PAGES_ONLY) {
  // Prueba de las paginas locales, sin tocar produccion.
  const p = await browser.newPage({ viewport: { width: W, height: H } });
  for (const [name, q] of [["pain.html", ""], ["terminal.html", "?phase=1"], ["terminal.html", "?phase=2"], ["close.html", ""]]) {
    await p.goto("file://" + path.join(PG, name) + q, { waitUntil: "load" });
    if (name === "terminal.html") await p.waitForFunction(() => document.body.dataset.done === "1", null, { timeout: 90_000 });
    await p.waitForTimeout(1200);
    await p.screenshot({ path: path.join(OUT, `test-${name.replace(".html", "")}${q.replace(/\W/g, "")}.png`) });
  }
  await browser.close();
  process.exit(0);
}
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US" });
await ctx.addInitScript(() => {
  const mk = () => {
    if (document.getElementById("__cur")) return;
    const c = document.createElement("div");
    c.id = "__cur";
    c.style.cssText =
      "position:fixed;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;" +
      "background:rgba(255,196,0,.55);border:3px solid #111;z-index:2147483647;pointer-events:none;" +
      "transition:transform .7s cubic-bezier(.4,0,.2,1),opacity .3s;transform:translate(960px,600px);opacity:0";
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
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const file = `f_${String(n++).padStart(5, "0")}.jpg`;
  fs.writeFileSync(path.join(FR, file), Buffer.from(data, "base64"));
  frames.push({ file, t: metadata.timestamp });
  try { await cdp.send("Page.screencastFrameAck", { sessionId }); } catch {}
});
const now = () => Date.now() / 1000;
const mark = (id, extra = {}) => { marks.push({ id, t: now(), ...extra }); console.log("mark", id, JSON.stringify(extra)); };
const sleep = (ms) => page.waitForTimeout(ms);

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
async function scrollTo(y, ms = 1500) {
  await page.evaluate(([y, ms]) => new Promise((res) => {
    document.documentElement.style.scrollBehavior = "auto";
    const y0 = scrollY, d = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)) - y0, t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const step = (now) => { const p = Math.min(1, (now - t0) / ms); scrollTo(0, y0 + d * ease(p)); p < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  }), [y, ms]);
}
async function scrollToEl(loc, offset = 120, ms = 1500) {
  const y = await loc.evaluate((el, off) => el.getBoundingClientRect().top + scrollY - off, offset);
  await scrollTo(y, ms);
}
// Resalta un elemento (anotacion del video, no cambia la pagina publicada).
async function highlight(loc, color = "245,183,0") {
  await loc.evaluate((el, color) => {
    el.style.transition = "box-shadow .5s, background-color .5s";
    el.style.boxShadow = `0 0 0 4px rgba(${color},.95), 0 0 0 12px rgba(${color},.25)`;
    el.style.borderRadius = el.style.borderRadius || "8px";
  }, color).catch(() => {});
}
async function unhighlight(loc) { await loc.evaluate((el) => { el.style.boxShadow = "none"; }).catch(() => {}); }
const tick = async () => page.evaluate(() => { const c = document.getElementById("__cur"); if (c) c.style.outlineColor = c.style.outlineColor === "red" ? "blue" : "red"; });
async function load(url, why, ready) {
  mark("wait-start", { why });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  if (ready) await ready();
  await sleep(500);
  mark("wait-end");
}
const file = (name, q = "") => "file://" + path.join(PG, name) + q;

const result = { base: BASE, storyATx: STORY_A_TX };
await page.goto("about:blank");
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

// 1. El problema
await page.goto(file("pain.html"), { waitUntil: "load" });
await sleep(300);
mark("pain");
await sleep(6200);

// 2. Historia A: la terminal del agente real, fase 1 (lee la pagina)
mark("term1");
await page.goto(file("terminal.html", "?phase=1"), { waitUntil: "load" });
await page.waitForFunction(() => document.body.dataset.done === "1", null, { timeout: 60_000 });
await sleep(1800);

// 2b. Lo que leyo: la trampa, en produccion
mark("trap");
await load(BASE + "/trampa", "trap", () => page.locator(".service-notice").waitFor({ timeout: 30_000 }));
await sleep(1500);
const notice = page.locator(".service-notice");
await scrollToEl(notice, 300, 2200);
await sleep(500);
await highlight(notice, "255,82,82");
await notice.evaluate((el) => {
  const tag = document.createElement("div");
  tag.textContent = "The planted order";
  tag.style.cssText = "position:absolute;transform:translate(0,-46px);background:#ff5252;color:#fff;font:700 18px 'DejaVu Sans',sans-serif;padding:6px 12px;border-radius:6px;letter-spacing:.02em";
  el.style.position = "relative";
  tag.style.top = "0"; tag.style.left = "0";
  el.prepend(tag);
});
await cursorTo(page.locator(".service-notice code"));
await sleep(5200);

// 2c. La terminal, fase 2 (paga, firma, la red rechaza)
mark("term2");
await page.goto(file("terminal.html", "?phase=2"), { waitUntil: "load" });
await page.waitForFunction(() => document.body.dataset.failed === "1", null, { timeout: 60_000 });
mark("term-failed");
await page.waitForFunction(() => document.body.dataset.done === "1", null, { timeout: 60_000 });
await sleep(2000);

// 2d. stellar.expert: esa misma tx
mark("expert-a");
await load(`https://stellar.expert/explorer/testnet/tx/${STORY_A_TX}`, "expert-a", () => page.getByText(/Status/).first().waitFor({ timeout: 30_000 }).catch(() => {}));
await sleep(1200);
const status = page.locator("xpath=//*[starts-with(normalize-space(.),'Status:') and not(.//*[starts-with(normalize-space(.),'Status:')])]").first();
await highlight(status, "255,82,82");
await cursorTo(status);
await sleep(2200);
const transfer = page.locator("xpath=//*[contains(normalize-space(.),'transfer(') and not(.//*[contains(normalize-space(.),'transfer(')])]").first();
await highlight(transfer, "245,183,0");
await cursorTo(transfer);
await sleep(4200);

// 3. Prueba de fuego en /app
mark("fire");
await load(BASE + "/app#fire", "fire-load", () => page.getByTestId("fire-send").waitFor({ timeout: 60_000 }));
await page.waitForFunction(() => !document.querySelector('[data-testid="fire-send"]')?.disabled, null, { timeout: 60_000 });
await scrollToEl(page.locator("#fire"), 24, 900);
await sleep(1200);
await cursorTo(page.getByTestId("fire-order"));
await sleep(2600);
mark("fire-click");
await click(page.getByTestId("fire-send"));
mark("wait-start", { why: "fire" });
await page.getByTestId("fire-live-tx").or(page.locator("#fire .note.err")).first().waitFor({ timeout: 90_000 });
mark("wait-end");
if (!(await page.getByTestId("fire-live-tx").count())) {
  result.fireFail = await page.locator("#fire .note.err").innerText();
  throw new Error("fire test fallo: " + result.fireFail);
}
result.fireTx = (await page.getByTestId("fire-live-tx").getAttribute("href")).split("/").pop();
result.fireText = (await page.locator(".fire-result-text").innerText()).replace(/\s+/g, " ");
result.fireBalance = await page.locator(".fire-balance").innerText().catch(() => null);
mark("fire-result", { tx: result.fireTx });
await sleep(600);
await cursorTo(page.getByTestId("fire-stamp"));
await sleep(2600);
await cursorTo(page.getByTestId("fire-live-tx"));
await sleep(3400);

// 4. Compra legitima por x402: Try as an agent
mark("try");
await page.getByTestId("demo-status").waitFor({ timeout: 60_000 });
await scrollToEl(page.locator("#try"), 24, 1600);
await sleep(1600);
result.statusBefore = (await page.getByTestId("demo-status").innerText()).replace(/\s+/g, " ");
mark("pay-click");
await click(page.getByTestId("demo-pay"));
mark("wait-start", { why: "pay" });
await page.getByTestId("demo-paid").or(page.getByTestId("demo-fail")).first().waitFor({ timeout: 90_000 });
mark("wait-end");
if (await page.getByTestId("demo-fail").isVisible()) {
  result.payFail = await page.getByTestId("demo-fail").innerText();
  throw new Error("pago fallo: " + result.payFail);
}
result.payOutcome = await page.getByTestId("demo-paid").getAttribute("data-outcome");
result.payTx = ((await page.getByTestId("demo-tx").getAttribute("href").catch(() => "")) || "").split("/").pop();
result.payText = (await page.getByTestId("demo-paid").innerText()).replace(/\s+/g, " ").slice(0, 400);
if (result.payOutcome !== "paid" || !result.payTx) throw new Error("pago sin SUCCESS: " + result.payText);
mark("paid", { tx: result.payTx });
await scrollToEl(page.locator(".try-steps"), 30, 1400);
await sleep(600);
await cursorTo(page.locator(".try-step").nth(1));
await sleep(2200);
await cursorTo(page.getByTestId("demo-402"));
await sleep(2400);
await cursorTo(page.getByTestId("demo-tx"));
await sleep(3000);

// 5. Panel del dueno y catalogo
mark("panel");
await scrollTo(0, 1000);
await click(page.getByTestId("tab-cuenta"));
mark("wait-start", { why: "panel" });
await page.locator("#gasto").waitFor({ timeout: 60_000 });
await page.locator("#payees").waitFor({ timeout: 60_000 });
await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
await sleep(800);
mark("wait-end");
await sleep(1200);
await highlight(page.locator("#gasto"));
await cursorTo(page.locator("#gasto"));
await sleep(3000);
await unhighlight(page.locator("#gasto"));
await scrollTo(330, 1400);
await highlight(page.locator("#payees"));
await cursorTo(page.locator("#payees"));
await sleep(3600);
await unhighlight(page.locator("#payees"));
await scrollTo(0, 900);

mark("catalog");
await click(page.getByTestId("tab-catalogo"));
mark("wait-start", { why: "catalog" });
await page.getByTestId("catalog").waitFor({ timeout: 60_000 });
await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
await sleep(600);
mark("wait-end");
await sleep(1200);
await cursorTo(page.locator(".svc").first());
await sleep(1800);
await cursorTo(page.locator(".svc").nth(2));
await sleep(2600);

// 6. Cierre: la vision marketplace en la landing y la placa final
mark("market");
await load(BASE + "/", "market", () => page.locator("#market").waitFor({ timeout: 30_000 }));
await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; const el = document.getElementById("market"); scrollTo(0, el.getBoundingClientRect().top + scrollY - 40); });
await sleep(1500);
await cursorTo(page.locator("#market h2"));
await sleep(3000);
await cursorTo(page.locator("#market h3").nth(2));
await sleep(3600);

mark("outro");
await page.goto(file("close.html"), { waitUntil: "load" });
await sleep(6500);
await tick();
mark("end");
await sleep(300);
await cdp.send("Page.stopScreencast");
await browser.close();
result.frames = frames.length;
result.pageErrors = errors;
fs.writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify({ viewport: { width: W, height: H }, frames, marks, result }, null, 1));
console.log(JSON.stringify(result, null, 2));
