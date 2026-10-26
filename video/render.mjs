// Builds the mp4 from the frames of capture.mjs (timeline.json) with ffmpeg-static. It keeps the
// real time of every frame and only shortens the waits (page loads and testnet settlement),
// labelling each shortened stretch as sped up. One English caption per segment, burned in with
// drawtext. Fonts: Bricolage Grotesque, Public Sans and IBM Plex Mono from Google Fonts (cached
// in /var/tmp), with DejaVu as the fallback.
//
//   node render.mjs /var/tmp/pp-video/run ../web/public/media/demo.mp4
import ffmpeg from "ffmpeg-static";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RUN = process.argv[2] || "/var/tmp/pp-video/run";
const OUTFILE = path.resolve(process.argv[3] || "out/demo.mp4");
const tl = JSON.parse(fs.readFileSync(path.join(RUN, "timeline.json"), "utf8"));
const { frames, marks, result } = tl;
const W = tl.viewport.width, H = tl.viewport.height;
const PROD = "https://passport-pay-stellar.vercel.app";
const LOADS = new Set(["landing", "trap", "terminal", "expert", "app", "outro"]);
const WAIT_TARGET = { landing: 0.8, trap: 0.8, terminal: 0.4, expert: 1.2, app: 1.2, outro: 0.5, pay: 2.6, fire: 2.6 };

const m = (id) => marks.find((x) => x.id === id)?.t;
const t0 = marks[0].t, tEnd = m("end");
// Waits: wait-start / wait-end pairs
const waits = [];
for (let i = 0; i < marks.length; i++) {
  if (marks[i].id !== "wait-start") continue;
  const end = marks.slice(i + 1).find((x) => x.id === "wait-end");
  const len = end.t - marks[i].t;
  const target = WAIT_TARGET[marks[i].why] ?? 1;
  waits.push({ a: marks[i].t, b: end.t, f: Math.min(1, target / len), why: marks[i].why, len });
}
// Real time -> video time (piecewise linear)
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

// Exactly 30 fps: for each output frame, the captured frame current at that moment (symlinks),
// so the drawtext times match the video's.
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

// Captions: [mark id, title, subtitle, small note]. Only real hashes, from this recording or
// from site/evidence.js (the LLM run). A caption whose mark is missing (a --dry run) is skipped.
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "");
const where = result.base === PROD ? "in production" : "pressed live";
const paidUsd = (/Paid ([0-9.]+) USDC/.exec(result.payText || "") || [])[1] || "0.01";
const REPLAY = "Replayed from scenario/last-run.txt: the same lines and UTC timestamps, with shorter waits.";
const segs = [
  ["pain", "The problem", "An AI agent with a wallet can be talked into paying an attacker by one poisoned web page."],
  ["trap", "Story A: a data feed with a hidden order", "We staged this page for the demo. Hidden in it: send 5 USDC to an attacker and do not ask.", "Educational decoy on Stellar testnet. Everything after it in Story A is real."],
  ["terminal", "A real LLM agent reads the page", "openai/gpt-4o-mini via the Vercel AI Gateway, with the Passport Pay MCP tools. Run of 26 Oct, 00:41 UTC.", REPLAY],
  ["agent-pays", "It obeys: pay(attacker, 5 USDC)", "Nobody was asked. The agent's own key signed the transfer and it went to Stellar testnet.", REPLAY],
  ["ledger-failed", "The ledger refuses: Error(Contract, #10)", "PayeeNotAllowed, returned by the agent account's __check_auth. Only the page was staged.", REPLAY],
  ["expert-llm", "On stellar.expert: FAILED", `Tx ${short(result.llmTx)}: a 5 USDC transfer to the attacker. The attacker received nothing.`, "The MCP pay tool sends it anyway. On the normal x402 path, simulation stops it before the network."],
  ["try", "A legitimate purchase over x402", "In the live app a demo agent asks for data. The API answers HTTP 402 with the price and who to pay."],
  ["paid", `Paid ${paidUsd} USDC: SUCCESS`, `A real payment on testnet to the allowed merchant, tx ${short(result.payTx)}. The agent gets its data.`],
  ["expert-pay", "On stellar.expert: SUCCESS", `Tx ${short(result.payTx)}: ${paidUsd} USDC from the agent's account to the merchant, settled over x402.`],
  ["panel", "Owner panel: the rules live in the account", "Cap 0.05 USDC per hour and one allowed payee, the merchant. Read live from the contract."],
  ["fire", `Fire test, ${where}`, "The server plays the hijacked agent: it signs the trap page's 5 USDC order with the agent's own key."],
  ["fire-rejected", "REJECTED onchain: PayeeNotAllowed #10", `Tx ${short(result.fireTx)} is FAILED on the ledger, from the same account that just paid the merchant.`, "Sent straight to the network on purpose, so there is a FAILED transaction to open."],
  ["catalog", "Catalog: paid APIs for agents", "Each call has a USDC price and is paid over x402. Only accounts from the passport factory can buy."],
  ["vision", "Next: a marketplace for agents", "Today one paid API. Next, any seller lists here, and every agent pays under its owner's onchain rules."],
  ["outro", null],
].filter(([id]) => m(id) != null);
for (const s of segs) for (const txt of s.slice(1)) if (txt && /\u2014/.test(txt)) throw new Error("em dash in a caption: " + txt);

