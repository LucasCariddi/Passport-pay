# Passport Pay deck (5 slides, 2:30)

The deck uses the official HackMeridian template (`design/hackmeridian-template/`): its layout,
colors, fonts, logos, header, footer, counters and NEXT labels stay as they are, and only the
guidance text is replaced with our content. Exactly 5 slides, in the template's order. The source
of truth for the copy is `design/hackmeridian-template/PITCH.md`; this page mirrors it, and the
claims check at the end ties each claim to its evidence.

Where it lives:

- Web slides: https://passport-pay-stellar.vercel.app/presentacion (`site/presentacion/index.html`).
  1920 x 1080 stage scaled to the screen, keyboard (arrows, Space, Home, End, F full screen, N
  notes) and touch, `?slide=N`, `#sN`, a "Notes on phone" button that opens `/notas` with a
  private room and a QR, and downloads of the `.pptx`, the `.pdf` and the demo video.
- Speaker view: `/notas` (`site/notas/index.html`): current and next slide, the full script of
  each slide with its word count and budget, a timer to 2:30 that turns red after 2:15, room
  status. Synced with the slides by BroadcastChannel (same computer) and ntfy.sh (phone).
- `.pptx` and `.pdf`: `/media/passport-pay.pptx` and `/media/passport-pay.pdf`.
  `deck/build-pptx.py` runs `deck/fill-template.py` (fills `template.pptx` itself with
  python-pptx), then copies the speaker notes from the web deck, puts the real contract test
  count and the LLM injection run's transaction on the stamp, checks the result
  (5 slides, no em dash, no guidance text left, only one person named) and exports the PDF with
  LibreOffice.
- Evidence: every transaction shown by the slides, `/notas`, the landing and the app comes from
  `site/evidence.js`. The real LLM injection run is there (`injection`: `b90a30c7…215b`,
  `openai/gpt-4o-mini`, 26 Oct), so the slide 2 stamp and its speaker note use it. If that field
  is ever set back to `null`, both fall back to the CapExceeded refusal and the "picture an
  agent" note.

Test: `node deck/e2e-pitch.mjs [baseUrl]` (Chromium headless: each slide renders without
overflow, template counters, no em dash, script under 260 words, budgets, video, downloads,
keyboard, touch, BroadcastChannel and ntfy.sh both ways).

## Timing (hard limit: 2:30)

The spoken script is 232 words today (counted by `/notas`), about 1:50 spoken.

| Slide | Starts | Budget |
|---|---|---|
| 1 Cover | 0:00 | 0:15 |
| 2 Solution | 0:15 | 0:30 |
| 3 PMF | 0:45 | 0:25 |
| 4 Technical Workflow | 1:10 | 0:35 |
| 5 Team | 1:45 | 0:20 |
| Buffer | 2:05 | 0:25 |

The demo video plays muted and looping on slide 2 as a background visual (never under reduced
motion). It never has to finish during the pitch.

---

## 1. Cover (PLATFORM 01 / 05)

- Pill: PITCH DECK · MADE TO MOVE
- Title: **PASSPORT PAY**
- Subtitle: Give your agent money. Not the power to drain it.
- Mono line: Genesis · Stellar Unlocked + Composed · passport-pay-stellar.vercel.app

> Notes: "Hi, this is Passport Pay. AI agents are starting to spend real money, and today the
> only thing standing between a hijacked agent and your wallet is hope. We fixed that on
> Stellar."

---

## 2. The Solution (PITCH STEP 01 / 04 · NEXT ▸ PMF)

- Lead: **The spending rules live in the agent's own smart account, not in the agent.**
- ▶ Agents pay for APIs over x402 in USDC, each with a ZK passport credential: one per agent,
  anti-Sybil by nullifier.
- ▶ Every payment passes the account's checks: allowed payee, cap per period, not revoked.
- ▶ A prompt-injected agent can sign anything. The network still refuses it.
- Think box: Why it's the best fix: it works even when the agent itself is compromised.
- Right visual: the REJECTED stamp with the real hash of the LLM injection run,
  `PayeeNotAllowed #10`, tx `b90a30c7…215b` (the CapExceeded transaction `bab36b82…de15` only if
  `injection` is null); on the web, the demo video in that area.

> Notes (the LLM run exists, so this is the one shown; PITCH.md's text plus the model and the
> word "rigged", so it is clear the feed is staged): "Here's our real agent, a GPT-4o mini
> model. It read a data feed we rigged with a hidden order to pay an attacker. It obeyed and
> signed. Stellar rejected it, because the rules are enforced by the agent's own contract
> account. x402 says how an agent pays. Passport Pay decides who can pay, whom, and how much,
> without trusting anyone."
>
> Fallback, only if `injection` is null: "Picture an agent that reads a page with a hidden
> instruction to pay an attacker. A hijacked agent obeys and signs. Stellar still refuses,
> because the rules are enforced by the agent's own contract account. The stamp is a real
> refusal on testnet. x402 says how an agent pays. Passport Pay decides who can pay, whom, and
> how much, without trusting anyone."

---

## 3. PMF (PITCH STEP 02 / 04 · NEXT ▸ TECHNICAL WORKFLOW)

- Lead: **Agents with wallets are shipping now, and prompt injection is the top risk for them.**
- ▶ Owners: today you either babysit every payment or trust a cap that a hijacked agent bypasses.
- ▶ Sellers: APIs can't open free tiers or sell to agents without bot farms eating them.
- ▶ Ecosystem: x402 and MPP are live on Stellar; what's missing is bounded authority for agents.
- Source line: Top risk: OWASP Top 10 for LLM Applications 2025, LLM01 Prompt Injection.
- Think box: Why care: one injected page is enough to drain an agent's wallet. Ours lost zero.
- No invented market numbers. If a number is ever needed, it goes in as a marked
  [SOURCE NEEDED] placeholder.

