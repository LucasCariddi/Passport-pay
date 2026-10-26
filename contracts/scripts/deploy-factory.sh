#!/usr/bin/env bash
# Compila y despliega en testnet: wasm de PassportAccount + PassportFactory, y adopta
# el pasaporte ya registrado del agente AGENT_ID (por defecto 42) para el dueño.
# Escribe los IDs en deploy/*.txt y actualiza .env (sin secretos nuevos: el admin es
# la identidad `pp-deployer` del CLI de stellar).
#
# Uso: bash contracts/scripts/deploy-factory.sh
#      CAP=500000 PERIOD_LEDGERS=17280 AGENT_ID=42 bash contracts/scripts/deploy-factory.sh
set -euo pipefail
source ~/.cargo/env
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
set -a; source .env; set +a

AGENT_ID=${AGENT_ID:-42}
CAP=${CAP:-500000}                       # 0.05 USDC por período (7 decimales)
PERIOD_LEDGERS=${PERIOD_LEDGERS:-17280}  # ~1 día
VALIDATOR=${VALIDATOR_ID:-CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA}
TOKEN=${USDC_SAC:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}
ADMIN_ID=${ADMIN_IDENTITY:-pp-deployer}
NET=(--network testnet)

if ! stellar keys address "$ADMIN_ID" >/dev/null 2>&1; then
  stellar keys generate "$ADMIN_ID" --network testnet --fund
fi
ADMIN=$(stellar keys address "$ADMIN_ID")
AGENT_KEY_HEX=$(node -e 'const {StrKey}=require("@stellar/stellar-sdk");console.log(Buffer.from(StrKey.decodeEd25519PublicKey(process.argv[1])).toString("hex"))' "$AGENT_PUBLIC")

# El CLI lee .env del cwd: compilamos desde contracts/ (no tiene .env).
(cd contracts && stellar contract build >/dev/null)
ACC_WASM=contracts/target/wasm32v1-none/release/passport_account.wasm
FAC_WASM=contracts/target/wasm32v1-none/release/passport_factory.wasm

mkdir -p deploy
cd contracts
ACC_HASH=$(stellar contract upload --wasm "../$ACC_WASM" --source "$ADMIN_ID" "${NET[@]}")
echo "PASSPORT_ACCOUNT_WASM_HASH=$ACC_HASH"
FAC_HASH=$(stellar contract upload --wasm "../$FAC_WASM" --source "$ADMIN_ID" "${NET[@]}")
echo "PASSPORT_FACTORY_WASM_HASH=$FAC_HASH"
FACTORY=$(stellar contract deploy --wasm-hash "$FAC_HASH" --source "$ADMIN_ID" "${NET[@]}" -- \
  --admin "$ADMIN" --validator "$VALIDATOR" --account_wasm_hash "$ACC_HASH" --token "$TOKEN")
echo "PASSPORT_FACTORY_ID=$FACTORY"
ACCOUNT=$(stellar contract invoke --id "$FACTORY" --source "$ADMIN_ID" "${NET[@]}" -- adopt \
  --owner "$OWNER_PUBLIC" --agent_key "$AGENT_KEY_HEX" --agent_id "$AGENT_ID" \
  --cap "$CAP" --period_ledgers "$PERIOD_LEDGERS" | tr -d '"')
echo "PASSPORT_ACCOUNT_ID=$ACCOUNT"
cd "$ROOT"

echo "$FACTORY" > deploy/passport-factory.txt
echo "$FAC_HASH" > deploy/passport-factory.wasm-hash.txt
echo "$ACC_HASH" > deploy/passport-account.wasm-hash.txt
echo "$ACCOUNT" > deploy/passport-account-agent${AGENT_ID}.txt
echo "$ADMIN" > deploy/factory-admin.txt

# .env: reemplaza solo estas claves (el resto queda igual). Guarda la cuenta vieja del spike.
OLD=${PASSPORT_ACCOUNT_ID:-}
KEYS='^(PASSPORT_ACCOUNT_ID|PASSPORT_ACCOUNT_WASM_HASH|PASSPORT_FACTORY_ID|PASSPORT_FACTORY_WASM_HASH|FACTORY_ADMIN_PUBLIC|PASSPORT_ACCOUNT_SPIKE_ID)='
grep -vE "$KEYS" .env > .env.tmp || true
{
  cat .env.tmp
  echo "PASSPORT_FACTORY_ID=$FACTORY"
  echo "PASSPORT_FACTORY_WASM_HASH=$FAC_HASH"
  echo "PASSPORT_ACCOUNT_WASM_HASH=$ACC_HASH"
  echo "PASSPORT_ACCOUNT_ID=$ACCOUNT"
  echo "FACTORY_ADMIN_PUBLIC=$ADMIN"
  if [ -n "$OLD" ] && [ "$OLD" != "$ACCOUNT" ]; then echo "PASSPORT_ACCOUNT_SPIKE_ID=$OLD"; fi
} > .env
rm .env.tmp; chmod 600 .env
# .env.local (lo escribía scripts/deploy-account.sh): que no quede apuntando a la cuenta vieja.
if [ -f .env.local ]; then
  grep -vE "$KEYS" .env.local > .env.local.tmp || true
  { cat .env.local.tmp; echo "PASSPORT_ACCOUNT_WASM_HASH=$ACC_HASH"; echo "PASSPORT_ACCOUNT_ID=$ACCOUNT"; echo "PASSPORT_FACTORY_ID=$FACTORY"; } > .env.local
  rm .env.local.tmp; chmod 600 .env.local
fi
echo "listo: deploy/*.txt y .env actualizados"
