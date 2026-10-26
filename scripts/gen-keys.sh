#!/usr/bin/env bash
# Genera las claves de testnet de Passport Pay con `stellar keys` + friendbot
# y las vuelca en .secrets/ y .env (ambos fuera de git). Es idempotente.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .secrets && chmod 700 .secrets
KEYS=(pp-facilitator pp-merchant pp-owner pp-agent pp-payer pp-ops)
for k in "${KEYS[@]}"; do
  if ! stellar keys address "$k" >/dev/null 2>&1; then
    stellar keys generate "$k" --network testnet --fund >/dev/null
  fi
  stellar keys show "$k" > ".secrets/$k.secret"
  chmod 600 ".secrets/$k.secret"
done
upper() { echo "$1" | tr 'a-z-' 'A-Z_'; }
{
  echo "# Generado por scripts/gen-keys.sh. NO commitear."
  echo "X402_NETWORK=stellar:testnet"
  echo "RPC_URL=https://soroban-testnet.stellar.org"
  echo "HORIZON_URL=https://horizon-testnet.stellar.org"
  for k in "${KEYS[@]}"; do
    n=$(upper "${k#pp-}")
    echo "${n}_PUBLIC=$(stellar keys address "$k")"
    echo "${n}_SECRET=$(cat ".secrets/$k.secret")"
  done
} > .env.keys
chmod 600 .env.keys
# .env = claves + overrides manuales previos (si existe .env.local se agrega al final)
cat .env.keys > .env
[ -f .env.local ] && cat .env.local >> .env
chmod 600 .env
rm .env.keys
grep -E "_PUBLIC=" .env
