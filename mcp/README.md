# Passport Pay MCP

Servidor MCP por stdio que convierte a cualquier agente (Claude Code, Claude Desktop u
otro cliente MCP) en cliente de Passport Pay. El agente compra datos y paga desde **su
cuenta contrato** (`PassportAccount`) en `stellar:testnet`, firmando con su propia clave.

Las reglas de gasto no viven en este servidor. Viven en la cuenta, en la red: este MCP
firma lo que el agente le pide y manda la tx; si la cuenta no lo autoriza, la tx queda
FAILED en el ledger y la respuesta lo dice con el error del contrato.

Solo testnet. El servidor se niega a arrancar con otra red.

## Herramientas

| Herramienta | Qué hace | Mueve plata |
|---|---|---|
| `list_services` | Lee `GET /api/catalog` del servidor Passport Pay: id, qué devuelve, precio y parámetros. | no |
| `buy(service, params)` | Compra un servicio del catálogo. Paga por x402 desde la cuenta (esquema cliente de `agent/src`) y devuelve la respuesta y el hash. | sí, el precio del servicio |
| `spend_status` | Lee de la red el saldo, el tope por período, lo gastado, lo disponible, cuándo se renueva y si la cuenta está revocada. | no |
| `pay(to, amount_usdc, memo)` | Firma un `transfer` de USDC desde la cuenta a cualquier dirección y **siempre** lo manda a la red. Devuelve SUCCESS con el hash, o FAILED con el hash y el `Error(Contract, #n)` atribuido a `__check_auth` de la cuenta. | sí |

`pay` es la herramienta que un atacante intentaría usar con un prompt injection. No tiene
ningún tope propio a propósito: lo que pasa o no pasa lo decide la cuenta en la red.

- `memo` vuelve en la respuesta pero **no queda en la red**: testnet rechaza las txs de
  Soroban con memo (`Soroban transactions do not support memos`, visto en la primera corrida).
- Si la simulación del transfer falla antes de llegar a `__check_auth` (sin saldo, destino
  sin trustline de USDC), no hay tx que mandar y la respuesta es `NOT_SENT` con el motivo.
- Si la simulación de `__check_auth` rechaza el pago, `pay` arma la tx igual (mismo método
  que `--force-onchain` de la CLI del agente) y la manda: así el rechazo queda en el ledger.
- `buy` sí tiene un límite **local** por compra (`PASSPORT_PAY_MAX_PER_BUY_USDC`, default 1).
  Es del cliente x402, no de la red, y la respuesta lo dice aparte.

## Instalación

Desde la raíz del repo, en WSL:

```sh
pnpm install                                   # dependencias del monorepo (stellar-sdk, x402)
cd mcp && pnpm install --ignore-workspace      # SDK de MCP y zod
```

Usa los módulos de `agent/src` (esquema x402 para cuentas C, lecturas onchain) y el
`@stellar/stellar-sdk` de la raíz, así que necesita el repo completo, no solo esta carpeta.
`mcp/` todavía no está en `pnpm-workspace.yaml`: por eso el `--ignore-workspace`.

### Clave del agente

La clave del agente **nunca** va en una variable de entorno ni en `.mcp.json`. Va en un
archivo dentro de `.secrets/` (ignorado por git), en uno de dos formatos:

```json
{ "account": "C...", "agentSecret": "S..." }
```

o un archivo de texto con la clave `S...` sola (y la cuenta en `PASSPORT_ACCOUNT_ID`). Los
`.secrets/demo-agent-<id>.json` que escribe `contracts/scripts/register-demo.mjs` sirven tal cual
si se agrega `PASSPORT_ACCOUNT_ID`.

Para una cuenta nueva: `node contracts/scripts/register-demo.mjs --cap 10000000 --period 17280`
(tope de 1 USDC por ~1 día), el dueño deposita con `node agent/src/cli.mjs fund --usdc 1.5
--account C...`, y la G del agente necesita XLM de friendbot porque paga el fee de `pay`.

### Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `PASSPORT_AGENT_SECRET_FILE` | `.secrets/mcp-agent.json` | archivo con la clave del agente (relativo a la raíz o absoluto) |
| `PASSPORT_ACCOUNT_ID` | `account` del archivo | PassportAccount (C...) que paga |
| `PASSPORT_PAY_SERVER_URL` | `https://passport-pay-stellar.vercel.app` | servidor x402 (local: `http://127.0.0.1:4021`) |
| `PASSPORT_PAY_MAX_PER_BUY_USDC` | `1` | límite local de `buy` por compra |
| `PASSPORT_FEE_PAYER_SECRET_FILE` | la clave del agente | otra G que pague el fee de `pay` |
| `RPC_URL` | RPC público de testnet | Soroban RPC |
| `USDC_SAC` | USDC de Circle en testnet | activo |

## Configuración en el cliente

### Claude Code dentro de WSL

```sh
claude mcp add passport-pay \
  -e PASSPORT_AGENT_SECRET_FILE=/root/work/passport-pay/.secrets/mcp-agent.json \
  -e PASSPORT_PAY_SERVER_URL=https://passport-pay-stellar.vercel.app \
  -- node /root/work/passport-pay/mcp/src/server.mjs
```

### `.mcp.json` (Claude Code dentro de WSL o en Linux)

