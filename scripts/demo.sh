#!/usr/bin/env bash
# Demo de punta a punta de Passport Pay en stellar:testnet. Ver scripts/demo.mjs.
#   bash scripts/demo.sh [--reuse] [--cap 0.03]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] || { echo "falta .env (corré scripts/gen-keys.sh y scripts/setup-testnet.mjs)"; exit 1; }
[ -d node_modules ] || pnpm install
exec node scripts/demo.mjs "$@"
