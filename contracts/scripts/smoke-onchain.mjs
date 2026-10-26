// Prueba onchain de la PassportAccount creada por la factory, SIN servidor ni
// facilitador: todas las tx van directo a la red.
//
// 1. Tope acumulado: el dueño deja lugar para 2 pagos; el agente firma 3 pagos
//    (los 3 simulan OK porque cada uno entra solo). Se envían en orden: 2 SUCCESS y
//    el tercero FAILED onchain con Error(Contract, #6) = CapExceeded.
// 2. Revocación: el agente firma un pago, el dueño revoca, se envía el pago:
//    FAILED onchain con Error(Contract, #1) = Revoked. Después el dueño des-revoca
//    (set_agent_key con la misma clave) y deja el tope como estaba.
//
// Uso (desde la raíz): node contracts/scripts/smoke-onchain.mjs [--skip-revoke]
import { execFileSync } from "node:child_process";
import {
  Account, Address, authorizeEntry, Contract, hash, Keypair, nativeToScVal, Networks, Operation, rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

process.loadEnvFile(new URL("../../.env", import.meta.url));
const env = process.env;
const server = new rpc.Server(env.RPC_URL);
const ACCOUNT = env.PASSPORT_ACCOUNT_ID;
const FACTORY = env.PASSPORT_FACTORY_ID;
const USDC = env.USDC_SAC ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PRICE = 100_000n; // 0.01 USDC
const PASS = Networks.TESTNET;
const agent = Keypair.fromSecret(env.AGENT_SECRET);
const payer = Keypair.fromSecret(env.PAYER_SECRET);
const CWD = new URL("..", import.meta.url).pathname; // contracts/: sin .env para el CLI

function cli(...args) {
  return execFileSync("stellar", args, { cwd: CWD, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const invoke = (id, send, ...a) =>
  cli("contract", "invoke", "--id", id, "--source", "pp-owner", "--network", "testnet", ...(send ? [] : ["--send=no"]), "--", ...a);
const status = () => JSON.parse(invoke(ACCOUNT, false, "spend_status"));
const config = () => JSON.parse(invoke(ACCOUNT, false, "config"));

/**
 * Arma, firma (clave del agente) y simula un transfer desde la cuenta.
 * `seq` es la secuencia actual del pagador G; la tx sale con seq + 1.
 */
async function preparePayment(seq) {
  const src = () => new Account(payer.publicKey(), seq.toString());
  const call = new Contract(USDC).call(
    "transfer",
    new Address(ACCOUNT).toScVal(),
    new Address(env.MERCHANT_PUBLIC).toScVal(),
    nativeToScVal(PRICE, { type: "i128" }),
  );
  const draft = new TransactionBuilder(src(), { fee: "10000000", networkPassphrase: PASS })
    .addOperation(call).setTimeout(300).build();
  const sim = await server.simulateTransaction(draft);
  if (rpc.Api.isSimulationError(sim)) throw new Error("simulación (record) falló: " + sim.error);
  const { sequence } = await server.getLatestLedger();
  // stellar-sdk serializa {signature, publicKey} como Vec<{public_key, signature}>,
  // que es el tipo Signature del __check_auth de PassportAccount.
  const signer = async (preimage) => ({
    signature: agent.sign(hash(preimage.toXDR())),
    publicKey: agent.publicKey(),
  });
  const auth = await Promise.all(sim.result.auth.map((e) => authorizeEntry(e, signer, sequence + 200, PASS)));
  const func = draft.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction();
  const tx2 = new TransactionBuilder(src(), { fee: "10000000", networkPassphrase: PASS })
    .addOperation(Operation.invokeHostFunction({ func, auth })).setTimeout(300).build();
  // Re-simulación en modo enforcing: acá corre __check_auth de verdad.
  const sim2 = await server.simulateTransaction(tx2);
  if (rpc.Api.isSimulationError(sim2)) throw new Error("simulación (enforcing) falló: " + sim2.error);
  const ready = rpc.assembleTransaction(tx2, sim2).build();
  ready.sign(payer);
  return ready;
}

async function send(tx) {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") return { status: "REJECTED", hash: sent.hash, detail: sent.errorResult?.result().switch().name };
  let r;
  for (let i = 0; i < 40; i++) {
    r = await server.getTransaction(sent.hash);
    if (r.status !== "NOT_FOUND") break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  let detail = "";
  if (r.status === "FAILED") {
    // Busca el ScError de contrato en los eventos de diagnóstico (Error(Contract, #n)).
    const codes = [];
    for (const e of r.diagnosticEventsXdr ?? []) {
      try {
        const body = e.event().body().v0();
        for (const v of [...body.topics(), body.data()]) {
          if (v.switch().name === "scvError" && v.error().switch().name === "sceContract") codes.push(v.error().contractCode());
        }
      } catch { /* evento con otra forma */ }
    }
    detail = codes.length ? `Error(Contract, #${codes[0]})` : "(ver explorer)";
  }
  return { status: r.status, hash: sent.hash, detail };
}

const out = { account: ACCOUNT, factory: FACTORY, steps: [] };
const log = (k, v) => { out.steps.push({ [k]: v }); console.log(k, JSON.stringify(v)); };

log("is_account", invoke(FACTORY, false, "is_account", "--account", ACCOUNT));
const cfg0 = config();
const s0 = status();
log("estado_inicial", s0);
const spent = BigInt(s0.spent);

// 1) tope acumulado
invoke(ACCOUNT, true, "set_cap", "--cap", String(spent + 2n * PRICE), "--period_ledgers", String(cfg0.period_ledgers));
log("tope_para_2_pagos", status());
let seq = BigInt((await server.getAccount(payer.publicKey())).sequenceNumber());
const txs = [];
for (let i = 0n; i < 3n; i++) txs.push(await preparePayment(seq + i));
log("firmados_y_simulados", 3);
for (let i = 0; i < 3; i++) log(`pago_${i + 1}`, await send(txs[i]));
log("estado_tras_pagos", status());

// 2) revocación
if (!process.argv.includes("--skip-revoke")) {
  invoke(ACCOUNT, true, "set_cap", "--cap", String(BigInt(status().spent) + PRICE), "--period_ledgers", String(cfg0.period_ledgers));
  seq = BigInt((await server.getAccount(payer.publicKey())).sequenceNumber());
  const pending = await preparePayment(seq);
  log("pago_firmado_antes_de_revocar", "ok");
  invoke(ACCOUNT, true, "revoke");
  log("revocada", config().revoked);
  log("pago_tras_revocar", await send(pending));
  const keyHex = Buffer.from(agent.rawPublicKey()).toString("hex");
  invoke(ACCOUNT, true, "set_agent_key", "--agent_key", keyHex);
  log("des_revocada", !config().revoked);
}

invoke(ACCOUNT, true, "set_cap", "--cap", String(cfg0.cap), "--period_ledgers", String(cfg0.period_ledgers));
log("estado_final", status());
console.log("RESULT_JSON=" + JSON.stringify(out));
