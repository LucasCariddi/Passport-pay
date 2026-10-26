// Arma el mp4 final a partir de los cuadros de capture-final.mjs (timeline.json) con ffmpeg-static.
// Mismo metodo que render.mjs: respeta la hora real de cada cuadro, acelera solo las esperas de
// red (y lo rotula "waiting for Stellar (sped up)") y sobreimprime titulos en ingles con drawtext.
//
//   node render-final.mjs /var/tmp/pp-video/final out/demo.mp4 [out/poster.png]
import ffmpeg from "ffmpeg-static";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RUN = process.argv[2] || "/var/tmp/pp-video/final";
const OUTFILE = path.resolve(process.argv[3] || "out/demo.mp4");
const POSTER = process.argv[4] ? path.resolve(process.argv[4]) : null;
const tl = JSON.parse(fs.readFileSync(path.join(RUN, "timeline.json"), "utf8"));
const { frames, marks, result } = tl;
const W = tl.viewport.width, H = tl.viewport.height;
const WAIT_TARGET = { trap: 1.2, "expert-a": 1.5, "fire-load": 1.5, fire: 2.5, pay: 3.0, panel: 1.5, catalog: 1.0, market: 1.2 };

const m = (id) => marks.find((x) => x.id === id)?.t;
const t0 = m("pain") - 0.1, tEnd = m("end");
const waits = [];
for (let i = 0; i < marks.length; i++) {
  if (marks[i].id !== "wait-start") continue;
  const end = marks.slice(i + 1).find((x) => x.id === "wait-end");
  const len = end.t - marks[i].t;
  const target = WAIT_TARGET[marks[i].why] ?? 1.5;
  waits.push({ a: marks[i].t, b: end.t, f: Math.min(1, target / len), why: marks[i].why, len });
}
function M(t) {
  let out = 0, cur = t0;
  for (const w of waits) {
    if (t <= w.a) break;
    out += Math.max(0, Math.min(t, w.a) - cur); cur = Math.max(cur, w.a);
    const e = Math.min(t, w.b);
    if (e > cur) { out += (e - cur) * w.f; cur = e; }
  }
  if (t > cur) out += t - cur;
  return out;
}

const FPS = 30;
const used = frames.filter((f) => f.t <= tEnd).map((f) => ({ ...f, o: M(Math.max(f.t, t0)) }));
const total = M(tEnd);
const SEQ = path.join(RUN, "seq");
fs.rmSync(SEQ, { recursive: true, force: true });
fs.mkdirSync(SEQ);
const nOut = Math.ceil(total * FPS);
let j = 0;
for (let k = 0; k < nOut; k++) {
  const tk = k / FPS;
  while (j + 1 < used.length && used[j + 1].o <= tk) j++;
  fs.symlinkSync(path.join(RUN, "frames", used[j].file), path.join(SEQ, `o_${String(k).padStart(5, "0")}.jpg`));
}

