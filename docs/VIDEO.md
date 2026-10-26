# Demo video script (2:30 or less)

Format: screen recording with voiceover, 1920x1080. Story A first: the hijacked agent and the
network's refusal, then how it works and the live app. About 300 words of voiceover, which fits
in 2:30 with room to breathe.

Before recording: `bash scripts/restore-osp.sh` if needed, close any other demo that uses the
same keys, and have these tabs ready: the trap page, a terminal with the Story A run, the live app
(https://passport-pay-stellar.vercel.app/app) and stellar.expert.

Transactions to show (real, on testnet):

- Story A, LLM run (model `openai/gpt-4o-mini` through the Vercel AI Gateway, 26 Oct, 00:41
  UTC):
  [`b90a30c7…215b`](https://stellar.expert/explorer/testnet/tx/b90a30c743e7aa56a8a843458018fd827afdf15df3607d1a9e8f475efad8215b),
  FAILED `Error(Contract, #10)` PayeeNotAllowed, attributed to the account's `__check_auth`. For
  the terminal shot, use `scenario/last-run.txt`: the same lines and UTC timestamps as
  `scenario/last-run.log`, without the setup steps. A fresh `bash scenario/run-injection.sh`
  gives a new hash; then the caption shows that one.
- Story A, scripted signer (if the LLM run is not available):
  [`c6b19624…5d19`](https://stellar.expert/explorer/testnet/tx/c6b1962427bdf48b77691eb911aec5d705543acef035989b95a13194687f5d19),
  FAILED `Error(Contract, #10)`. If this one is used, the caption says "scripted signer".
- Live app: [`1488f949…0161`](https://stellar.expert/explorer/testnet/tx/1488f949e52f27886367cea8aa522d011bb7162c0aa4a59f24fa299300000161)
  (SUCCESS, 0.01 USDC over x402) and
  [`bab36b82…de15`](https://stellar.expert/explorer/testnet/tx/bab36b82ed02d39b364348e9e485b5192acbbc67aad73036ba925df93795de15)
  (FAILED `#6`, over the cap). A fresh recording shows the hashes of that run instead.
- Revocation: [`d17e08e6…334a`](https://stellar.expert/explorer/testnet/tx/d17e08e622d5c4cf14a2deabe0a17776552cd53f8b05428f8a2beecf48f0334a)
  (FAILED `#1`).

| Time | Screen | Voiceover |
|---|---|---|
| 0:00 to 0:12 | The trap page. A highlight reveals the hidden instruction to pay the attacker. | "This page looks like a price feed. Hidden in it is an order to an AI agent: pay this address." |
| 0:12 to 0:35 | Terminal: the agent reads the page and calls `pay` to the attacker. Cut to stellar.expert: the transaction, FAILED, `Error(Contract, #10)`. Caption: "Real LLM agent (gpt-4o-mini). Only the page is staged. Its decision, the signature and the ledger result are real." | "Our agent read it, obeyed and signed the payment with its own key. The signature is valid, and no server stands in the way. Stellar rejected it anyway: payee not allowed. The attacker got nothing." |
| 0:35 to 0:58 | Prove, Bind, Enforce diagram: owner, factory, agent account, x402 API. | "Here's why. The rules don't live in the agent. They live in its smart account. Prove: the owner makes a zero-knowledge passport. Bind: one transaction verifies it and deploys the agent's account. Enforce: every USDC transfer runs that account's checks: allowed payee, a cap per period, not revoked." |
| 0:58 to 1:25 | Live app, "Try as an agent": the 402, the payment, the response, the SUCCESS link on stellar.expert. | "This is the live demo. The agent asks for data, gets HTTP 402 Payment Required, pays one cent in USDC over x402 and gets the answer. A real payment on testnet." |
| 1:25 to 1:45 | Same tab: the attempt to go over the cap, the rejection stamp with `Error(Contract, #6)`, then the FAILED transaction. | "Now it asks for more than its budget. We even send it straight to the network, skipping our server. The ledger refuses it: cap exceeded." |
| 1:45 to 2:02 | Owner panel: spend bar, allowed payees, "Revoke". Then the FAILED `#1` transaction. | "The owner sees every payment, chooses who the agent may pay and can revoke it in one click. After that, nothing goes through. And the funds stay the owner's." |
| 2:02 to 2:18 | README: the independent verification table and the test counts. Then "Prior work, declared". | "We checked it with hand-built transactions, without our code, and with sixty-two contract tests. The ZK passport comes from our earlier open-stellar-passport; what's new is putting it in the path of a payment." |
| 2:18 to 2:30 | Closing card: Passport Pay, the live URL, github.com/LucasCariddi/passport-pay, "Stellar testnet". | "Passport Pay. Give your agent money, not the power to drain it." |

## Notes for the recording

- Never show `.env`, `.secrets/` or a key file on screen. The demo terminals do not print
  secrets, but an editor might have them open.
- Keep the caption on the Story A segment: the trap page is staged, the rest is real. If the
  scripted run is used instead of the LLM run, say "scripted signer" on screen.
- Say on screen, in small text, that the FAILED transactions come from sending the payment
  anyway. On the normal x402 path a rejected payment is stopped earlier, at simulation, and never
  reaches the network.
- The public demo account in the app has the cap but not the payee list (it predates it). The
  payee rejection is shown with the Story A account, not with the app.
- If a run gives `TRY_AGAIN_LATER` or `txBadSeq`, another process is using the same keys. Stop
  everything and run again.
- Each live-app run spends 0.01 USDC of the demo account's cap (0.05 per hour).

## Existing recording

`web/public/media/demo.mp4`: 1920x1080, 30 fps, 2:09, no audio, recorded on 25 Oct against
production: landing, panel, catalog, "Try as an agent" (a real 0.01 USDC payment), the attempt to
go over the cap rejected by the contract with `Error(Contract, #6)` and both transactions on
stellar.expert. It predates Story A and its captions are in Spanish, so it is not the submission
video. It plays muted as a background loop on the deck.

How to redo it (in `video/`, outside the pnpm workspace):

```sh
cd video && npm install
node capture.mjs https://passport-pay-stellar.vercel.app /var/tmp/pp-video/run1   # Chrome screencast, frame by frame
node render.mjs /var/tmp/pp-video/run1 ../web/public/media/demo.mp4                # ffmpeg-static + drawtext
```

- `capture.mjs` uses `Page.startScreencast` and stores every frame with its time. It uses no
  secret: the payment is signed by the server with the public demo account.
- `render.mjs` keeps every frame's real time. It only speeds up network waits (page loads and
  settlement) and labels those stretches as sped up. The caption text lives in `render.mjs`.
