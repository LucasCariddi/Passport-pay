#!/usr/bin/env bash
# Sube el wasm actual de PassportAccount a testnet y apunta la factory a él
# (`set_account_wasm`, solo admin). Afecta SOLO a las cuentas que se creen desde ahora:
# las cuentas ya desplegadas son inmutables y siguen con su wasm.
#
# Uso (desde la raíz): bash contracts/scripts/set-account-wasm.sh
# Escribe el hash en deploy/passport-account.wasm-hash.txt. No toca .env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADMIN_ID=${ADMIN_IDENTITY:-pp-deployer}
FACTORY=$(cat "$ROOT/deploy/passport-factory.txt")
WASM=target/wasm32v1-none/release/passport_account.wasm

# El CLI de stellar lee .env del cwd: todo corre desde contracts/ (no tiene .env).
cd "$ROOT/contracts"
stellar contract build --package passport-account >/dev/null
LOCAL_HASH=$(sha256sum "$WASM" | cut -d' ' -f1)
echo "wasm local: $LOCAL_HASH"

HASH=$(stellar contract upload --wasm "$WASM" --source "$ADMIN_ID" --network testnet)
echo "wasm subido: $HASH"
if [ "$HASH" != "$LOCAL_HASH" ]; then echo "ERROR: el hash subido no coincide con el local"; exit 1; fi

stellar contract invoke --id "$FACTORY" --source "$ADMIN_ID" --network testnet -- \
  set_account_wasm --account_wasm_hash "$HASH"
ONCHAIN=$(stellar contract invoke --id "$FACTORY" --source "$ADMIN_ID" --network testnet --send=no -- config)
echo "factory config: $ONCHAIN"
case "$ONCHAIN" in *"$HASH"*) ;; *) echo "ERROR: la factory no quedó apuntando al wasm nuevo"; exit 1;; esac

echo "$HASH" > "$ROOT/deploy/passport-account.wasm-hash.txt"
echo "listo: la factory crea cuentas con el wasm $HASH"
