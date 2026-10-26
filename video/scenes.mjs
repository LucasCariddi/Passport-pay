// Two local scenes for the demo video, written as HTML pages that capture.mjs opens in the
// same Chrome tab it records:
//   terminalHtml(text)  the real LLM agent run, replayed line by line from scenario/last-run.txt
//                       (same lines and UTC timestamps; only the waits between lines are shorter)
//   closingHtml(proof)  the closing card, with the real transactions of the recording
// Both are 1440x810 CSS px (1920x1080 frames at a device scale of 4/3). The bottom 140 px stay
// clear for the captions that render.mjs burns in. Colors and type follow design/claude-design.

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />' +
  '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />';

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const shortTx = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "");
const TS = /^\[(\d\d):(\d\d):(\d\d)Z\] ?(.*)$/;

/** Parses scenario/last-run.txt: the header block, then step 7 (the agent run) up to the agent's exit. */
export function parseRun(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const head = [];
  let i = 0;
  for (; i < lines.length && !TS.test(lines[i]); i++) {
    const l = lines[i];
    if (!l.trim() || /^=+$/.test(l.trim())) continue;
    head.push(l);
  }
  const log = [];
  let on = false;
  for (; i < lines.length; i++) {
    const m = TS.exec(lines[i]);
    if (!m) continue;
    if (/== 7\. THE REAL AGENT RUN ==/.test(m[4])) on = true;
    if (!on) continue;
    log.push({ ts: `${m[1]}:${m[2]}:${m[3]}Z`, sec: +m[1] * 3600 + +m[2] * 60 + +m[3], text: m[4] });
    if (/agent exited with code/.test(m[4])) break;
  }
  if (!log.length) throw new Error("scenario/last-run.txt: step 7 (the agent run) not found");
  return { head, log };
}

