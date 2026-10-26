// Headless Chromium test of /presentacion (5 slides, HackMeridian template) and /notas.
// Usage: node deck/e2e-pitch.mjs [baseUrl] [--shots dir] [--no-ntfy]
// Without baseUrl it starts scripts/serve-site.mjs on 127.0.0.1:4180.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { chromium } = await import(resolve(root, "web/node_modules/playwright/index.mjs"));
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let base = argv.find((a) => /^https?:/.test(a));
const shots = opt("--shots");
const useNtfy = !argv.includes("--no-ntfy");
const DASH = String.fromCharCode(0x2014);
const N = 5;
let srv = null;
if (!base) {
  base = "http://127.0.0.1:4180";
  srv = spawn(process.execPath, [resolve(root, "scripts/serve-site.mjs"), "4180"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));
}
if (shots) mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok: !!ok, info }); console.log(`${ok ? "OK  " : "FAIL"} ${name}${info ? "  " + info : ""}`); };
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

const browser = await chromium.launch();
try {
  // 1) every slide: renders, no errors, nothing overflows, template chrome present
  {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    for (let n = 1; n <= N; n++) {
      await page.goto(`${base}/presentacion?slide=${n}`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => {
        const s = document.querySelector(".slide.active");
        const c = s.querySelector(".content");
        const imgs = [...s.querySelectorAll("img")].every((i) => i.complete && i.naturalWidth > 0);
        return {
          active: [...document.querySelectorAll(".slide")].findIndex((x) => x.classList.contains("active")) + 1,
          count: document.getElementById("count").textContent,
          overflow: c ? c.scrollHeight > c.clientHeight + 1 : false,
          platform: s.querySelector(".tb.l, .tb.r")?.textContent ?? "",
          imgs,
          lang: document.documentElement.lang,
        };
      });
      check(`slide ${n} active, nothing overflows, logos loaded`, st.active === n && !st.overflow && st.imgs, `${st.count}${st.overflow ? " OVERFLOW" : ""}`);
      check(`slide ${n} keeps the template counter`, new RegExp(`PLATFORM 0${n} / 05`).test(await page.evaluate(() => document.querySelector(".slide.active").textContent)));
      if (shots) await page.screenshot({ path: `${shots}/slide-${n}.png` });
    }
    const text = await page.evaluate(() => [...document.querySelectorAll(".slide")].map((s) => s.textContent).join(" ") + document.body.innerText);
    check("no em dash in the deck (slides and notes)", !text.includes(DASH));
    check("no template guidance text left", !/Show how your project|Present your idea|This is where you explain|Here you explain|Finally, explain|Think:/.test(text));
    check("team slide names only Lucas Cariddi (PITCH.md)", /Lucas Cariddi/.test(text) && !/Leo|Cagliero/.test(text));
    const photo = await page.evaluate(() => {
      const im = document.querySelectorAll(".slide")[4]?.querySelector("img.avatar");
      return im ? { ok: im.complete && im.naturalWidth >= 400, alt: im.alt, w: im.naturalWidth, r: getComputedStyle(im).borderRadius } : null;
    });
    check("team slide shows Lucas Cariddi's photo in the circle", photo?.ok && photo.alt === "Lucas Cariddi" && photo.r === "50%", photo ? `${photo.w}px, alt "${photo.alt}", radius ${photo.r}` : "no photo");
    check("no [PLACEHOLDER] left", !/\[[A-Z][A-Z ]+\]/.test(text));
    const words = await page.evaluate(() => [...document.querySelectorAll(".slide")].map((s) => {
      const inj = s.querySelector('aside.note[data-when="injection"]');
      const n = (window.PP_EVIDENCE?.injection && inj) || s.querySelector("aside.note:not([data-when])");
      return [...n.querySelectorAll("p:not(.cue)")].reduce((a, p) => a + (p.textContent.match(/\S+/g) || []).length, 0);
    }));
    const total = words.reduce((a, b) => a + b, 0);
    check("spoken script under 260 words (2:30 limit)", total < 260, `${total} words: ${words.join(" + ")}`);
    const budget = await page.evaluate(() => [...document.querySelectorAll(".slide")].reduce((a, s) => a + +s.dataset.dur, 0));
    check("slide budgets add up to 2:05 (+0:25 buffer = 2:30)", budget === 125, `${budget} s`);
    // slide 2: the stamp carries a real tx linked to stellar.expert, and the muted video
    await page.goto(`${base}/presentacion#s2`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    const v = await page.evaluate(() => { const el = document.getElementById("demo"); const a = document.getElementById("s2stamp"); return { muted: el.muted, poster: el.getAttribute("poster"), src: el.getAttribute("src"), err: el.error?.code ?? null, href: a.href, stamp: a.textContent.replace(/\s+/g, " ").trim() }; });
    check("slide 2 by #s2: muted video with poster", v.muted && v.poster === "/media/demo-poster.png" && v.src === "/media/demo.mp4", JSON.stringify({ muted: v.muted, err: v.err }));
    check("slide 2 stamp links a real tx on stellar.expert", /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/.test(v.href) && /REJECTED/.test(v.stamp), v.stamp);
    for (const f of ["/media/demo-poster.png", "/media/passport-pay.pptx", "/media/passport-pay.pdf", "/media/demo.mp4", "/media/team-lucas.jpg", "/evidence.js"]) {
      const r = await page.request.get(`${base}${f}`);
      check(`${f} answers 200`, r.status() === 200, `${(await r.body()).length} bytes`);
    }
    // keyboard
    await page.goto(`${base}/presentacion`, { waitUntil: "load" });
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowLeft");
    check("keys: → → ← leave slide 2 and hash #s2", (await page.textContent("#count")) === `2 / ${N}` && new URL(page.url()).hash === "#s2", page.url());
    await page.keyboard.press("End");
    check("keys: End goes to the last slide", (await page.textContent("#count")) === `${N} / ${N}`);
    await page.keyboard.press("n");
    check("key N opens the speaker notes", await page.evaluate(() => document.getElementById("notes").classList.contains("open") && document.getElementById("ntext").textContent.length > 50));
    check("no JS errors in the deck", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // 2) touch
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(`${base}/presentacion`, { waitUntil: "load" });
    const swipe = (x0, x1) => page.evaluate(([a, b]) => {
      const t = (x) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 400 });
      document.dispatchEvent(new TouchEvent("touchstart", { touches: [t(a)], changedTouches: [t(a)], bubbles: true }));
      document.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [t(b)], bubbles: true }));
    }, [x0, x1]);
    await swipe(300, 80); await swipe(300, 80); await swipe(80, 300);
    check("touch: two swipes left and one right leave slide 2", (await page.textContent("#count")) === `2 / ${N}`);
    if (shots) await page.screenshot({ path: `${shots}/mobile-deck.png` });
    await page.goto(`${base}/notas#s3`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const noH = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check("notes on a phone: start at #s3, no horizontal scroll", (await page.textContent("#pos")) === `3 / ${N}` && noH);
    if (shots) await page.screenshot({ path: `${shots}/mobile-notes.png` });
    await ctx.close();
  }

  // 3) same computer: BroadcastChannel between two tabs
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const deck = await ctx.newPage();
    const notes = await ctx.newPage();
    const errors = [];
    notes.on("pageerror", (e) => errors.push(String(e)));
    await deck.goto(`${base}/presentacion`, { waitUntil: "load" });
    await notes.goto(`${base}/notas`, { waitUntil: "load" });
    await notes.waitForSelector("#list a");
    await deck.bringToFront();
    await deck.keyboard.press("ArrowRight"); await deck.keyboard.press("ArrowRight");
    const okA = await waitFor(async () => (await notes.textContent("#pos")) === `3 / ${N}`, 5000);
    check("BroadcastChannel: deck → notes (slide 3)", okA, await notes.textContent("#meta"));
    const title3 = await notes.textContent("#title");
    check("notes show the title and the script of slide 3", /PMF/.test(title3) && (await notes.textContent("#text")).length > 120, title3);
    check("notes show the next slide and the total time", /Technical Workflow/.test(await notes.textContent("#nextline")) && /of 02:30/.test(await notes.textContent("#of")));
    await notes.click("#bnext");
    const okB = await waitFor(async () => (await deck.textContent("#count")) === `4 / ${N}`, 5000);
    check("BroadcastChannel: notes → deck (slide 4)", okB, await deck.textContent("#count"));
    check("deck hash #s4", new URL(deck.url()).hash === "#s4", deck.url());
    const pv = await notes.evaluate(() => [document.getElementById("pvNow").src, document.getElementById("pvNext").src]);
    check("embedded previews point to the deck", pv.every((u) => u.includes("/presentacion?embed=1")), pv.join(" "));
    // The preview is an iframe that reloads with the new slide: over the network that takes a
    // moment, so wait for the 'Now' frame (the one whose URL is pvNow's src) to show slide 4.
    let pvCount = -1;
    await waitFor(async () => {
      const src = await notes.evaluate(() => document.getElementById("pvNow").src);
      const f = notes.frames().find((fr) => fr.url() === src) ?? notes.frames().find((fr) => fr.url().includes("embed=1") && fr.url().includes("slide="));
      pvCount = f ? await f.evaluate(() => [...document.querySelectorAll(".slide")].findIndex((s) => s.classList.contains("active")) + 1).catch(() => -1) : -1;
      return pvCount === 4;
    }, 10000);
    check("'Now' preview follows slide 4", pvCount === 4, String(pvCount));
    if (shots) await notes.screenshot({ path: `${shots}/notes-desktop.png` });
    await deck.bringToFront();
    // the controls hide when the mouse is still: wake them up like a person would
    await deck.mouse.move(700, 450); await deck.mouse.move(720, 460);
    await deck.click("#bphone");
    const sala = await deck.textContent("#pcode");
    const qrOk = await waitFor(() => deck.evaluate(() => !!document.querySelector("#pqr img, #pqr canvas")), 5000);
    const link = await deck.getAttribute("#plink", "href");
    check("Notes on phone: 6 char room, QR and a /notas?sala= link", /^[A-Z2-9]{6}$/.test(sala) && qrOk && link.includes(`/notas?sala=${sala}#s4`), `${sala} ${link}`);
    check("the deck URL keeps ?sala=", new URL(deck.url()).searchParams.get("sala") === sala);
    if (shots) await deck.screenshot({ path: `${shots}/notes-on-phone.png` });
    check("no JS errors in the notes", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // 4) another device: ntfy.sh with a room (two separate contexts, no shared BroadcastChannel)
  if (useNtfy) {
    const sala = "T" + Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z2-9]/g, "X");
    const c1 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const deck = await c1.newPage();
    const phone = await c2.newPage();
    await deck.goto(`${base}/presentacion?sala=${sala}`, { waitUntil: "load" });
    await phone.goto(`${base}/notas?sala=${sala}`, { waitUntil: "domcontentloaded" });
    await phone.waitForSelector("#list a");
    const conn = await waitFor(async () => /Room .*waiting|Synced/.test(await phone.textContent("#stxt")), 15000);
    check("ntfy: the phone joins the room", conn, await phone.textContent("#stxt"));
    await deck.waitForTimeout(1500);
    await deck.bringToFront();
    await deck.keyboard.press("ArrowRight"); await deck.waitForTimeout(300); await deck.keyboard.press("ArrowRight"); await deck.waitForTimeout(300); await deck.keyboard.press("ArrowRight");
    const okA = await waitFor(async () => (await phone.textContent("#pos")) === `4 / ${N}`, 20000);
    check(`ntfy: deck → phone (room ${sala}, slide 4)`, okA, await phone.textContent("#pos"));
    check("ntfy: the phone says Synced", /Synced/.test(await phone.textContent("#stxt")), await phone.textContent("#stxt"));
    await phone.click("#bnext");
    const okB = await waitFor(async () => (await deck.textContent("#count")) === `5 / ${N}`, 20000);
    check("ntfy: phone → deck (slide 5)", okB, await deck.textContent("#count"));
    if (shots) await phone.screenshot({ path: `${shots}/ntfy-phone.png` });
    await c1.close(); await c2.close();
  }
} finally {
  await browser.close();
  srv?.kill();
}
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} OK`);
process.exit(fails.length ? 1 : 0);
