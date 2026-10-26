# How we used AI

Passport Pay was built with heavy use of AI. This page says which tool we used, how, what the AI
did and what the team decided, so a judge can tell human judgment apart from mechanical work.

## The tool

- **Claude Code** (model Claude Opus 5.5, by Anthropic), in the terminal, on Ubuntu under WSL2.
- **Multi-agent workflows.** An orchestration script launched subagents with narrow tasks: the
  x402 spike, the account contract, the factory, the server, the agent CLI, the web app, the MCP
  server, the end-to-end demo, the security review, the independent verification, the
  fresh-copy reproduction, the payee list, the Story A scenario, design, deck, video, deploy and
  documentation. Several of them ran in parallel, each with its own set of files, so they would
  not step on each other.
- Every subagent returned a report with what it ran, the testnet hashes and what did not work.
  That report fed the next task, and the team read it before deciding what came next.
- Stellar skills loaded as reference: `stellar-agentic-payments` (x402), `stellar-soroban`,
  `stellar-dapp`, `setup-stellar-contracts` and `develop-secure-contracts`.

## What the team decided

- The product: a paid API for agents where the spending rules are enforced onchain, in the
  agent's own account, and not in a backend, with owner revocation.
- The tracks (Stellar Unlocked as primary, Stellar Composed as second) and the scope: what is new is x402 from a contract account,
  onchain enforcement and the owner's UX.
- To use open-stellar-passport as **declared prior work**, as a library, without rewriting it,
  and to declare the earlier Bitcoindefi work it builds on (see the README).
- The main story for judges: Story A, the prompt-injected agent whose payment the network
  rejects.
- The working rules the AI had to follow on every task:
  - testnet only, with friendbot keys;
  - secrets only in `.secrets/` and `.env`, outside git, never in code, bundles or docs;
  - test by running for real (tests and testnet runs with hashes), not just by compiling;
  - report honestly what did not work, and keep simulated and real results apart;
  - the AI makes no commits, no pushes and no repositories, and does not connect Vercel to
    GitHub: the team reviews and pushes.
- What to do with the risks the AI reported: which ones to fix before submitting (the passport
  that a third party could overwrite, the payment destination the cap did not cover) and which
  ones to document as limitations and next steps.
- Marketing, growth and the pitch: Lucas Cariddi.

## What the AI did

- **Research:** it read the code of `@x402/stellar` 2.28.0 to see what the `exact` facilitator
  accepts. That led to the technical decision to use a contract account as the payer (option A)
  instead of a "gate" contract (which does not fit `exact`), and to the need for our own client
  scheme to sign for a C account.
- **Code:** it wrote the `PassportAccount` and `PassportFactory` contracts (Rust), the x402
  server, the agent CLI, the MCP server, the web app, the testnet scripts, the demo and the
  deploy scripts.
- **Tests and runs:** it wrote and ran the tests (cargo 51 + 11, server 33, agent 9, MCP 14, web
  build and e2e) and ran everything on testnet. The hashes in the README and in
  `docs/ARCHITECTURE.md` come from those runs, and each one in the README was checked again on
  Horizon testnet.
- **Security review:** a subagent tried to break the account. It found that a third party could
  lock someone else's account by overwriting its passport, proved it on testnet with a PoC,
  proposed the fix, tested it and deployed it for new accounts. A later pass found that the cap
  did not bound the destination of a payment; that became the payee list.
- **Independent verification:** another subagent built transactions by hand, without the server
  or agent code, to confirm that the rejection comes from `__check_auth` and not from an `if` of
  ours. It found and fixed a bug in how the demo attributed the error code.
- **Fresh-copy reproduction:** another subagent copied only what goes to git into a clean folder,
  with no keys or local config, and found three blockers that stopped the demo (pnpm build
  scripts, a factory with no config, a web with no factory). It fixed them.
- **Documentation and materials:** README, architecture, deploy notes, this page, the video
  script, the deck notes and a commit plan.

## AI inside the demo

Story A uses a real LLM as the agent under attack: `scenario/run-injection.sh` gives it the
Passport Pay MCP tools, a budget and a page with a hidden instruction to pay an attacker. There
the model is the test subject, not a development tool. Its decision is real and not scripted; the
model used is printed at the top of each run's log. In the official run (26 Oct) it was
`openai/gpt-4o-mini` through the Vercel AI Gateway: it obeyed the hidden order and the ledger
rejected the payment (`scenario/README.md`). The guarantee we show does not depend on what the
model decides.

## What the team reviewed

The team reads every task's report, the hashes on stellar.expert, the final diff and the commit
plan (`docs/COMMITS.md`) before pushing anything. Any mistake left in the code or in these docs is
the team's responsibility.

## What the AI did not do

- It did not modify the prior library (open-stellar-passport): the files in `vendor/osp/` and
  `contracts/osp-wasm/` are unmodified copies.
- It did not use mainnet or real funds.
- It did not commit, push, create repositories or connect Vercel to GitHub.
