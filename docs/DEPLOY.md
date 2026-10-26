# Passport Pay: deploy on Vercel

Status: **live in production** at https://passport-pay-stellar.vercel.app since 25 Oct 2026.
Checked on 26 Oct: `GET /api/health` answers `ok: true` on `stellar:testnet`,
`GET /api/premium/insight` answers `402 Payment Required`, `GET /api/demo/inject` answers
`enabled: true` for `CADZU573…NWFF`, and a real `POST /api/demo/inject` came back `REJECTED` with
transaction [`4391c18e…7828`](https://stellar.expert/explorer/testnet/tx/4391c18e360dabd1be13a53849701fc510d99ab0f49d0bc445d5f9d6266b7828)
FAILED `#10` PayeeNotAllowed (`deploy/injection-demo.json`). This page explains how the deploy is
built, how it is published and what can go wrong.

## 0. Rules

- Publish **only through the CLI from the local folder** (`vercel deploy`), never by connecting
  Vercel to GitHub (`vercel git connect` is not allowed). No git remote is needed.
- Vercel project: `passport-pay`. Check the logged-in account with `vercel whoami` before
  deploying.
- `stellar:testnet` only. The server refuses to start on any other network (`config.mjs`).
- Secrets only as Vercel env vars (`vercel env add NAME production`), never in `vercel.json`, the
  bundle or the docs. Every deploy searches the build output for anything shaped like an `S...`
  key and stops if it finds one.

## 1. Structure (one project)

| Route | What it serves | Where it comes from |
|---|---|---|
| `/` | landing | `web/landing/`, built with `pnpm --filter ./web build:landing` into `web/dist-landing` (Vite, its own config `web/vite.landing.config.ts`, no React) |
| `/docs`, `/docs/arquitectura`, `/docs/ia` | README, `docs/ARCHITECTURE.md` and `docs/AI.md` as HTML | the same landing build (`web/landing/build/site.mjs`); it stops if it sees an `S...` key |
| `/app/` | web app: owner panel, catalog, "Try as an agent" | `web/dist`, built with `WEB_BASE=/app/` |
| `/app/zk/*` | browser ZK artifacts (4.4 MB zkey) | emitted by the `osp-zk-artifacts` plugin in `vite.config.ts` |
| `/api/*` | x402 server and facilitator (Express) | one function: `api/index.mjs` |
| `/catalog`, `/health` | free catalog (JSON) and health | the same function, by rewrite |
| `/presentacion` | web slides | `site/presentacion/index.html` |
| `/notas` | speaker view | `site/notas/index.html` |
| `/video` | demo video page (player, what it shows, links) | `site/video/index.html` |
| `/media/*` | demo video, poster, `.pptx` and `.pdf` of the deck | `web/public/media/`, copied to the root by the build |

Slides and notes are static HTML with no build. Test them locally with
`node scripts/serve-site.mjs` (it mimics these routes) and `node deck/e2e-pitch.mjs` (headless
Chromium: slides, keyboard, touch, BroadcastChannel and ntfy.sh).

Landing: `cd web && pnpm dev:landing` (port 5174, also serves `/docs/*`) or
`pnpm build:landing && pnpm preview:landing`. Headless test: `node e2e/landing-smoke.mjs <url>`
(render, mobile at 375 px with no horizontal scroll, dark mode, no em dashes, internal links,
`/docs` anchors, stellar.expert links and the CTA that opens `/app`).

## 2. Pieces

### 2.1 `api/index.mjs`: the server as a function

`server/src/index.mjs` builds the app in a pure function, `buildServerApp()`, and `startServer()`
calls it and then `listen()`. The Vercel function exports the Express app (Vercel's Node runtime
accepts an Express app as the default handler):

```js
// api/index.mjs
import { buildServerApp } from "../server/src/index.mjs";
// Singleton per instance: built once and reused across requests (Fluid compute).
const { app } = buildServerApp();
export default app;
```

`loadConfig` still reads `deploy/*.txt` (versioned public IDs), so Vercel only needs the env vars
in section 4. `loadEnvFile()` is not called in the function: there is no `.env` on Vercel. The
function also strips the `?path=` the rewrite adds, so Express sees the original route.

### 2.2 Build and publish script

`bash scripts/vercel-deploy.sh` (preview) or `bash scripts/vercel-deploy.sh --prod`. It builds
locally, assembles the static output (landing and docs, `/app`, slides, notes, media), checks the
whole `.vercel/output` for anything shaped like an `S...` key and only then uploads with
`--prebuilt`.

The web needs two build options, both in place: `WEB_BASE` in `vite.config.ts` (default `/`) and
`VITE_API_URL=same-origin` in `web/src/lib/config.ts` (uses `location.origin`).

### 2.3 `vercel.json`

- No framework, `pnpm install --frozen-lockfile`, static output plus one function.
- `functions["api/index.mjs"]`: `maxDuration: 60`, `memory: 1024`, and `excludeFiles` so the
  function trace never picks up the root `.env`.
- Rewrites: `/api/:path*`, `/catalog` and `/health` go to `/api/index` (not `/api/index.mjs`: with
  `cleanUrls` that gives 404); `/app` and its client routes go to `/app/index.html`, except
  `assets/` and `zk/`.
- Headers: `Cache-Control: no-store` on `/api/*`, long immutable cache on `/app/assets/*`.
- `maxDuration: 60`: a settle takes 6 to 7 s and the demo endpoint does the 402, the signature and
  the settle.

### 2.4 `.vercelignore`

It uploads only what is needed and leaves out `.env*`, `.secrets/`, `contracts/target/`,
`node_modules/`, old builds and logs. It is the first barrier against a local secret ending up in
the upload.

### 2.5 Demo endpoint: `POST /api/demo/pay` ("Try as an agent")

In `server/src/demo.mjs`, mounted in `createApp`:

- Body: `{ "endpoint": "insight" | "quote" | "report", "usd"?: "0.05" }`. **The account never comes
  from the client**: it is always `DEMO_ACCOUNT_ID`. At startup the function reads that account's
  wasm and, if it is not one of the expected ones (`deploy/demo-public.json`, today `b9dfc7c6…`,
  plus `f5ec1e6d…` for the previous demo account), the endpoint answers 503. That way an account
  of the oldest wasm (`72f52276…`, lockable by third parties) is never used.
- It runs the real x402 flow with `agent/src/pay.mjs` and `PassportAccountExactScheme`, signing
  with `DEMO_AGENT_SECRET`, against the same process through a listener on `127.0.0.1` (it does
  not depend on the domain or on preview protection).
- It answers the result the way the CLI understands it: `paid` (hash and link),
  `rejected_onchain_simulation` or `rejected_by_server` with `cap_exceeded` / `revoked`, and the
  `spend_status` before and after.
- 50 s response limit (a clear 504), one demo payment at a time per instance (429 after 20 s in
  line), 10 requests per minute per IP, a retry with random wait on `submission_failed`. A forced
  send (`force: true`) is paid by the demo agent's G (funded with friendbot), not by the
  facilitator, so it does not step on the facilitator's sequence.
- The demo account has a cap of 0.05 USDC every 720 ledgers (about an hour): five 0.01 queries are
  enough to see the cap rejection. To show it on the spot, "Try as an agent" offers `report` for
  0.05 USDC once something has been spent.
- `GET /api/demo/status` reads the account's state.

### 2.6 Fire test endpoint: `/api/demo/inject`

In `server/src/inject.mjs`, mounted next to the demo endpoint. It needs the same two env vars,
`DEMO_ACCOUNT_ID` and `DEMO_AGENT_SECRET`, and an account on the payee-list wasm (`b9dfc7c6…`)
whose list does not include the attacker. Optional: `DEMO_ATTACKER` (default: the address on
`/trampa`) and `DEMO_INJECT_RATE_PER_MIN` (default 6).

- `GET /api/demo/inject`: reads the account's wasm, `payees` and `is_payee(attacker)` on every
  request and answers 200 `enabled: true`, or 503 with the reason (`demo_not_configured`,
  `inject_account_wasm`, `attacker_is_payee`). It also returns the last recorded run from
  `deploy/injection-demo.json` (bundled with the function through `includeFiles`).
- `POST /api/demo/inject` with `{ "force": true }`: signs a 5 USDC transfer to the attacker with
  the demo agent's key, simulates it, sends it straight to the network (fee paid by the agent's
  G) and answers `verdict: "REJECTED"` only when the transaction is FAILED with `#10` attributed
  to the demo account. The client never chooses the account, the payee or the amount.
