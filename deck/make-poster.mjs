// Genera web/public/media/demo-poster.png (1600x900) desde deck/poster.html.
// Usa el playwright que ya está instalado en web/. Uso: node deck/make-poster.mjs
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { chromium } = await import(resolve(root, "web/node_modules/playwright/index.mjs"));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("file://" + resolve(root, "deck/poster.html"), { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
const out = resolve(root, "web/public/media/demo-poster.png");
await page.screenshot({ path: out });
await browser.close();
console.log("ok", out);
