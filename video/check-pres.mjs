import { chromium } from "playwright";
const U = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const media = [];
p.on("response", (r) => { if (r.url().includes("/media/")) media.push(r.status() + " " + r.url().split("/").pop()); });
await p.goto(U + "/presentacion?slide=6", { waitUntil: "load", timeout: 60000 });
await p.waitForTimeout(6000);
const info = await p.evaluate(() => {
  const v = document.querySelector('video[src="/media/demo.mp4"]');
  const active = document.querySelector(".slide.active, [data-active], .active");
  const missing = [...document.querySelectorAll("*")].filter((e) => /falta|todavía no/i.test(e.textContent || "") && e.offsetParent && e.children.length === 0).map((e) => e.textContent.trim()).slice(0, 3);
  return v ? { found: true, readyState: v.readyState, networkState: v.networkState, error: v.error && v.error.code, duration: v.duration, currentTime: v.currentTime, paused: v.paused, canH264: v.canPlayType('video/mp4; codecs="avc1.640028"'), visibleMissingNotice: missing } : { found: false };
});
await p.screenshot({ path: "/var/tmp/pp-video/pres-slide6.png" });
console.log(JSON.stringify({ info, media: [...new Set(media)], errs, title: await p.title() }, null, 1));
await b.close();