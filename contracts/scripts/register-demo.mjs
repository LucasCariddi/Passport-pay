// Mintea un pasaporte NUEVO en testnet y crea su cuenta con PassportFactory.register,
// todo desde Node (mismo código de prueba que va a correr el navegador):
//
//   1. secreto aleatorio + agentId aleatorio; registro de un solo miembro (pathElements = 0)
//   2. registryRoot y nullifierHash con el circuito auxiliar passport_witness.wasm
//   3. prueba Groth16 con agent_passport.wasm + zkey, verificada off-chain
//   4. `register` firmado por pp-owner: verify_and_register + deploy en UNA tx
//   5. `add_payee` firmado por pp-owner: desde el wasm b9dfc7c6… la cuenta nace sin destinos
//      permitidos y no le puede pagar a nadie. Por defecto se agrega MERCHANT_PUBLIC (el payTo
//      del servidor); `--payee <G|C>` elige otro y `--no-payee` deja la cuenta sin destinos.
//
// Guarda el secreto del pasaporte y la clave del agente nuevo en .secrets/ (ignorado).
// Uso (desde la raíz): node contracts/scripts/register-demo.mjs [--cap 500000] [--period 17280]
//                      [--payee <G|C> | --no-payee]
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { loadAgentConfig } from "../../agent/src/config.mjs";

const root = new URL("../../", import.meta.url);
// Carga .env y, si no define PASSPORT_FACTORY_ID, lo toma de deploy/passport-factory.txt
// (versionado). Un .env recién generado por scripts/gen-keys.sh solo trae claves.
const cfg0 = loadAgentConfig();
const snarkjs = createRequire(new URL("web/package.json", root))("snarkjs");
const zk = (f) => new URL(`vendor/osp/zk/${f}`, root).pathname;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

const CAP = arg("--cap", "500000");
const PERIOD = arg("--period", "17280");
const SPEND_CAP = arg("--spend-cap", "500000000"); // 50 USDC, lo que "garantiza" el pasaporte
const FACTORY = cfg0.factoryId;
if (!FACTORY || !process.env.OWNER_PUBLIC) {
  console.error("falta PASSPORT_FACTORY_ID (deploy/passport-factory.txt) u OWNER_PUBLIC (.env): corré scripts/gen-keys.sh");
  process.exit(1);
}
const R = 21888242871839275222246405745257275088548364400416224936380193342026575620617n; // p BN254 (Fr)

const privateKey = (BigInt("0x" + randomBytes(32).toString("hex")) % R).toString();
const agentId = (1_000_000n + BigInt("0x" + randomBytes(4).toString("hex"))).toString();
const pathElements = Array(20).fill("0");
const pathIndices = "0";

console.log("1) agentId", agentId);
const t0 = Date.now();
const wt = { type: "mem" };
await snarkjs.wtns.calculate({ privateKey, agentId, pathElements, pathIndices }, zk("passport_witness.wasm"), wt);
const w = await snarkjs.wtns.exportJson(wt);
const registryRoot = w[1].toString();
const nullifierHash = w[2].toString();
console.log("2) registryRoot", registryRoot, "nullifier", nullifierHash);

const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  { registryRoot, nullifierHash, agentId, spendCap: SPEND_CAP, privateKey, balance: SPEND_CAP, pathElements, pathIndices },
  zk("agent_passport.wasm"), zk("agent_passport_final.zkey"),
);
const vk = JSON.parse(readFileSync(zk("verification_key.json"), "utf8"));
const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
console.log(`3) prueba generada en ${Date.now() - t0} ms, verificación off-chain: ${ok}`);
if (!ok) process.exit(1);

// Layout Soroban: G1 = x||y ; G2 = x.c1||x.c0||y.c1||y.c0 (32 B BE cada coordenada)
const be = (d) => BigInt(d).toString(16).padStart(64, "0");
const proofArg = {
  a: be(proof.pi_a[0]) + be(proof.pi_a[1]),
  b: be(proof.pi_b[0][1]) + be(proof.pi_b[0][0]) + be(proof.pi_b[1][1]) + be(proof.pi_b[1][0]),
  c: be(proof.pi_c[0]) + be(proof.pi_c[1]),
};

const agent = Keypair.random();
mkdirSync(new URL(".secrets/", root), { recursive: true });
writeFileSync(new URL(`.secrets/demo-agent-${agentId}.json`, root), JSON.stringify({
  agentId, agentPublic: agent.publicKey(), agentSecret: agent.secret(), passportPrivateKey: privateKey,
}, null, 2), { mode: 0o600 });

const cwd = new URL("contracts/", root).pathname; // sin .env (el CLI lo leería)
const reg = spawnSync("stellar", [
  "contract", "invoke", "--id", FACTORY, "--source", "pp-owner", "--network", "testnet", "--",
  "register", "--owner", process.env.OWNER_PUBLIC,
  "--agent_key", Buffer.from(agent.rawPublicKey()).toString("hex"),
  "--proof", JSON.stringify(proofArg), "--public_inputs", JSON.stringify(publicSignals),
  "--cap", CAP, "--period_ledgers", PERIOD,
], { cwd, encoding: "utf8" });
if (reg.status !== 0) {
  console.error("register falló:", reg.stderr);
  process.exit(1);
}
const txHash = /tx\/([0-9a-f]{64})/.exec(reg.stderr)?.[1];
const account = reg.stdout.trim().replace(/"/g, "");
console.log("4) cuenta creada", account, "tx", txHash);
// Lectura simulada. Justo después del register el RPC a veces todavía no ve la cuenta nueva:
// se reintenta hasta 4 veces con 3 s de espera antes de darse por vencido.
function readContract(id, fnArgs) {
  for (let i = 1; ; i++) {
    try {
      return execFileSync("stellar", ["contract", "invoke", "--id", id, "--source", "pp-owner", "--network", "testnet",
        "--send=no", "--", ...fnArgs], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (e) {
      if (i >= 4) throw e;
      console.log(`   lectura ${fnArgs[0]} falló (intento ${i}): ${String(e.stderr ?? e.message).trim().split("\n").pop()}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
  }
}
const isAcc = readContract(FACTORY, ["is_account", "--account", account]);
const cfg = readContract(account, ["config"]);
console.log("   is_account:", isAcc);
console.log("   config:", cfg);

const PAYEE = process.argv.includes("--no-payee") ? null : arg("--payee", process.env.MERCHANT_PUBLIC);
let payeeTx = null;
if (PAYEE) {
  const add = spawnSync("stellar", ["contract", "invoke", "--id", account, "--source", "pp-owner", "--network", "testnet",
    "--", "add_payee", "--payee", PAYEE], { cwd, encoding: "utf8" });
  if (add.status !== 0) {
    console.error("add_payee falló:", add.stderr);
    process.exit(1);
  }
  payeeTx = /tx\/([0-9a-f]{64})/.exec(add.stderr)?.[1] ?? null;
  console.log("5) destino permitido", PAYEE, "tx", payeeTx);
} else {
  console.log(process.argv.includes("--no-payee")
    ? "5) --no-payee: la cuenta queda sin destinos permitidos (no puede pagar hasta add_payee)"
    : "5) sin MERCHANT_PUBLIC ni --payee: la cuenta queda sin destinos permitidos (no puede pagar hasta add_payee)");
}
const payees = JSON.parse(readContract(account, ["payees"]));
console.log("   payees:", JSON.stringify(payees));
console.log(`REGISTER_RESULT=${JSON.stringify({ agentId, account, agentPublic: agent.publicKey(), tx: txHash, payees, payeeTx })}`);
process.exit(0); // snarkjs deja workers vivos
