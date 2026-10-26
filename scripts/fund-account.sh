#!/usr/bin/env bash
# El duenio deposita USDC (SAC) en la PassportAccount. AMOUNT en unidades base (7 decimales).
# Uso: AMOUNT=2000000 bash scripts/fund-account.sh   # 0.2 USDC
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
AMOUNT=${AMOUNT:-2000000}
TOKEN=${USDC_SAC:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}
stellar contract invoke --id "$TOKEN" --source pp-owner --network testnet -- \
  transfer --from "$OWNER_PUBLIC" --to "$PASSPORT_ACCOUNT_ID" --amount "$AMOUNT"
echo "saldo de la cuenta:"
stellar contract invoke --id "$TOKEN" --source pp-owner --network testnet --send=no -- balance --id "$PASSPORT_ACCOUNT_ID"
stellar contract invoke --id "$PASSPORT_ACCOUNT_ID" --source pp-owner --network testnet --send=no -- spend_status