- Same lock as `/api/demo/pay`, so a forced send never shares a sequence number with a demo
  payment.

## 3. How to publish (exact commands)

```sh
cd /root/work/passport-pay
vercel whoami                                   # check the account
vercel link --yes --project passport-pay        # links the project; writes .vercel/ (ignored)
# env vars, one by one; the value goes in through stdin, so it never lands in shell history
vercel env add FACILITATOR_SECRET production < .secrets/pp-facilitator.secret
vercel env add DEMO_AGENT_SECRET production < .secrets/demo-public-agent.secret
printf 'stellar:testnet' | vercel env add X402_NETWORK production --no-sensitive
# ... the rest of the table in section 4 ...
vercel env ls production                        # check: names, not values
bash scripts/vercel-deploy.sh                   # preview: test with curl and headless
bash scripts/vercel-deploy.sh --prod            # production, only if the preview passed
```

Load the env vars in `preview` too to test a preview with real payments
(`vercel env add NAME preview`). Use `printf`, not `echo`, so no newline ends up in the value.
Previews have Deployment Protection; test them with `vercel curl` or the bypass header.
Production has no protection.

Checks after every deploy (against the real URL):

```sh
U=https://passport-pay-stellar.vercel.app   # or the preview URL
curl -s $U/api/health | jq .prices
curl -si $U/api/premium/insight | grep -i payment-required
curl -s $U/catalog | jq . | head -20
curl -s $U/api/demo/inject | jq '{enabled, account, agentPublic, payees}'   # 200, enabled: true
AGENT_SECRET=$(cat .secrets/demo-public-agent.secret) node agent/src/cli.mjs call insight \
  --account CADZU573AKZ7WV4T5TPZRJOMFA2VTU4PTLXHP27R7WWDYJ2J7PFKNWFF --server $U
cd web && node e2e/panel-smoke.mjs $U/app/ --expect-account CADZU573AKZ7WV4T5TPZRJOMFA2VTU4PTLXHP27R7WWDYJ2J7PFKNWFF
curl -s $U/app/ | grep -oE 'S[A-Z2-7]{55}' | head   # must print nothing
```

