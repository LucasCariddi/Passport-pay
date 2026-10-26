# Pitch deck spec: official HackMeridian 2026 template

The deck MUST use the official template in this folder (`template.pptx`, `template.pdf`,
`page-1.png` to `page-5.png`), downloaded from the organizers' Google Slides. Keep its layout,
colors, fonts, logos, header, footer, counters and NEXT labels. Replace only the guidance text
with our content. Exactly 5 slides, in the template's order.

## Template system (do not change)

- 16:9, 18288000 x 10287000 EMU (1920 x 1080 px on the web).
- Fonts: Instrument Sans (headings, heavy, uppercase titles), Inter Tight (body), JetBrains Mono
  (microtype: header, footer, counters, pills). All on Google Fonts.
- Colors: black `#0F0F0F`, yellow `#FDDA24`, paper `#F7F6F2`, rule `#DFDDD6`, text `#2A2A2A`,
  secondary `#5C5C5C`, white.
- Cover: black ground, yellow pill "PITCH DECK · MADE TO MOVE", huge yellow uppercase title,
  logos row (HackMeridian 2026 Lisbon / Guava / Stellar, from the template media), yellow
  triple-arrow, big M chevron at right, footer line with "October 2026", "#HackMeridian26",
  "© 2026 HackMeridian · Lisbon".
- Content slides: black top bar with "PLATFORM 0N / 05" (yellow, left), "HACKMERIDIAN 2026 ·
  LISBON" (center), "NEXT ▸ <next>" (right); yellow pill "PITCH STEP 0N / 04"; heavy uppercase
  title; bold lead line; three ▶ bullets; the "Think" box becomes our one-line answer; light M
  chevron watermark and yellow arrows at right; footer "© 2026 HackMeridian · Lisbon ·
  #HackMeridian26" and the HackMeridian logo.
- Our product identity (passport card, REJECTED stamp) may appear only as a visual inside the
  right-hand area of a content slide, never replacing the template chrome.

## Timing (hard limit: the whole pitch in 2:30)

The script below is ~245 words, about 1:50 to 2:00 spoken. Per-slide budget, shown in /notas
next to the timer (timer counts to 2:30 and turns stamp-red after 2:15):

| Slide | Budget |
|---|---|
| 1 Cover | 0:15 |
| 2 Solution | 0:30 |
| 3 PMF | 0:25 |
| 4 Technical Workflow | 0:35 |
| 5 Team | 0:20 |
| Buffer | 0:25 |

The demo video on slide 2 plays muted, looping, as a background visual while the speaker talks.
It never blocks or has to finish during the pitch. The separate submission video also targets
2:30 or less. Do not add slides or lengthen the script; if you change copy, keep the total under 260
words and show each slide's word count and budget in /notas.

## Slides (English, final copy; no em dashes)

### 1. Cover (PLATFORM 01 / 05)
- Pill: PITCH DECK · MADE TO MOVE
- Title: PASSPORT PAY
- Subtitle (one line under the title, Inter Tight): Give your agent money. Not the power to drain it.
- Small mono line: Genesis · Stellar Unlocked + Composed · passport-pay-stellar.vercel.app
- Footer as template.
- Notes: "Hi, this is Passport Pay. AI agents are starting to spend real money, and today the only
  thing standing between a hijacked agent and your wallet is hope. We fixed that on Stellar."

### 2. The Solution (PLATFORM 02 / 05 · PITCH STEP 01 / 04 · NEXT ▸ PMF)
- Lead: The spending rules live in the agent's own smart account, not in the agent.
- Bullets:
  - Agents pay for APIs over x402 in USDC, with a ZK passport proving a human stands behind them.
  - Every payment passes the account's checks: allowed payee, cap per period, not revoked.
  - A prompt-injected agent can sign anything. The network still refuses it.
- Think box: Why it's the best fix: it works even when the agent itself is compromised.
- Right visual: the REJECTED stamp with the real tx hash of the injection run (or the
  CapExceeded tx `bab36b82…de15` if that run is not available), and on the web the demo video
  (`/media/demo.mp4`, autoplay muted, loop) in that area.
- Notes: "Here's our real agent. It read a page with a hidden instruction to pay an attacker. It
  obeyed and signed. Stellar rejected it, because the rules are enforced by the agent's own
  contract account. x402 says how an agent pays. Passport Pay decides who can pay, whom, and how
  much, without trusting anyone."

### 3. PMF (PLATFORM 03 / 05 · PITCH STEP 02 / 04 · NEXT ▸ TECHNICAL WORKFLOW)
- Lead: Agents with wallets are shipping now, and prompt injection is the top risk for them.
- Bullets:
  - Owners: today you either babysit every payment or trust a cap that a hijacked agent bypasses.
  - Sellers: APIs can't open free tiers or sell to agents without bot farms eating them.
  - Ecosystem: x402 and MPP are live on Stellar; what's missing is bounded, human-backed authority.
