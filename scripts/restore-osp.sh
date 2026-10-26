#!/usr/bin/env bash
# Restaura (si están archivadas) y extiende el TTL de todo lo onchain de lo que depende
# Passport Pay en testnet:
#   - validador y verificador de open-stellar-passport: instancia y wasm
#   - PassportFactory: instancia y wasm, y el wasm de PassportAccount que despliega
#   - Passport(agent_id) en el validador y AccountOf/AgentOf en la factory, para cada
#     agente de AGENT_IDS y el de deploy/demo-public.json
#   - la instancia de cada cuenta de ACCOUNTS y la de deploy/demo-public.json
# Sin esto, cualquier llamada que lea get_passport cuesta una fortuna (auto-restore) o falla.
#
# Uso:
#   OPS_SOURCE=pp-ops AGENT_IDS="42 3864590024" bash scripts/restore-osp.sh
# Variables:
#   OPS_SOURCE      identidad de `stellar keys` que paga (default pp-ops). Conviene una
#                   recién fondeada por friendbot: `stellar keys generate pp-ops2 --fund --network testnet`.
#   EXTEND_LEDGERS  cuánto extender (default 3110399, el máximo de testnet: max_entry_ttl - 1, ~180 días)
#   AGENT_IDS       agentes extra separados por espacio (default: AGENT_ID o 42)
#   ACCOUNTS        cuentas PassportAccount extra (C...) separadas por espacio
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; source .env; set +a; fi
OPS=${OPS_SOURCE:-pp-ops}
LEDGERS=${EXTEND_LEDGERS:-3110399}
NET=(--source "$OPS" --network testnet)
VALIDATOR=${VALIDATOR_ID:-CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA}
VERIFIER=${VERIFIER_ID:-CCMKLYSRUH2HMA4UU6WLXWQXEY6KAH5AWB5BEVMJGNGC5GLGTVROLG4A}
VALIDATOR_WASM=${VALIDATOR_WASM:-2cd2e49c99832a909f8ee8a62b1725dc2f8aae650bb0cd833c8b512c3937858b}
VERIFIER_WASM=${VERIFIER_WASM:-98b1823e4b07ac5aa2dff0332eb9b15ecea5efa95a35376caff21bffe269f8bc}
FACTORY=${PASSPORT_FACTORY_ID:-$(cat deploy/passport-factory.txt 2>/dev/null || true)}
FACTORY_WASM=$(cat deploy/passport-factory.wasm-hash.txt 2>/dev/null || true)
ACCOUNT_WASM=$(cat deploy/passport-account.wasm-hash.txt 2>/dev/null || true)

DEMO_AGENT=""; DEMO_ACCOUNT=""
if [ -f deploy/demo-public.json ]; then
  DEMO_AGENT=$(node -e 'console.log(require("./deploy/demo-public.json").agentId ?? "")')
  DEMO_ACCOUNT=$(node -e 'console.log(require("./deploy/demo-public.json").account ?? "")')
fi
AGENTS=$(echo ${AGENT_IDS:-${AGENT_ID:-42}} $DEMO_AGENT | tr ' ' '\n' | sort -u | tr '\n' ' ')
ACCS=$(echo ${ACCOUNTS:-} $DEMO_ACCOUNT | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ')

# Claves XDR de las entradas persistentes (enum de Rust = vec[symbol, valor]).
key_xdr() { # kind valor
  node -e '
const {xdr, nativeToScVal, Address}=require("@stellar/stellar-sdk");
const [kind, v]=process.argv.slice(1);
const val = kind === "AgentOf" ? xdr.ScVal.scvAddress(Address.fromString(v).toScAddress()) : nativeToScVal(BigInt(v),{type:"u256"});
console.log(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind), val]).toXDR("base64"))' "$1" "$2"
}

FAILS=0
run() { # label, comando...
  local label=$1; shift
  local out
  if out=$("$@" 2>&1); then
    echo "   ok  $label: $(echo "$out" | grep -vE '^\s*$' | tail -1)"
  else
    if echo "$out" | grep -qiE "no (entries|ledger entries) to restore|not archived|already|nothing to restore"; then
      echo "   --  $label: no hacía falta"
    else
      echo "  ERR  $label: $(echo "$out" | grep -vE '^\s*$' | tail -2 | tr '\n' ' ')"
      FAILS=$((FAILS+1))
    fi
  fi
}
restore_quiet() { "$@" >/dev/null 2>&1 || true; } # restaurar algo vivo falla; no importa

instance() { # contrato
  restore_quiet stellar contract restore --id "$1" "${NET[@]}"
  run "extend instancia $1" stellar contract extend --id "$1" --ledgers-to-extend "$LEDGERS" "${NET[@]}"
}
wasm() { # hash
  restore_quiet stellar contract restore --wasm-hash "$1" "${NET[@]}"
  run "extend wasm $1" stellar contract extend --wasm-hash "$1" --ledgers-to-extend "$LEDGERS" "${NET[@]}"
}
pkey() { # contrato, kind, valor
  local k; k=$(key_xdr "$2" "$3")
  restore_quiet stellar contract restore --id "$1" --durability persistent --key-xdr "$k" "${NET[@]}"
  run "extend $2($3) en $1" stellar contract extend --id "$1" --durability persistent --key-xdr "$k" --ledgers-to-extend "$LEDGERS" "${NET[@]}"
}

echo "== pagador: $OPS ($(stellar keys address "$OPS")), extender $LEDGERS ledgers"
echo "== OSP"
instance "$VALIDATOR"; wasm "$VALIDATOR_WASM"
instance "$VERIFIER"; wasm "$VERIFIER_WASM"
if [ -n "$FACTORY" ]; then
  echo "== PassportFactory $FACTORY"
  instance "$FACTORY"
  [ -n "$FACTORY_WASM" ] && wasm "$FACTORY_WASM"
  [ -n "$ACCOUNT_WASM" ] && wasm "$ACCOUNT_WASM"
fi
for A in $AGENTS; do
  echo "== agente $A"
  pkey "$VALIDATOR" Passport "$A"
  [ -n "$FACTORY" ] && pkey "$FACTORY" AccountOf "$A"
done
for C in $ACCS; do
  echo "== cuenta $C"
  instance "$C"
  [ -n "$FACTORY" ] && pkey "$FACTORY" AgentOf "$C"
done
echo "== estado"
node scripts/ttl-status.mjs $(for A in $AGENTS; do printf -- "--agent %s " "$A"; done) $(for C in $ACCS; do printf -- "--account %s " "$C"; done)
echo "== saldo restante de $OPS: $(curl -s "https://horizon-testnet.stellar.org/accounts/$(stellar keys address "$OPS")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).balances.find(b=>b.asset_type==="native").balance+" XLM")}catch{console.log("?")}})')"
if [ "$FAILS" -gt 0 ]; then echo "restore-osp: $FAILS errores"; exit 1; fi
echo "restore-osp: OK"