> Notes: "Every team building agents that pay hits the same wall: you can't hand an agent a
> budget without handing it the keys. And sellers can't trust who's on the other side. Passport
> Pay gives owners a hard limit and sellers a payer that brings its own controls."

---

## 4. Technical Workflow (PITCH STEP 03 / 04 · NEXT ▸ THE TEAM)

- Lead: **Prove. Bind. Enforce. With the official x402 facilitator, unchanged.**
- ▶ Prove: a Groth16 ZK passport made on the client in about 2 s, verified on BN254 in Soroban.
- ▶ Bind: PassportFactory verifies the proof and deploys the agent's smart account in one tx.
- ▶ Enforce: `PassportAccount.__check_auth` checks passport, payee, cap and revocation on every
  USDC transfer; the ledger rejects anything else (real FAILED transactions on testnet).
- Think box: Why it will succeed: it's live on testnet today, with 62 contract tests and a public
  demo anyone can try.
- Right visual: a compact flow, Owner → PassportFactory → Agent account → x402 API, in template
  colors. In the `.pptx` the title is shortened to WORKFLOW so it does not run into that visual.

> Notes: "Three steps. Prove, bind, enforce. The key is that enforcement runs inside
> __check_auth, so the official facilitator rejects at simulation and the ledger rejects if
> anyone skips it. Prior work is declared: the ZK passport comes from open-stellar-passport, and
> Open Stellar had the marketplace with checks in the backend. Here we moved them onchain."

---

## 5. The Team (PITCH STEP 04 / 04 · FINAL STOP)

- Lead: **Rooted in the Stellar community in Buenos Aires.**
- Member (photo in the yellow ring, `web/public/media/team-lucas.jpg`; only this person is named anywhere in the deck):
  - Lucas Cariddi · Marketing and growth
  - Stellar Ambassador in Buenos Aires, co-organizer of Stellar community events.
  - Background in crypto and AI (Compoze Labs, Bitget). Studied at UTN FRBA.
- Small mono line: Engineering on the shoulders of Bitcoindefi's open-stellar-passport and Open
  Stellar.
- Think box: Why us: we live in the Stellar community and we've seen agents with wallets fail;
  this is the missing piece.
- Links: passport-pay-stellar.vercel.app · github.com/LucasCariddi/passport-pay

> Notes: "I'm Lucas, I run marketing and growth, and I'm a Stellar Ambassador in Buenos Aires.
> We built this because every agent team we talk to hits the same wall. Try it yourself: the link
> is on screen. Thanks."

---

## Claims check

Every claim on the slides, and where it is backed. Hashes are on Stellar testnet; each one was
read back from the RPC (status and contract error) on 26 Oct 2026.

| Claim | Evidence |
|---|---|
| A prompt-injected agent signs, the network refuses | Scripted attacker transfer: FAILED `#10` PayeeNotAllowed `c6b19624…5d19`. LLM agent run (`openai/gpt-4o-mini`, 26 Oct 00:41 UTC, `scenario/last-run.log`): FAILED `#10` PayeeNotAllowed `b90a30c7…215b`, attributed to the account's `__check_auth` by the diagnostic event. Only the feed page is staged |
| Allowed payee, cap per period, not revoked | FAILED `#10` `c6b19624…5d19`, FAILED `#6` `ca14bba2…67b9`, FAILED `#1` `d17e08e6…334a` |
| Official x402 facilitator, unchanged | `@x402/stellar` 2.28.0 facilitator: `verify` and `settle` of `fa5fde12…4841`; `verify` returned `isValid: false` for the attacker payment |
| Proof in about 2 s | 1 678 ms in the Node demo run, with the same artifacts the browser uses. The browser time was not measured separately |
| Verified on BN254 in Soroban, account deployed in one tx | `register` `65af41a1…9676`, `a7a8a903…4950` |
| 62 contract tests | `cargo test`: 51 PassportAccount, 11 PassportFactory, all passing (26 Oct) |
| Live on testnet, public demo | https://passport-pay-stellar.vercel.app/app; `1488f949…0161` SUCCESS, `bab36b82…de15` FAILED `#6` |
| "Ours lost zero" | The attacker's balance after the scripted payee run: 0 USDC; after the LLM run (`GCCZXNV7…SNIN`, read on 26 Oct): 0 USDC |

Wording kept narrower than `PITCH.md` on purpose, so the slides match what is enforced today:

- `PITCH.md` says the ZK passport proves "a human stands behind" the agent and that sellers get
  "a human behind every buyer". The deployed open-stellar-passport validator has no allow-list of
  registry roots, so today anyone can mint a passport from a random secret: a passport proves a
  registered secret, not a person. The slides, the `.pptx` and the landing say "a ZK passport
  credential, one per agent, anti-Sybil by nullifier" (the factory deploys one account per
  `agent_id` and the validator burns each nullifier once), and the notes say "a payer that brings
  its own controls". `deck/build-pptx.py` fails if the word "human" shows up in the deck. Proof of
  personhood is a next step (README, "Next steps").
- `PITCH.md` asks for "40+ contract tests"; the real count is 62.
- The slide 2 note says "here's our real agent" because the LLM injection run has a real FAILED
  transaction (`b90a30c7…215b`). It adds the model (GPT-4o mini) and says the feed was rigged by
  us, so nobody takes the trap page for a real attack in the wild.
