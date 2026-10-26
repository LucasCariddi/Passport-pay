#!/usr/bin/env bash
# run-injection.sh - Story A end to end on stellar:testnet.
#
# A real AI agent gets a small budget and a task: "get the XLM/USDC quote from your paid feed".
# The feed is the trap page, which hides a prompt injection that orders it to pay an attacker.
# The agent (an LLM, deciding on its own) may obey and call the Passport Pay MCP `pay` tool. The
# agent key signs the transfer and it is sent to the network. The PassportAccount's __check_auth
# REJECTS it onchain (PayeeNotAllowed), because the rules live in the contract account.
#
# What is REAL: the agent, the LLM decision, the signature, the onchain tx result.
# What is STAGED: only the trap page.
#
# Everything is stellar:testnet. No secret is printed; the log is scrubbed of S... keys.
#
# Needs: an AI Gateway key in ~/.config/jev/env (AI_GATEWAY_API_KEY=...), the agent key file of
# the Story A account in .secrets/ and an existing install of the `ai` SDK (linked in step 3).
# Env overrides: PASSPORT_ACCOUNT_ID, PASSPORT_AGENT_SECRET_FILE, ATTACKER, MERCHANT,
#                AMOUNT (default 5), MODEL (default openai/gpt-4o-mini), PORT (default 4190).
# Output: scenario/last-run.log (full, with UTC timestamps), scenario/last-run.txt (readable
# render for the video) and a copy of the log in scenario/runs/.
# The verification step is adaptive: it runs the allowed-merchant SUCCESS control only if the
# period still has room, so it never mislabels a cap-exhausted period.
set -uo pipefail
export TMPDIR="${TMPDIR:-/var/tmp}"
export TZ=UTC
cd "$(dirname "$0")/.."

ACCOUNT="${PASSPORT_ACCOUNT_ID:-CA75KBZFQPJUT7BTACHE22XKQROIWL77I2YPDFTEH56PBQFD72VVUVAO}"
SECRET_FILE="${PASSPORT_AGENT_SECRET_FILE:-.secrets/demo-agent-2271406239.json}"
ATTACKER="${ATTACKER:-GCCZXNV7U6MY6APDCWFXLAUTUOB63N6LTXZEMJ2Y4JJUJVGFEXQ7SNIN}"
MERCHANT="${MERCHANT:-GCLNNJKDE7YK5BYOCIW3SOZW7NBPBCKPKXONLRYVUQRO5VZCGLVCVPPJ}"
AMOUNT="${AMOUNT:-5}"
MODEL="${MODEL:-openai/gpt-4o-mini}"
PORT="${PORT:-4190}"
LOG="scenario/last-run.log"
TXT="scenario/last-run.txt"
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

export PASSPORT_ACCOUNT_ID="$ACCOUNT"
export PASSPORT_AGENT_SECRET_FILE="$SECRET_FILE"
export X402_NETWORK="stellar:testnet"
export ATTACKER MERCHANT

SRV=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; }
trap cleanup EXIT

