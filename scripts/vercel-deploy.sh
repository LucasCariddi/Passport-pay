#!/usr/bin/env bash
# Deploy a Vercel por CLI, desde la carpeta local, con build local (--prebuilt) y control de
# secretos ANTES de subir nada. Nunca conecta Vercel a GitHub. Ver docs/DEPLOY.md.
#
#   bash scripts/vercel-deploy.sh            # preview
#   bash scripts/vercel-deploy.sh --prod     # producción
#
# Por qué --prebuilt: el build corre acá (mismo pnpm, mismos node_modules) y lo que se sube
# es solo .vercel/output, que este script revisa entero. Ojo: el trazado de archivos de la
# función (nft) metía el .env de la raíz porque config.mjs lo nombra; vercel.json lo excluye
# con excludeFiles y este control lo verifica en cada deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=${TMPDIR:-/var/tmp}
SCOPE=${VERCEL_SCOPE:-leocagli}
PROD=""
[ "${1:-}" = "--prod" ] && PROD="--prod"
TARGET=$([ -n "$PROD" ] && echo production || echo preview)

vercel pull --yes --environment="$TARGET" --scope "$SCOPE" >/dev/null
rm -rf .vercel/output
vercel build $PROD --scope "$SCOPE"

OUT=.vercel/output
fail=0
if find "$OUT" \( -name '.env*' -o -path '*/.secrets/*' -o -name '*.secret' \) | grep -q .; then
  echo "ERROR: hay archivos .env o .secrets en $OUT:"; find "$OUT" \( -name '.env*' -o -path '*/.secrets/*' -o -name '*.secret' \); fail=1
fi
if grep -rqE '\bS[A-Z2-7]{55}\b' "$OUT"; then
  echo "ERROR: algo con forma de clave S... en $OUT:"; grep -rlE '\bS[A-Z2-7]{55}\b' "$OUT"; fail=1
fi
# Cada secreto local concreto (sin imprimirlo): .secrets/*.secret y *_SECRET / tokens de los .env.
check() { local v=$1 label=$2; [ ${#v} -lt 20 ] && return 0; if grep -rqF -- "$v" "$OUT"; then echo "ERROR: aparece $label en $OUT"; fail=1; fi; }
for f in .secrets/*.secret; do [ -f "$f" ] && check "$(tr -d '\r\n ' < "$f")" "$f"; done
for envf in .env .env.local .vercel/.env.*.local; do
  [ -f "$envf" ] || continue
  while IFS='=' read -r k v; do
    case "$k" in *SECRET*|*TOKEN*) check "$(printf '%s' "$v" | tr -d '"\r\n ')" "$k ($envf)";; esac
  done < "$envf"
done
# Una env var marcada "sensitive" en Vercel llega al build como "[SENSITIVE]": si vite.config.ts
# la copia a un VITE_* (RPC_URL, PASSPORT_FACTORY_ID, MERCHANT_PUBLIC), la web se rompe.
# Las públicas se cargan con --no-sensitive.
if grep -rqF '[SENSITIVE]' "$OUT/static"; then
  echo "ERROR: el bundle tiene valores [SENSITIVE] (env var pública cargada como sensitive):"; grep -rlF '[SENSITIVE]' "$OUT/static"; fail=1
fi
if [ "$fail" != 0 ]; then echo "No se sube nada."; rm -rf "$OUT"; exit 1; fi
echo "control de secretos OK ($(find "$OUT" -type f | wc -l) archivos)"

vercel deploy --prebuilt $PROD --scope "$SCOPE"