// Fonts
const FONT_DIR = "/var/tmp/pp-video/fonts";
const WANT = { title: ["Bricolage Grotesque", 800], sub: ["Public Sans", 400], mono: ["IBM Plex Mono", 500], monoB: ["IBM Plex Mono", 600] };
const FALLBACK = { title: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", sub: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", mono: "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", monoB: "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" };
async function fonts() {
  fs.mkdirSync(FONT_DIR, { recursive: true });
  const out = {};
  for (const [k, [fam, wt]] of Object.entries(WANT)) {
    const file = path.join(FONT_DIR, `${fam.replace(/\s+/g, "")}-${wt}.ttf`);
    try {
      if (!fs.existsSync(file)) {
        const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${fam.replace(/\s+/g, "+")}:wght@${wt}`, { headers: { "user-agent": "curl/8" } })).text();
        const url = (/src:\s*url\((https:[^)]+\.ttf)\)/.exec(css) || [])[1];
        if (!url) throw new Error("no ttf for " + fam);
        fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
      }
      out[k] = file;
    } catch (e) {
      console.error(`font ${fam} ${wt}: ${e.message}, using DejaVu`);
      out[k] = FALLBACK[k];
    }
  }
  return out;
}
const F = await fonts();

const TX = path.join(RUN, "txt");
fs.rmSync(TX, { recursive: true, force: true });
fs.mkdirSync(TX, { recursive: true });
const esc = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
const txt = (name, s) => { const p = path.join(TX, name); fs.writeFileSync(p, s); return esc(p); };
const BAND = 184, BY = H - BAND;
const filters = [];
// A caption ends at the next caption or at the next page load, whichever comes first.
const loadStarts = waits.filter((w) => LOADS.has(w.why)).map((w) => w.a);
const shown = [];
segs.forEach(([id, title, sub, note], i) => {
  if (!title) return;
  const ta = m(id);
  const nextSeg = segs.slice(i + 1).map(([nid]) => m(nid)).find((x) => x != null) ?? tEnd;
  const nextLoad = loadStarts.find((x) => x > ta + 0.01) ?? Infinity;
  const a = M(ta), b = M(Math.min(nextSeg, nextLoad));
  shown.push({ id, a: +a.toFixed(2), b: +b.toFixed(2) });
  const en = `enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`;
  const alpha = `alpha='min(1,(t-${a.toFixed(3)})/0.35)'`;
  filters.push(`drawbox=x=0:y=${BY}:w=iw:h=${BAND}:color=0x0C1A13@0.92:t=fill:${en}`);
  filters.push(`drawbox=x=0:y=${BY}:w=10:h=${BAND}:color=0xE6D3A3@1:t=fill:${en}`);
  filters.push(`drawtext=fontfile='${esc(F.title)}':textfile='${txt(`${i}-t.txt`, title)}':expansion=none:fontsize=46:fontcolor=0xF5ECD3:x=64:y=${BY + 26}:${alpha}:${en}`);
  filters.push(`drawtext=fontfile='${esc(F.sub)}':textfile='${txt(`${i}-s.txt`, sub)}':expansion=none:fontsize=29:fontcolor=0xD6DED8:x=64:y=${BY + 92}:${alpha}:${en}`);
  if (note) filters.push(`drawtext=fontfile='${esc(F.mono)}':textfile='${txt(`${i}-n.txt`, note)}':expansion=none:fontsize=20:fontcolor=0x9FB3A6:x=64:y=${BY + 143}:${alpha}:${en}`);
  filters.push(`drawtext=fontfile='${esc(F.monoB)}':textfile='${txt("brand.txt", "passport-pay-stellar.vercel.app")}':expansion=none:fontsize=22:fontcolor=0xE6D3A3:x=w-tw-56:y=${BY + 38}:${en}`);
  filters.push(`drawtext=fontfile='${esc(F.mono)}':textfile='${txt("net.txt", "STELLAR TESTNET")}':expansion=none:fontsize=17:fontcolor=0x9FB3A6:x=w-tw-56:y=${BY + 70}:${en}`);
});
// "Sped up" chip on every shortened wait that lasts long enough to see
const spedUp = [];
for (const w of waits) {
  const a = M(w.a), b = M(w.b);
  if (w.f >= 0.95 || b - a < 0.5) continue;
  const label = LOADS.has(w.why) ? "Sped up: page loading" : "Sped up: waiting for Stellar testnet";
  spedUp.push({ why: w.why, a: +a.toFixed(2), b: +b.toFixed(2), realSeconds: +w.len.toFixed(1) });
  filters.push(`drawtext=fontfile='${esc(F.monoB)}':textfile='${txt(`wait-${w.why}-${spedUp.length}.txt`, label)}':expansion=none:fontsize=26:fontcolor=0xF5ECD3:box=1:boxcolor=0x0C1A13@0.9:boxborderw=14:x=w-tw-44:y=44:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`);
}
filters.push("format=yuv420p");
fs.writeFileSync(path.join(RUN, "filter.txt"), filters.join(",\n"));
fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
execFileSync(ffmpeg, [
  "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
  "-framerate", String(FPS), "-i", path.join(SEQ, "o_%05d.jpg"),
  "-filter_script:v", path.join(RUN, "filter.txt"),
  "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-tune", "stillimage", "-profile:v", "high", "-level", "4.0",
  "-r", String(FPS), "-movflags", "+faststart", "-an", "-s", `${W}x${H}`, OUTFILE,
], { stdio: "inherit" });
const segTimes = Object.fromEntries(segs.map(([id]) => [id, +M(m(id)).toFixed(1)]));
fs.writeFileSync(path.join(RUN, "segments.json"), JSON.stringify({ total, segTimes, shown, spedUp, fonts: F }, null, 1));
console.log(JSON.stringify({ out: OUTFILE, totalSeconds: +total.toFixed(1), bytes: fs.statSync(OUTFILE).size, segTimes, spedUp, fonts: F }, null, 1));
