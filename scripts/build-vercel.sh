#!/usr/bin/env bash
# Arma la salida estática para Vercel (ver docs/DEPLOY.md, sección 2.2).
#   /             landing (web/landing, build:landing) y /docs/* (README y docs/ en HTML)
#   /presentacion site/presentacion/
#   /notas        site/notas/
#   /media/*      web/public/media/ (demo.mp4, demo-poster.png, passport-pay.pptx)
#   /app/         web compilada con WEB_BASE=/app/, hablando con /api del mismo dominio
# Corta si encuentra algo con forma de clave secreta de Stellar (S + 55) en public/.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf public && mkdir -p public
if [ -d site ]; then cp -r site/. public/; else echo "aviso: no hay site/ todavía (presentación y notas)"; fi
# Landing (/) y docs públicos (/docs, /docs/arquitectura, /docs/ia): web/landing, build propio
# (web/vite.landing.config.ts). Va después de site/ y gana sobre un site/index.html.
( cd web && pnpm build:landing )
cp -r web/dist-landing/. public/
( cd web && WEB_BASE=/app/ VITE_API_URL=same-origin pnpm build )
rm -rf public/app && cp -r web/dist public/app
# /media en la raíz: video de la demo, poster y .pptx (los usan /presentacion y la landing)
if [ -d web/public/media ]; then rm -rf public/media && cp -r web/public/media public/media; fi
# /trampa en la raíz: la página trampa del escenario de prompt injection (la enlazan la landing y /app)
if [ -d web/public/trampa ] && [ ! -e public/trampa ]; then cp -r web/public/trampa public/trampa; fi
if grep -rEq 'S[A-Z2-7]{55}' public; then
  echo "ERROR: hay algo con forma de clave S... en public/:"
  grep -rlE 'S[A-Z2-7]{55}' public
  exit 1
fi
echo "public/ listo, sin claves S...: $(find public -type f | wc -l) archivos"