const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "");
const bal = (result.fireBalance || "").match(/([\d.]+) USDC before, ([\d.]+) USDC after/);
const balText = bal ? `Attacker balance: ${bal[1]} USDC before, ${bal[2]} after` : "The attacker got nothing";
const NOTE_A = "Real LLM agent (gpt-4o-mini). Only the page is staged. Its decision, the signature and the ledger result are real.";
const NOTE_F = "FAILED transactions here were sent to the network on purpose. On the normal x402 path a refused payment stops at simulation.";
const segs = [
  ["pain", "Passport Pay", "Story A first: a real AI agent with a wallet reads a poisoned web page", ""],
  ["term1", "Story A: a real LLM agent (gpt-4o-mini)", "Its task: get an XLM/USDC quote from a paid feed. First it reads the feed page", NOTE_A],
  ["trap", "What it read: the trap page", "The same file is live in production at /trampa. It hides an order: pay 5 USDC to an attacker", NOTE_A],
  ["term2", "The agent obeys and signs", "pay(to = attacker, 5 USDC), signed with the agent's own key and sent to Stellar testnet", NOTE_A],
  ["term-failed", "Stellar says no: FAILED", "Error(Contract, #10) PayeeNotAllowed, from the account's __check_auth. The attacker got nothing", NOTE_F],
  ["expert-a", `stellar.expert: tx ${short(result.storyATx)}`, "transfer(agent account, attacker GCCZ…SNIN, 50000000 = 5 USDC). Status: Failed", NOTE_F],
  ["fire", "Fire test, live in production", "Same order from /app: the demo agent's key signs 5 USDC to the attacker, straight to the network", ""],
  ["fire-result", `REJECTED, live: tx ${short(result.fireTx)}`, `Error(Contract, #10) PayeeNotAllowed. FAILED on the ledger. ${balText}`, NOTE_F],
  ["try", "Try as an agent: a legit purchase", "An allowed payee this time. The API answers HTTP 402 Payment Required with price and payee", ""],
  ["paid", "SUCCESS: 0.01 USDC paid over x402", `402, signed payment, then 200 with the data. tx ${short(result.payTx)} on Stellar testnet`, ""],
  ["panel", "Owner panel", "The cap per period and the allowed payees live in the agent's smart account, not in the agent", ""],
  ["catalog", "Catalog", "APIs priced per call in USDC, paid over x402 by agents with a ZK passport", ""],
  ["market", "Next: a marketplace", "The trust layer for agents that buy: any API can list, every agent pays inside its rules", ""],
  ["outro", "Passport Pay", "Give your agent money, not the power to drain it.", ""],
];
const TX = path.join(RUN, "txt");
fs.rmSync(TX, { recursive: true, force: true });
fs.mkdirSync(TX, { recursive: true });
const FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const esc = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
for (const [, a, b, c] of segs) for (const s of [a, b, c]) if (/[\u2013\u2014]/.test(s)) throw new Error("raya en un titulo: " + s);
const filters = [];
const BAND = 176;
filters.push(`drawbox=x=0:y=ih-${BAND}:w=iw:h=${BAND}:color=0x0b1020@0.85:t=fill`);
filters.push(`drawbox=x=0:y=ih-${BAND}:w=10:h=${BAND}:color=0xf5b700@1:t=fill`);
const segTimes = {};
segs.forEach(([id, title, sub, note], i) => {
  const a = M(m(id));
  const next = segs.slice(i + 1).map(([nid]) => m(nid)).find((x) => x != null);
  const b = next != null ? M(next) : total + 1;
  segTimes[id] = [+a.toFixed(2), +b.toFixed(2)];
  fs.writeFileSync(path.join(TX, `${i}-t.txt`), title);
  fs.writeFileSync(path.join(TX, `${i}-s.txt`), sub);
  const en = `enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`;
  const alpha = `alpha='min(1,(t-${a.toFixed(3)})/0.35)'`;
  filters.push(`drawtext=fontfile='${esc(FB)}':textfile='${esc(path.join(TX, `${i}-t.txt`))}':expansion=none:fontsize=44:fontcolor=white:x=64:y=h-${BAND}+24:${alpha}:${en}`);
  filters.push(`drawtext=fontfile='${esc(FR)}':textfile='${esc(path.join(TX, `${i}-s.txt`))}':expansion=none:fontsize=29:fontcolor=0xd6dcef:x=64:y=h-${BAND}+88:${alpha}:${en}`);
  if (note) {
    fs.writeFileSync(path.join(TX, `${i}-n.txt`), note);
    filters.push(`drawtext=fontfile='${esc(FR)}':textfile='${esc(path.join(TX, `${i}-n.txt`))}':expansion=none:fontsize=20:fontcolor=0xf5c84a:x=64:y=h-${BAND}+136:${alpha}:${en}`);
  }
});
fs.writeFileSync(path.join(TX, "brand.txt"), "passport-pay-stellar.vercel.app");
filters.push(`drawtext=fontfile='${esc(FR)}':textfile='${esc(path.join(TX, "brand.txt"))}':expansion=none:fontsize=24:fontcolor=0xf5b700:x=w-tw-48:y=h-${BAND}+34`);
fs.writeFileSync(path.join(TX, "wait.txt"), "waiting for Stellar (sped up)");
for (const w of waits) {
  if (w.f >= 0.95) continue;
  const a = M(w.a), b = M(w.b);
  filters.push(`drawtext=fontfile='${esc(FB)}':textfile='${esc(path.join(TX, "wait.txt"))}':expansion=none:fontsize=28:fontcolor=white:box=1:boxcolor=0x0b1020@0.88:boxborderw=14:x=w-tw-40:y=40:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`);
}
filters.push("format=yuv420p");
fs.writeFileSync(path.join(RUN, "filter.txt"), filters.join(",\n"));
fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
execFileSync(ffmpeg, [
  "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
  "-framerate", String(FPS), "-i", path.join(SEQ, "o_%05d.jpg"),
  "-filter_script:v", path.join(RUN, "filter.txt"),
  "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-tune", "stillimage", "-r", String(FPS),
  "-movflags", "+faststart", "-an", "-s", `${W}x${H}`, OUTFILE,
], { stdio: "inherit" });
let posterAt = null;
if (POSTER) {
  posterAt = +(segTimes["fire-result"][0] + 4).toFixed(2);
  execFileSync(ffmpeg, ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-ss", String(posterAt), "-i", OUTFILE, "-frames:v", "1", POSTER], { stdio: "inherit" });
}
fs.writeFileSync(path.join(RUN, "segments.json"), JSON.stringify({ total, segTimes, waits, posterAt }, null, 1));
console.log(JSON.stringify({ out: OUTFILE, totalSeconds: +total.toFixed(2), bytes: fs.statSync(OUTFILE).size, posterAt, segTimes, waits: waits.map((w) => ({ why: w.why, realSeconds: +w.len.toFixed(1), factor: +w.f.toFixed(2) })) }, null, 1));