## 4. Environment variables (names, not values)

**Secret** (only through `vercel env add`, sensitive type):

| Name | Purpose |
|---|---|
| `FACILITATOR_SECRET` | signs and pays the fee of the x402 settle |
| `DEMO_AGENT_SECRET` | agent key of the public demo account (`.secrets/demo-public-agent.secret`) |

Not on Vercel: `OWNER_SECRET`, `MERCHANT_SECRET`, `AGENT_SECRET`, `PAYER_SECRET`, `OPS_SECRET`.
The server does not use them; the owner signs with a wallet and the scripts run locally.

**Public, for the server** (function runtime; add them with `--no-sensitive`):

| Name | Expected value |
|---|---|
| `X402_NETWORK` | `stellar:testnet` |
| `RPC_URL`, `HORIZON_URL` | public testnet RPC and Horizon |
| `FACILITATOR_PUBLIC` | the facilitator's G |
| `MERCHANT_PUBLIC` | `payTo` (a G with a USDC trustline) |
| `USDC_SAC`, `VALIDATOR_ID` | external contracts (they have defaults in code) |
| `PASSPORT_FACTORY_ID`, `PASSPORT_ACCOUNT_WASM_HASH` | also read from `deploy/*.txt` |
| `ACCOUNT_WASM_HASHES` | extra wasm admitted to pay; can stay empty in production |
| `FACILITATOR_MAX_FEE_STROOPS` | `100000000` |
| `PRICE_INSIGHT_USD`, `PRICE_QUOTE_USD`, `PRICE_REPORT_MIN_USD`, `PRICE_REPORT_MAX_USD` | `0.01`, `0.02`, `0.05`, `100` |
| `CORS_ORIGIN` | the production domain (or `*`) |
| `DEMO_ACCOUNT_ID` | `CADZU573…NWFF` (`deploy/demo-public.json`; set on 26 Oct, before it was `CAGMBEI3…B7ZV`) |
| `DEMO_ATTACKER`, `DEMO_INJECT_RATE_PER_MIN` | optional, for `/api/demo/inject` (2.6); not set in production |
| `PUBLIC_BASE_URL` | `https://passport-pay-stellar.vercel.app` (not needed today: the demo endpoint calls itself on `127.0.0.1`) |

`PORT` and `HOST` do not apply on Vercel.

**For the web build** (they end up in the bundle, so never a secret):

| Name | Value |
|---|---|
| `WEB_BASE` | `/app/` (set by the build script) |
| `VITE_API_URL` | `same-origin` (set by the build script) |
| `VITE_PASSPORT_ACCOUNT_ID` | optional; without it `vite.config.ts` takes `deploy/demo-public.json` |
| `VITE_PASSPORT_FACTORY_ID` | optional; without it, `deploy/passport-factory.txt` |

`vite.config.ts` only lets a closed list of public IDs through and drops any name with `SECRET`.

## 5. Risks and what to do

