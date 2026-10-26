#!/usr/bin/env bash
# Genera y compila los bindings TypeScript de PassportAccount y PassportFactory en
# contracts/bindings/<nombre> (paquetes @passport-pay/<nombre>-bindings).
# Uso: bash contracts/scripts/gen-bindings.sh
set -euo pipefail
source ~/.cargo/env
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/contracts"
FACTORY=$(cat ../deploy/passport-factory.txt)
ACCOUNT=$(cat ../deploy/passport-account-agent42.txt)
stellar contract build >/dev/null

gen() { # nombre wasm [contract-id]
  local name=$1 wasm=$2 id=${3:-} out="bindings/$1"
  if [ -n "$id" ]; then
    # trae el spec del contrato desplegado y fija su ID en `networks.testnet`
    stellar contract bindings typescript --contract-id "$id" \
      --output-dir "$out" --overwrite --network testnet >/dev/null
  else
    # una PassportAccount por agente: el contractId se pasa al crear el Client
    stellar contract bindings typescript --wasm "target/wasm32v1-none/release/$wasm" \
      --output-dir "$out" --overwrite >/dev/null
  fi
  # nombre de paquete estable para importarlo desde server/agent/web
  node -e '
    const fs=require("fs"); const p=process.argv[1]+"/package.json";
    const j=JSON.parse(fs.readFileSync(p,"utf8")); j.name="@passport-pay/"+process.argv[2]+"-bindings"; j.private=true;
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");' "$out" "$name"
  (cd "$out" && npm install --no-audit --no-fund --silent && npm run build --silent)
  echo "ok $out"
}
gen passport-factory passport_factory.wasm "$FACTORY"
gen passport-account passport_account.wasm
echo "factory $FACTORY / cuenta del agente 42: $ACCOUNT"