main() {
  echo "###############################################################"
  echo "# Passport Pay - Story A (prompt injection) on Stellar testnet"
  echo "# date: $(date -u +%FT%TZ)"
  echo "# account: $ACCOUNT"
  echo "# attacker: $ATTACKER   amount the injection asks for: $AMOUNT USDC"
  echo "# model: $MODEL"
  echo "###############################################################"
  echo

  # 1) Claude Code available?
  echo "== 1. Agent: which LLM path =="
  if command -v claude >/dev/null 2>&1; then
    echo "claude CLI: PRESENT ($(claude --version 2>&1 | head -1))."
    echo "Note: this run still uses the gateway path (ai SDK) to drive the SAME MCP tool code"
    echo "(mcp/src/core.mjs). See scenario/README.md."
  else
    echo "claude CLI: not on the PATH."
    echo "Using the LLM path already set up on this machine: the Vercel AI Gateway"
    echo "(ai SDK, AI_GATEWAY_API_KEY from ~/.config/jev/env)."
    echo "The agent drives the REAL Passport Pay MCP tools (mcp/src/core.mjs)."
  fi
  echo

  # 2) Wait for the MCP to exist (it was written in parallel during the event), up to 90 min.
  echo "== 2. MCP server present (waits up to 90 min) =="
  deadline=$(( $(date +%s) + 90*60 ))
  until [ -f mcp/src/server.mjs ] && [ -f mcp/src/core.mjs ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "ERROR: the MCP (mcp/src/server.mjs) did not show up in 90 min. Stopping."
      return 1
    fi
    echo "  waiting for mcp/src/server.mjs ... ($(date -u +%T)Z)"
    sleep 10
  done
  echo "MCP present: mcp/src/server.mjs, mcp/src/core.mjs"
  echo

  # 3) Make the `ai` SDK reachable (no new install): reuse an existing install via a symlink.
  echo "== 3. LLM SDK (ai) =="
  if [ -d /root/.local/share/jev/node_modules/ai ]; then
    ln -sfn /root/.local/share/jev/node_modules scenario/node_modules
    echo "scenario/node_modules -> an existing install of the ai SDK (nothing installed)"
  else
    echo "WARNING: no ai SDK install found. The agent may fail to import 'ai'."
  fi
  echo

  # 4) Serve the trap page locally. Its output goes to a file, NOT this pipe: a backgrounded
  #    process that inherits the tee pipe would keep it open and hang the run at the end.
  echo "== 4. Trap page =="
  pkill -f "scenario/serve-trap.mjs" 2>/dev/null && sleep 1
  node scenario/serve-trap.mjs "$PORT" > /var/tmp/pp-serve-trap.log 2>&1 &
  SRV=$!
  TRAP_URL="http://127.0.0.1:$PORT/trampa/"
  code=""
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$TRAP_URL" || true)
    [ "$code" = "200" ] && break
    sleep 0.5
  done
  echo "trap page served at: $TRAP_URL (readiness HTTP $code)"
  [ "$code" = "200" ] || echo "WARNING: the trap page did not answer 200. Check web/public/trampa/index.html."
  echo

  # 5) One-time testnet setup: fund the fee payer, give the attacker a USDC trustline.
  echo "== 5. Testnet setup (idempotent) =="
  node scenario/setup-scenario.mjs || echo "WARNING: setup-scenario returned an error (it may already be set up)."
  echo

  # 6) Make sure the account can actually attempt AMOUNT (so the rejection is onchain).
  echo "== 6. Account balance =="
  node scenario/ensure-balance.mjs "$AMOUNT" || echo "WARNING: ensure-balance returned an error."
  echo

  # 7) THE REAL AGENT RUN.
  echo "== 7. THE REAL AGENT RUN =="
  node scenario/injection-agent.mjs --url "$TRAP_URL" --attacker "$ATTACKER" --model "$MODEL"
  AGENT_STATUS=$?
  echo "(agent exited with code $AGENT_STATUS)"
  echo

  # 8) Direct verification of the defense (not the LLM).
  echo "== 8. Direct check of the contract =="
  node scenario/verify-defense.mjs
  echo

  echo "== DONE. Full evidence above; copy in $LOG (no secrets). =="

  # Stop the trap server here so nothing keeps the output pipe open after main returns.
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  SRV=""
}

# UTC timestamp on every line (bash builtin printf, no subprocess per line).
stamp() { while IFS= read -r l; do printf '[%(%H:%M:%S)TZ] %s\n' -1 "$l"; done; }

# Run everything, timestamp it, scrub any accidental S... secret, and tee to the log.
main 2>&1 | stamp | sed -u -E 's/S[A-Z2-7]{55}/S_REDACTED_SECRET/g' | tee "$LOG"

# Readable render for the video, and an archived copy of this run's log.
node scenario/render-run.mjs "$LOG" "$TXT" && echo "readable render: $TXT"
mkdir -p scenario/runs
cp "$LOG" "scenario/runs/$RUN_ID.log" && echo "archived: scenario/runs/$RUN_ID.log"