1. **Cold start.** The function loads stellar-sdk and x402 and the first paid request initializes
   the middleware. Mitigation: the app is a module singleton; before presenting, hit
   `/api/health` and `/api/premium/insight` (402) to warm it up. A Vercel cron on the Hobby plan
   runs once a day, so it does not help here.
2. **Facilitator key concurrency.** The settle queue (`createSerialQueue`) is per process. On
   serverless there can be several instances at once, and two settles with the same G collide on
   the sequence number (`tx_bad_seq`, or 402 `settle_exact_stellar_transaction_submission_failed`).
   What is in place: the queue inside an instance (Fluid compute reuses instances for concurrent
   requests) and a retry with random wait. If more is needed: several facilitator keys
   (`FACILITATOR_SECRETS`, one per request) or a shared lock (for example Redis from the Vercel
   Marketplace, `SET lock NX PX 20000`).
3. **One agent key for the demo endpoint.** The agent key signs auth entries with their own nonce,
   not transactions, so two signatures at once do not collide. What can happen is that two
   payments simulate fine with room for one: the second lands FAILED `#6` on the ledger (the cap
   works, but it costs a facilitator fee). Hence the one-at-a-time lock, the rate limit and the
   disabled button while a request is in flight.
4. **Demo account spend.** Anyone can press "Try as an agent". The contract limits spend to 0.05
   USDC per hour; the 3 USDC deposit covers 300 payments of 0.01 (about 60 hours at the full cap).
   Top up with `node agent/src/cli.mjs fund --usdc 2 --account CADZU573…NWFF`. The fire test moves
   no USDC (the account refuses it); each press costs the agent's G a testnet fee of about
   0.0014 XLM.
5. **`/api/payments/recent` lives in each instance's memory**: on serverless it is partial and is
   lost. The web uses `/api/payments` (RPC events) for its table, which does not depend on it.
6. **Testnet TTL.** Validator, verifier, factory, account wasm, passports #42 and #443284932 and
   the demo account are live until about ledger 8 496 900 (about 23 Apr 2027, `restore-osp.sh` on
   25 Oct). A testnet reset wipes them anyway: then the factory and the OSP contracts have to be
   redeployed (README, "If something fails").
7. **Secrets in the upload.** `vercel deploy` uploads the local folder. `.vercelignore` leaves out
   `.env*` and `.secrets/`; the build stops if it finds anything shaped like an `S...` key. After
   the deploy, repeat the `grep` against the real URL.
8. **Accounts of older wasm.** Since 26 Oct the public demo uses `CADZU573…` (wasm `b9dfc7c6…`, cap
   and payee list). The previous one, `CAGMBEI3…` (wasm `f5ec1e6d…`, cap but no payee list), is
   still accepted by `/api/demo/pay` if `DEMO_ACCOUNT_ID` points back at it, but then
   `/api/demo/inject` answers 503. The panel can open any account with `?account=` (read only),
   but the demo endpoints never accept an account from the client.
9. **Facilitator balance.** Each settle costs cents of XLM; check the facilitator's XLM balance
   before presenting.

## 6. Lessons from the first deploys (25 Oct)

- **The function trace pulled in the root `.env`** (with every key). `excludeFiles` in
  `vercel.json` stops it, and `vercel-deploy.sh` checks it on every deploy.
- **Public env vars stored as "sensitive" break the web**: they reach the build as `[SENSITIVE]`
  and `vite.config.ts` copies them into `VITE_RPC_URL` and the like. Public ones go with
  `--no-sensitive`; only `FACILITATOR_SECRET` and `DEMO_AGENT_SECRET` are sensitive.
- **Several instances at once**: with 3 simultaneous requests Vercel opened 3 instances; two
  settles collided on the facilitator's sequence (the retry solved it) and the third hung until the
  60 s cut (before the 50 s limit and the fetch timeout, which were added afterwards and were not
  tested in parallel again). The lock is per instance: to serialize across instances, a shared lock
  is needed.
- Rewrites must point at `/api/index`, not `/api/index.mjs` (with `cleanUrls` that gives 404), and
  `trust proxy` is on when `VERCEL` is set, so the 402's `resource.url` is https.

## 7. Production

- Domain: **https://passport-pay-stellar.vercel.app** (the project domain, assigned to the latest
  production deploy). `passport-pay.vercel.app` already belonged to another Vercel project.
  `passport-pay-eta.vercel.app` (an automatic alias) also answers.
- Published with `bash scripts/vercel-deploy.sh --prod` (local build, secret check and
  `--prebuilt`).
- Demo video: `web/public/media/demo.mp4`, recorded against production with `video/` (see
  `docs/VIDEO.md`). Published at `/media/demo.mp4`.
