// Jury journey on production: / -> /app -> Probar como agente -> /presentacion -> /notas
import { chromium } from "playwright";
const base = process.argv[2];
const out = process.argv[3];
const pay = process.argv.includes("--pay");
const DASH = String.fromCharCode(0x2014);
const browser = await chromium.launch();
const report = {};
for (const [name, vp, mobile] of [["movil", { width: 375, height: 812 }, true], ["escritorio", { width: 1440, height: 900 }, false]]) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text()); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("/premium/")) errs.push(`http ${r.status()} ${r.url()}`); });
  const r = {};
  async function visit(key, path, extra) {
    errs.length = 0;
    const t = Date.now();
    const res = await page.goto(base + path, { waitUntil: "load", timeout: 60000 });
    if (key === "probar") { await page.getByTestId("tab-probar").click(); }
    await page.waitForTimeout(2500);
    const txt = await page.locator("body").innerText();
    const o = {
      status: res?.status(), ms: Date.now() - t, title: await page.title(),
      hscroll: await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      dash: txt.includes(DASH),
      aboveFold: (await page.evaluate(() => { const els=[...document.querySelectorAll("h1,h2,p,button,a")].filter(e=>{const b=e.getBoundingClientRect();return b.top>=0&&b.top<window.innerHeight&&b.width>0&&e.innerText.trim()}); return els.slice(0,14).map(e=>e.tagName+": "+e.innerText.trim().replace(/\s+/g," ").slice(0,110)); })),
      wide: await page.evaluate(() => [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== "fixed").slice(0, 6).map(e => e.tagName + "." + e.className + " r=" + Math.round(e.getBoundingClientRect().right))),
      tiny: await page.evaluate(() => [...document.querySelectorAll("p,li,span,a,button,td")].filter(e => e.innerText && e.innerText.trim() && parseFloat(getComputedStyle(e).fontSize) < 12 && e.getBoundingClientRect().width>0).length),
    };
    if (extra) Object.assign(o, await extra());
    await page.screenshot({ path: `${out}/prod-${key}-${name}.png`, fullPage: key !== "presentacion" && key !== "notas" });
    await page.screenshot({ path: `${out}/prod-${key}-${name}-fold.png` });
    o.errors = [...errs];
    r[key] = o;
  }
  await visit("landing", "/", async () => ({ ctas: await page.locator("a[href*='/app']").evaluateAll(a => a.map(x => x.innerText.trim()+"→"+x.getAttribute("href")).slice(0,6)) }));
  await visit("app", "/app", async () => ({ tabs: await page.locator("nav a, nav button, [role=tab]").evaluateAll(a => a.map(x => x.innerText.trim()).filter(Boolean).slice(0,12)) }));
  await visit("probar", "/app", async () => {
    const o = {};
    await page.getByTestId("demo-status").waitFor({ timeout: 60000 });
    o.statusLine = (await page.getByTestId("demo-status").innerText()).replace(/\s+/g, " ");
    o.payBtn = await page.getByTestId("demo-pay").innerText().catch(()=>null);
    o.overBtn = await page.getByTestId("demo-over").innerText().catch(()=>null);
    if (pay && name === "movil") {
      const t=Date.now();
      await page.getByTestId("demo-pay").click();
      await page.getByTestId("demo-paid").or(page.getByTestId("demo-fail")).first().waitFor({ timeout: 90000 });
      o.paySec = Math.round((Date.now()-t)/1000);
      if (await page.getByTestId("demo-fail").isVisible()) o.payFail = await page.getByTestId("demo-fail").innerText();
      else { o.payOutcome = await page.getByTestId("demo-paid").getAttribute("data-outcome"); o.payText = (await page.getByTestId("demo-paid").innerText()).replace(/\s+/g," ").slice(0,300); o.payTx = await page.getByTestId("demo-tx").getAttribute("href").catch(()=>null); }
      await page.screenshot({ path: `${out}/prod-probar-pago-${name}.png`, fullPage: true });
      const t2=Date.now();
      await page.getByTestId("demo-over").click();
      await page.getByTestId("demo-overcap").or(page.getByTestId("demo-fail")).first().waitFor({ timeout: 120000 });
      await page.waitForFunction(() => !document.querySelector('[data-testid="demo-over"]')?.hasAttribute("disabled"), null, { timeout: 120000 }).catch(()=>{});
      await page.waitForTimeout(800);
      o.overSec = Math.round((Date.now()-t2)/1000);
      if (await page.getByTestId("demo-overcap").isVisible()) {
        o.overOutcome = await page.getByTestId("demo-overcap").getAttribute("data-outcome");
        o.overText = (await page.getByTestId("demo-overcap").innerText()).replace(/\s+/g," ").slice(0,500);
        o.forcedStatus = await page.getByTestId("demo-forced").getAttribute("data-status").catch(()=>null);
        o.forcedTx = await page.getByTestId("demo-forced-tx").getAttribute("href").catch(()=>null);
      } else o.overFail = await page.getByTestId("demo-fail").innerText();
      o.statusAfter = (await page.getByTestId("demo-status").innerText()).replace(/\s+/g, " ");
      const el = page.getByTestId("demo-overcap").or(page.getByTestId("demo-fail")).first();
      await el.scrollIntoViewIfNeeded().catch(()=>{});
    }
    return o;
  });
  await visit("presentacion", "/presentacion", async () => {
    const o = {};
    o.slideCount = await page.evaluate(() => document.querySelectorAll("section, .slide").length);
    // try keyboard and tap navigation
    const before = await page.evaluate(() => location.hash + "|" + document.body.innerText.slice(0,80));
    if (mobile) { await page.mouse.click(vp.width - 30, vp.height/2); } else { await page.keyboard.press("ArrowRight"); }
    await page.waitForTimeout(800);
    o.navChanged = before !== await page.evaluate(() => location.hash + "|" + document.body.innerText.slice(0,80));
    await page.screenshot({ path: `${out}/prod-presentacion-${name}-2.png` });
    return o;
  });
  await visit("notas", "/notas");
  report[name] = r;
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