- Think box: Why care: one injected page is enough to drain an agent's wallet. Ours lose zero.
- Use only claims we can back. Do not invent market numbers; if a number is needed, use a
  clearly marked [SOURCE NEEDED] placeholder and flag it to the user.
- Notes: "Every team building agents that pay hits the same wall: you can't hand an agent a
  budget without handing it the keys. And sellers can't trust who's on the other side. Passport
  Pay gives owners a hard limit and sellers a human behind every buyer."

### 4. Technical Workflow (PLATFORM 04 / 05 · PITCH STEP 03 / 04 · NEXT ▸ THE TEAM)
- Lead: Prove. Bind. Enforce. With the official x402 facilitator, unchanged.
- Bullets:
  - Prove: a Groth16 ZK passport made in the browser in ~2 s, verified on BN254 in Soroban.
  - Bind: PassportFactory verifies the proof and deploys the agent's smart account in one tx.
  - Enforce: PassportAccount.__check_auth checks passport, payee, cap and revocation on every
    USDC transfer; the ledger rejects anything else (real FAILED txs on testnet).
- Think box: Why it will succeed: it's live on testnet today, with 40+ contract tests and a
  public demo anyone can try.
  (Use the real current test counts from scripts/test-all.sh output.)
- Right visual: a compact 3-box flow (Owner → Factory → Agent account → x402 API) in template
  colors.
- Notes: "Three steps. Prove, bind, enforce. The key is that enforcement runs inside
  __check_auth, so the official facilitator rejects at simulation and the ledger rejects if
  anyone skips it. Prior work is declared: the ZK passport comes from our open-stellar-passport,
  and Open Stellar had the marketplace with checks in the backend. Here we moved them onchain."

### 5. The Team (PLATFORM 05 / 05 · PITCH STEP 04 / 04 · FINAL STOP)
- ONLY ONE PERSON appears on this slide: Lucas Cariddi. No other individual is named anywhere in
  the deck, the notes, the site, the README or AI.md (the other builder asked not to appear).
  Organizations (Bitcoindefi, Cosmos Pay) may still be named where prior work is declared.
- Lead: Rooted in the Stellar community in Buenos Aires.
- Member (max 3 lines, one photo placeholder circle with the initials "LC"):
  - Lucas Cariddi · Marketing and growth
  - Stellar Ambassador in Buenos Aires, co-organizer of Stellar community events.
  - Background in crypto and AI (Compoze Labs, Bitget). Studied at UTN FRBA.
- Under the member, one small mono line: Engineering on the shoulders of Bitcoindefi's
  open-stellar-passport and Open Stellar.
- Think box: Why us: we live in the Stellar community and we've seen agents with wallets fail; this is the missing piece.
- Links line (mono): passport-pay-stellar.vercel.app · github.com/LucasCariddi/passport-pay
- Notes: "I'm Lucas, I run marketing and growth, and I'm a Stellar Ambassador in Buenos Aires.
  We built this because every agent team we talk to hits the same wall. Try it yourself: the
  link is on screen. Thanks."
- The member lines are CONFIRMED by the user (25 oct). Keep them exactly as written here, do not
  add anything else about him. Photo stays as the
  "LC" initials circle unless a photo file appears at design/hackmeridian-template/team-lucas.jpg.

## Deliverables

- `/presentacion`: these 5 slides as web slides in the template look (1920x1080 scaled),
  keyboard and touch, `?slide=N`, `#sN`, notes with N, "Notes" button that opens /notas with a
  room and QR, downloads of the .pptx and the video.
- `/notas`: speaker view (current + next slide, the full script above per slide in English,
  timer, room status), synced by BroadcastChannel and ntfy.sh as today.
- ALREADY DONE: `deck/fill-template.py` fills `template.pptx` with the final copy (shorter
  than the slide text above, which is the source for the web deck and the notes) and was
  checked visually; output `design/hackmeridian-template/PassportPay_HackMeridian_Pitch.pptx`.
  Reuse it: run it with a python-pptx venv in /var/tmp to write `web/public/media/passport-pay.pptx`
  (add the injection tx hash to the stamp when the real run exists), and keep the web slides'
  copy consistent with it.
- `.pptx`: generated by FILLING `template.pptx` itself with python-pptx (keep every shape, image,
  layout and font of the template; replace text runs; add speaker notes; add the demo video or a
  poster image with a link). Output `web/public/media/passport-pay.pptx`. Also export a PDF.
- The site and app keep the Passport Pay identity from `design/claude-design/`; only the deck
  uses the HackMeridian template.