```json
{
  "mcpServers": {
    "passport-pay": {
      "type": "stdio",
      "command": "node",
      "args": ["/root/work/passport-pay/mcp/src/server.mjs"],
      "env": {
        "PASSPORT_AGENT_SECRET_FILE": "/root/work/passport-pay/.secrets/mcp-agent.json",
        "PASSPORT_PAY_SERVER_URL": "https://passport-pay-stellar.vercel.app"
      }
    }
  }
}
```

### Claude Code o Claude Desktop en Windows, con el código en WSL

Las variables de `env` no cruzan a WSL, así que se pasan con `env` dentro del comando:

```json
{
  "mcpServers": {
    "passport-pay": {
      "type": "stdio",
      "command": "wsl",
      "args": [
        "-e", "env",
        "PASSPORT_AGENT_SECRET_FILE=/root/work/passport-pay/.secrets/mcp-agent.json",
        "PASSPORT_PAY_SERVER_URL=https://passport-pay-stellar.vercel.app",
        "node", "/root/work/passport-pay/mcp/src/server.mjs"
      ]
    }
  }
}
```

Este bloque se probó con Claude Code en Windows (`claude -p --mcp-config <archivo>
--strict-mcp-config`): llamó a `spend_status` y a `list_services` + `buy` (ver abajo). En
Claude Desktop no se probó; el bloque va en `claude_desktop_config.json` con la misma forma.

## Tests

```sh
cd mcp
pnpm test                      # sin red: config, validación, resultados y protocolo MCP en memoria
node scripts/testnet-smoke.mjs # real, contra testnet y el servidor publicado, por stdio
```

`testnet-smoke.mjs` levanta `src/server.mjs` por stdio como lo haría Claude Code y llama a
las 4 herramientas: catálogo, estado, una compra por x402, un `pay` chico al "atacante" y un
`pay` por encima de lo disponible. El "atacante" es `SMOKE_ATTACKER` o `PAYER_PUBLIC` del
`.env` (una G nuestra de prueba con trustline de USDC). Cuesta unos 0.02 USDC de testnet
más lo que el contrato deje pasar en el `pay` chico.

## Evidencia (25 oct 2026, testnet)

Cuenta del MCP: [`CCOJVBZS…6XDV2SSV`](https://stellar.expert/explorer/testnet/contract/CCOJVBZSTR4NSKCOUAAIEU775PZVUB7U7OZ7GXCDFSZRSCUW6XDV2SSV),
pasaporte #4261603546, tope 1 USDC por 17 280 ledgers, depósito 1.5 USDC. Las txs de la
tabla salen de `testnet-smoke.mjs` (`SMOKE OK 6/6`) y de Claude Code, y su estado se
confirmó con `getTransaction` del RPC.

| Paso | En el ledger | Tx |
|---|---|---|
| `register` de la cuenta del MCP | SUCCESS | [`124a141d…b4669`](https://stellar.expert/explorer/testnet/tx/124a141d7cf552b8dcac587713dea45b0fb7700efc5072c1d17d6b8617a4b669) |
| Depósito del dueño, 1.5 USDC | SUCCESS | [`a26b184d…e2790`](https://stellar.expert/explorer/testnet/tx/a26b184d51ecf201351253c20df0cfdadca4de9a84791609eb52876d4a1e2790) |
| `buy insight` por x402 (0.01 USDC), por stdio | SUCCESS | [`7896874e…d2aa4`](https://stellar.expert/explorer/testnet/tx/7896874e1f26588498890e6d5dc503b8234976429536500e683663c70a3d2aa4) |
| `pay` 0.01 USDC al "atacante", dentro del tope | **SUCCESS** | [`8200a876…61f6b`](https://stellar.expert/explorer/testnet/tx/8200a876f67edf9be549a85877ecee86aa2211a03c6f25ef13200f9a37361f6b) |
| `pay` 0.98 USDC al "atacante", por encima de lo disponible (0.97) | **FAILED `Error(Contract, #6)`** de `__check_auth` de la cuenta | [`1ae887cf…b9963`](https://stellar.expert/explorer/testnet/tx/1ae887cf33004763b7b6e1c718399d041bc3469fdb765034e65e37b6448b9963) |
| Claude Code (Windows) eligió y compró `quote` (0.02 USDC) solo con el MCP | SUCCESS | [`d0e84386…1db6f`](https://stellar.expert/explorer/testnet/tx/d0e843869ad2f34bfb58687d1b4c2394b5298cb59bb78e1a49b68e734d01db6f) |

Lo que muestra y lo que no:

- El FAILED lo devolvió el contrato de la cuenta: el evento de diagnóstico `failed account
  authentication with error` nombra a `CCOJVBZS…` con el código #6. El MCP no tiene ningún
  `if` de tope en `pay`.
- **Con el contrato desplegado hoy, un pago al atacante dentro del tope pasa** (fila
  SUCCESS de 0.01). El tope acota cuánto se pierde, no a quién se le paga. Que el pago a un
  destino que no está permitido falle necesita el cambio de contrato que se está trabajando
  aparte; este MCP no lo simula ni lo tapa.
- No se probó todavía un agente real leyendo una página con prompt injection. Lo probado es
  que, si el agente llama a `pay`, la respuesta es lo que dijo el ledger.
