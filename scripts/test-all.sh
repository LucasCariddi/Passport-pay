#!/usr/bin/env bash
# Corre todos los tests del monorepo (sin red): contratos (cargo), servidor, agente y build de la web.
#   bash scripts/test-all.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
declare -a RESULTS=()
FAIL=0
step() {
  local name="$1"; shift
  echo; echo "=== $name: $*"
  if (eval "$@"); then RESULTS+=("PASA  $name"); else RESULTS+=("FALLA $name"); FAIL=1; fi
}
# El build va primero: los tests de la factory cargan el wasm de la cuenta.
step contracts-build "cd contracts && stellar contract build"
step contracts-test  "cd contracts && cargo test 2>&1"
step server-test     "pnpm --filter @passport-pay/server test"
step agent-test      "pnpm --filter @passport-pay/agent test"
step web-build       "pnpm --filter ./web build"
echo; echo "=== resumen"
printf '%s\n' "${RESULTS[@]}"
exit $FAIL
