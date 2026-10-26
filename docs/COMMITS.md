# Propuesta de commits

El repo todavía no tiene commits: todo está sin seguimiento. Esta es una propuesta para
subirlo por partes, agrupado por área, en un orden donde cada commit tiene sentido solo.
**No es la cronología real**: varias partes se tocaron más de una vez durante el evento (por
ejemplo, el arreglo de seguridad de `passport-account` y la lista de destinos permitidos ya
están en el mismo archivo).

Los cortes cubren el 100% de los archivos que no están en `.gitignore`. Casi todos usan la
carpeta entera (`git add carpeta/`), así que un archivo nuevo dentro de esas carpetas entra
solo en su corte. Lo que queda afuera a propósito, porque se genera o es local:

- `public/` en la raíz: la salida de `scripts/build-vercel.sh` para Vercel.
- `web/dist/`, `web/dist-landing/`, `.vercel/`, `node_modules`, `contracts/target/`, logs.
- `.env`, `.env.*` (salvo `.env.example`) y `.secrets/`: **nunca** se suben.
- `scenario/.*`: sondas locales de las corridas del escenario.

`subir-por-partes.sh` lee este archivo: toma cada bloque `sh` de la sección
**Cortes sugeridos**, en orden, y hace el `git add`, el control de secretos, el
`git commit` y el `git push` de cada uno. Si cambiás el formato (`### N.`, un bloque `sh` por
corte, el `git commit` al final del bloque), el loop deja de encontrar los cortes.

## Antes de empezar

```sh
git init -b main            # si todavía no está inicializado

# 1. Nada de secretos: .env, .env.* (salvo .env.example) y .secrets/ no tienen que aparecer
#    como archivos para agregar (no tiene que imprimir nada):
git ls-files --others --exclude-standard | grep -E '(^|/)\.env($|\.)|(^|/)\.secrets/' | grep -v '\.env\.example$'

# 2. Ningún secreto de Stellar en lo que se va a subir (no tiene que imprimir nada):
git ls-files --others --exclude-standard -z | xargs -0 grep -IlE '\bS[A-Z2-7]{55}\b'
```

## Cortes sugeridos

Cada bloque es un `git add` y un `git commit`. Los mensajes van en inglés, en el estilo
convencional.

### 1. Base del monorepo

```sh
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .gitignore .env.example LICENSE
git commit -m "chore: monorepo base (pnpm workspace, env example, MIT license)"
```

### 2. Librería previa: open-stellar-passport

```sh
git add vendor/ contracts/osp-wasm/
git commit -m "vendor: add open-stellar-passport (Apache-2.0, unmodified)" \
  -m "Prover, SDK and zk artifacts from Bitcoindefi/open-stellar-passport@9cb82e44, plus the deployed validator and verifier wasm and the agent 42 proof fixtures. Prior work, not built during HackMeridian. LICENSE and NOTICE kept."
```

### 3. Scripts de testnet y spike de x402

```sh
git add scripts/gen-keys.sh scripts/setup-testnet.mjs scripts/restore-osp.sh \
        scripts/diag-sim.mjs scripts/spike-x402.mjs
git commit -m "chore(scripts): testnet keys, USDC setup, OSP restore and x402 spike"
```

### 4. Contrato PassportAccount

```sh
git add contracts/Cargo.toml contracts/Cargo.lock contracts/.gitignore contracts/passport-account/ \
        scripts/deploy-account.sh scripts/fund-account.sh scripts/prove-onchain-cap.mjs
git commit -m "feat(contracts): PassportAccount enforces passport, payee allowlist, spend cap and revocation" \
  -m "__check_auth lets the agent key sign a USDC SAC transfer only while the owner has not revoked the account, the validator still holds the agent passport, the destination is on the owner's payee allowlist and the per-period cap holds."
```

### 5. Contrato PassportFactory y despliegue en testnet

```sh
git add contracts/passport-factory/ contracts/scripts/ deploy/ scripts/ttl-status.mjs
git commit -m "feat(contracts): PassportFactory registers the passport and deploys the account in one tx" \
  -m "Includes the testnet ids and wasm hashes in deploy/ and a read-only TTL status script."
```

### 6. Bindings TypeScript

```sh
git add contracts/bindings/ contracts/
git commit -m "feat(bindings): generated TS bindings for factory and account"
```

### 7. Servidor x402

```sh
git add server/
git commit -m "feat(server): x402 paid API with factory admission and contract error mapping"
```

### 8. Agente

```sh
git add agent/
git commit -m "feat(agent): x402 client scheme for contract accounts and passport-agent CLI"
```

### 9. Panel web del dueño

```sh
git add web/.gitignore web/index.html web/package.json web/tsconfig.json web/vite.config.ts \
        web/src/ web/e2e/
git commit -m "feat(web): owner panel with in-browser proof, deposit, cap, payees and revoke"
```

### 10. Demo de punta a punta y tests

```sh
git add scripts/demo.sh scripts/demo.mjs scripts/test-all.sh
git commit -m "feat(demo): end-to-end testnet demo and test-all script"
```

### 11. Servidor MCP

```sh
git add mcp/
git commit -m "feat(mcp): stdio MCP server so any MCP client pays from its PassportAccount"
```

### 12. Escenario de prompt injection

```sh
git add scenario/ web/public/trampa/
git commit -m "feat(scenario): prompt-injected agent tries to pay an attacker through MCP" \
  -m "A staged trap page tells a real LLM agent to pay an attacker. The agent signs with its own key and PassportAccount.__check_auth decides onchain. verify-defense.mjs checks the rejection directly against testnet. Only the trap page is staged."
```

### 13. Presentación, notas y deck

```sh
git add site/ deck/ design/
git commit -m "feat(pitch): presentation, speaker notes, shared evidence and deck build"
```

### 14. Video de la demo y media

```sh
git add video/ web/public/media/
git commit -m "feat(video): scripted demo capture and render, plus demo video, poster and deck exports"
```

### 15. Landing y docs públicos

```sh
git add web/landing/ web/vite.landing.config.ts web/
git commit -m "feat(web): landing page and public docs pages"
```

### 16. Deploy en Vercel

```sh
git add vercel.json .vercelignore api/ scripts/
git commit -m "feat(deploy): one Vercel project for the landing, app, deck and x402 API"
```

### 17. Documentación

```sh
git add README.md README.es.md docs/
git commit -m "docs: README for judges (English and Spanish), architecture, deploy guide, AI disclosure, video and deck notes"
```

Si querés declarar la asistencia de IA también en el historial, se puede agregar a los
commits la línea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. La
declaración completa está en `docs/AI.md`.

## Al final

```sh
git status --short --untracked-files=all       # solo pueden quedar LEEME-LUCAS.md y subir-por-partes.sh
git ls-files | grep -E '(^|/)\.env$|\.secrets/'  # no tiene que imprimir nada
git log --oneline
```