function classify(log) {
  let inModel = false;
  return log.map((l) => {
    const t = l.text;
    let cls = "plain";
    if (/^\[model\]/.test(t)) inModel = true;
    if (/^\(that was the model's final answer\)/.test(t)) inModel = false;
    if (/^\[tool\] pay\(/.test(t)) cls = "pay";
    else if (/ledger result: FAILED/.test(t)) cls = "fail";
    else if (/rejected by: __check_auth/.test(t)) cls = "fail2";
    else if (/enforcing simulation: rejected/.test(t)) cls = "warn";
    else if (/^VERDICT/.test(t)) cls = "verdict";
    else if (/^The agent FELL/.test(t) || /^Ledger result: FAILED/.test(t)) cls = "fail2";
    else if (/^\[tool\]/.test(t)) cls = "tool";
    else if (inModel) cls = "model";
    else if (/^=+|^== /.test(t) || /=====/.test(t)) cls = "rule";
    else if (/^\s*->/.test(t)) cls = "arrow";
    else if (/^\(/.test(t)) cls = "dim";
    return { ...l, cls };
  });
}

/** The agent run as a terminal replay. window.__start() plays it; window.__phase goes pay, failed, done. */
export function terminalHtml(text, { maxGapSec = 2.4, staggerMs = 110 } = {}) {
  const { head, log } = parseRun(text);
  const rows = classify(log);
  // Delay of each line: the real gap between UTC timestamps, capped, plus a short stagger.
  let t = 0;
  const timeline = rows.map((r, k) => {
    const gap = k ? r.sec - rows[k - 1].sec : 0;
    t += (gap > 0 ? Math.min(gap, maxGapSec) * 1000 : 0) + staggerMs;
    return { at: Math.round(t), cls: r.cls, ts: r.ts, html: esc(r.text) || "&nbsp;" };
  });
  const title = head[0] ?? "";
  const kv = head.slice(1).map((l) => {
    const m = /^([^:]+?)\s*:\s(.*)$/.exec(l);
    return m ? `<div class="kv"><span class="k">${esc(m[1].trim())}</span><span class="v">${esc(m[2])}</span></div>` : `<div class="kv"><span class="v">${esc(l)}</span></div>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>scenario/last-run.txt</title>${FONTS}
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1440px; height: 810px; overflow: hidden; background: #0C1A13; color: #EAF0EA; }
  body { font-family: "IBM Plex Mono", ui-monospace, monospace; }
  .win { position: absolute; left: 40px; top: 26px; width: 1360px; height: 632px; background: #13241B; border: 1px solid #2A3D33; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; }
  .bar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 20px; background: #1B2A22; border-bottom: 1px solid #2A3D33; }
  .bar .path { font: 600 15px/1 "IBM Plex Mono", monospace; color: #EAF0EA; }
  .bar .path b { color: #E6D3A3; font-weight: 600; }
  .bar .chip { font: 600 12px/1 "IBM Plex Mono", monospace; letter-spacing: .12em; text-transform: uppercase; color: #0C1A13; background: #E6D3A3; padding: 7px 11px; border-radius: 999px; }
  .scroll { flex: 1 1 auto; overflow: hidden; padding: 16px 24px 22px; font-size: 16.5px; line-height: 1.55; }
  .title { color: #F5ECD3; font-weight: 600; margin-bottom: 6px; }
  .kv { display: grid; grid-template-columns: 190px 1fr; column-gap: 12px; color: #EAF0EA; }
  .kv .k { color: #8FA396; }
  .head { padding-bottom: 12px; margin-bottom: 10px; border-bottom: 1px dashed #2A3D33; }
  .ln { display: grid; grid-template-columns: 118px 1fr; column-gap: 10px; opacity: 0; transform: translateY(4px); transition: opacity .18s, transform .18s; border-radius: 6px; }
  .ln.on { opacity: 1; transform: none; }
  .ln .ts { color: #8FA396; }
  .ln .tx { white-space: pre-wrap; overflow-wrap: anywhere; }
  .ln.rule .tx { color: #B8C6BC; }
  .ln.tool .tx { color: #9FD8C7; }
  .ln.arrow .tx { color: #B8C6BC; }
  .ln.dim .tx { color: #8FA396; }
  .ln.model .tx { color: #E6D3A3; }
  .ln.warn .tx { color: #FFD2C2; }
  .ln.pay { background: rgba(255,106,61,.16); }
  .ln.pay .tx { color: #FFD2C2; font-weight: 600; }
  .ln.fail { background: rgba(255,106,61,.22); }
  .ln.fail .tx, .ln.fail2 .tx { color: #FF8A64; font-weight: 600; }
  .ln.verdict .tx { color: #F5ECD3; font-weight: 600; }
  .cur { display: inline-block; width: 10px; height: 19px; background: #E6D3A3; vertical-align: -3px; animation: b 1s steps(1) infinite; margin-left: 128px; }
  @keyframes b { 50% { opacity: 0; } }
</style></head>
<body>
  <div class="win" role="img" aria-label="Replay of scenario/last-run.txt">
    <div class="bar"><span class="path">passport-pay <b>$</b> scenario/last-run.txt</span><span class="chip">Replay of the real log · UTC timestamps · waits shortened</span></div>
    <div class="scroll" id="scroll">
      <div class="head"><div class="title">${esc(title)}</div>${kv.join("")}</div>
      <div id="log">${timeline.map((l, k) => `<div class="ln ${l.cls}" id="l${k}"><span class="ts">[${l.ts}]</span><span class="tx">${l.html}</span></div>`).join("")}</div>
      <div><span class="cur" id="cur"></span></div>
    </div>
  </div>
<script>
  const T = ${JSON.stringify(timeline.map(({ at, cls }) => ({ at, cls })))};
  const sc = document.getElementById("scroll");
  window.__phase = "idle";
  // Keep the newest line in view, like a terminal.
  let target = 0;
  const follow = () => { const max = sc.scrollHeight - sc.clientHeight; target = Math.max(0, max); };
  const glide = () => { sc.scrollTop += (target - sc.scrollTop) * 0.18; requestAnimationFrame(glide); };
  requestAnimationFrame(glide);
  window.__start = () => {
    window.__phase = "running";
    T.forEach((l, k) => setTimeout(() => {
      document.getElementById("l" + k).classList.add("on");
      follow();
      if (l.cls === "pay" && window.__phase === "running") window.__phase = "pay";
      if (l.cls === "fail" && window.__phase === "pay") window.__phase = "failed";
      if (k === T.length - 1) setTimeout(() => { window.__phase = "done"; }, 400);
    }, l.at));
  };
</script>
</body></html>`;
}

/** Closing card. proof: { llmTx, payTx, fireTx } (real hashes; payTx and fireTx from this recording). */
export function closingHtml({ llmTx, payTx, fireTx, payLabel = "x402 purchase in /app", fireLabel = "Fire test in production" }) {
  const chip = (label, pill, ok, tx) =>
    `<div class="chip"><span class="cl">${esc(label)}</span><span class="pill ${ok ? "ok" : "bad"}">${esc(pill)}</span><span class="ch">tx ${esc(shortTx(tx))}</span></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Passport Pay</title>${FONTS}
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1440px; height: 810px; overflow: hidden; background: #12372A; color: #F5ECD3; font-family: "Public Sans", system-ui, sans-serif; }
  .in { position: absolute; left: 96px; top: 84px; width: 860px; }
  .eye { font: 600 14px/1 "IBM Plex Mono", monospace; letter-spacing: .14em; text-transform: uppercase; color: #BFAF86; }
  h1 { font: 800 112px/0.95 "Bricolage Grotesque", sans-serif; letter-spacing: -0.035em; color: #F5ECD3; margin-top: 26px; }
  .tag { font: 600 32px/1.2 "Public Sans", sans-serif; color: #E6D3A3; margin-top: 22px; letter-spacing: -0.01em; }
  .chips { display: flex; flex-direction: column; gap: 10px; margin-top: 40px; }
  .chip { display: grid; grid-template-columns: 290px 150px 1fr; align-items: center; gap: 14px; padding: 12px 16px; border: 1px solid #2E5544; border-radius: 12px; background: rgba(12,26,19,.32); }
  .cl { font: 500 17px/1.2 "Public Sans", sans-serif; color: #EAF0EA; }
  .ch { font: 500 16px/1 "IBM Plex Mono", monospace; color: #E6D3A3; }
  .pill { justify-self: start; font: 600 13px/1 "IBM Plex Mono", monospace; letter-spacing: .06em; padding: 7px 10px; border-radius: 999px; }
  .pill.ok { background: #E2F0EA; color: #0B4D43; }
  .pill.bad { background: #FBE4DC; color: #9A2A10; }
  .urls { margin-top: 34px; display: flex; flex-direction: column; gap: 8px; }
  .u1 { font: 600 26px/1.1 "IBM Plex Mono", monospace; color: #F5ECD3; }
  .u2 { font: 500 18px/1.1 "IBM Plex Mono", monospace; color: #BFAF86; }
  .stamp { position: absolute; left: 1040px; top: 150px; width: 300px; height: 300px; border-radius: 50%; border: 7px solid #FF6A3D; color: #FF6A3D; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; transform: rotate(-13deg); background: rgba(12,26,19,.25); }
  .stamp .m { font: 700 13px/1 "IBM Plex Mono", monospace; letter-spacing: .2em; }
  .stamp .w { font: 800 56px/1 "Bricolage Grotesque", sans-serif; letter-spacing: .01em; }
  .stamp .e { font: 700 17px/1.1 "IBM Plex Mono", monospace; }
  .stamp .t { font: 500 15px/1.1 "IBM Plex Mono", monospace; text-decoration: underline; text-underline-offset: 3px; }
  .note { position: absolute; left: 1010px; top: 486px; width: 360px; font: 400 15px/1.45 "Public Sans", sans-serif; color: #CFC3A0; text-align: center; }
  .mrz { position: absolute; left: 0; right: 0; bottom: 0; padding: 16px 96px 20px; background: #0C2A1F; font: 500 20px/1.3 "IBM Plex Mono", monospace; letter-spacing: .12em; color: #BFAF86; white-space: nowrap; overflow: hidden; }
</style></head>
<body>
  <div class="in">
    <p class="eye">Stellar testnet · HackMeridian Genesis · Tracks Stellar Unlocked + Composed</p>
    <h1>Passport Pay</h1>
    <p class="tag">Give your agent money. Not the power to drain it.</p>
    <div class="chips">
      ${chip("Real LLM agent, hidden order", "FAILED #10", false, llmTx)}
      ${chip(payLabel, "SUCCESS", true, payTx)}
      ${chip(fireLabel, "FAILED #10", false, fireTx)}
    </div>
    <div class="urls"><span class="u1">passport-pay-stellar.vercel.app</span><span class="u2">github.com/LucasCariddi/passport-pay</span></div>
  </div>
  <div class="stamp" aria-hidden="true"><span class="m">STELLAR TESTNET</span><span class="w">REJECTED</span><span class="e">PayeeNotAllowed #10</span><span class="t">tx ${esc(shortTx(llmTx))}</span></div>
  <p class="note">Every hash here is a real transaction on Stellar testnet, open on stellar.expert. No real money.</p>
  <div class="mrz">P&lt;STELLAR&lt;&lt;AGENT&lt;&lt;PASSPORT&lt;PAY&lt;&lt;PAYEE&lt;LIST&lt;&lt;CAP&lt;0.05USDC&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;</div>
</body></html>`;
}
