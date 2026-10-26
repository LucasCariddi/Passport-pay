#!/usr/bin/env bash
# Compila y despliega una PassportAccount en testnet para el agente AGENT_ID.
# Escribe PASSPORT_ACCOUNT_ID y PASSPORT_ACCOUNT_WASM_HASH en .env.local y regenera .env.
# Uso: AGENT_ID=42 CAP=500000 PERIOD_LEDGERS=17280 bash scripts/deploy-account.sh
set -euo pipefail
source ~/.cargo/env
cd "$(dirname "$0")/.."
set -a; source .env; set +a
# stellar CLI lee .env del cwd: por eso no usamos STELLAR_NETWORK/STELLAR_RPC_URL en .env.
:
AGENT_ID=${AGENT_ID:-42}
CAP=${CAP:-500000}                 # 0.05 USDC (7 decimales)
PERIOD_LEDGERS=${PERIOD_LEDGERS:-17280}  # ~1 dia
VALIDATOR=${VALIDATOR_ID:-CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA}
TOKEN=${USDC_SAC:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}
AGENT_KEY_HEX=$(node -e 'const {StrKey}=require("@stellar/stellar-sdk");console.log(Buffer.from(StrKey.decodeEd25519PublicKey(process.argv[1])).toString("hex"))' "$AGENT_PUBLIC")

(cd contracts && stellar contract build --package passport-account >/dev/null)
WASM=contracts/target/wasm32v1-none/release/passport_account.wasm
HASH=$(stellar contract upload --wasm "$WASM" --source pp-owner --network testnet)
ID=$(stellar contract deploy --wasm-hash "$HASH" --source pp-owner --network testnet -- \
  --owner "$OWNER_PUBLIC" --agent_key "$AGENT_KEY_HEX" --validator "$VALIDATOR" \
  --agent_id "$AGENT_ID" --token "$TOKEN" --cap "$CAP" --period_ledgers "$PERIOD_LEDGERS")
echo "PASSPORT_ACCOUNT_WASM_HASH=$HASH"
echo "PASSPORT_ACCOUNT_ID=$ID"
touch .env.local
grep -vE '^(PASSPORT_ACCOUNT_ID|PASSPORT_ACCOUNT_WASM_HASH|AGENT_ID)=' .env.local > .env.local.tmp || true
{ cat .env.local.tmp; echo "PASSPORT_ACCOUNT_WASM_HASH=$HASH"; echo "PASSPORT_ACCOUNT_ID=$ID"; echo "AGENT_ID=$AGENT_ID"; } > .env.local
rm .env.local.tmp
grep -vE '^(PASSPORT_ACCOUNT_ID|PASSPORT_ACCOUNT_WASM_HASH|AGENT_ID)=' .env > .env.tmp || true
{ cat .env.tmp; echo "PASSPORT_ACCOUNT_WASM_HASH=$HASH"; echo "PASSPORT_ACCOUNT_ID=$ID"; echo "AGENT_ID=$AGENT_ID"; } > .env
rm .env.tmp; chmod 600 .env .env.local
