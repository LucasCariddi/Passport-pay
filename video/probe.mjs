// Sondeo rapido de produccion antes de grabar: capturas de cada pantalla y posiciones clave.
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.argv[2] || "https://passport-pay-stellar.vercel.app";
const OUT = process.argv[3] || "/var/tmp/pp-video/probe";
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ["--hide-scrollbars"] });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "light", locale: "en-US" });
const p = await ctx.newPage();
const info = {};
for (const [name, url] of [["landing", "/"], ["trampa", "/trampa"], ["fire", "/app#fire"], ["try", "/app#try"], ["panel", "/app#panel"], ["catalog", "/app#catalog"]]) {
  await p.goto(BASE + url, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => console.log("goto", name, String(e)));
  await p.waitForTimeout(2500);
  info[name] = await p.evaluate(() => ({
    h: document.documentElement.scrollHeight,
    y: scrollY,
    title: document.title,
    sections: [...document.querySelectorAll("section, h1, h2, h3")].slice(0, 40).map((e) => ({ tag: e.tagName, id: e.id, cls: e.className?.toString().slice(0, 40), top: Math.round(e.getBoundingClientRect().top + scrollY), text: (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) })),
  }));
  await p.screenshot({ path: `${OUT}/${name}.png` });
}
const st = await (await fetch(BASE + "/api/demo/status")).json().catch(() => null);
const inj = await (await fetch(BASE + "/api/demo/inject")).json().catch(() => null);
fs.writeFileSync(`${OUT}/info.json`, JSON.stringify({ info, st, inj }, null, 1));
console.log(JSON.stringify({ st, inj }, null, 1));
for (const [k, v] of Object.entries(info)) { console.log("##", k, v.h, v.title); for (const s of v.sections) console.log("  ", s.tag, s.id, s.top, s.text); }
await b.close();
