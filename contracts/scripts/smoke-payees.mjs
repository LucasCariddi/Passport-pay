// Prueba en testnet de la lista de destinos permitidos (allowlist de `to`) de
// PassportAccount, con el wasm que hoy usa la factory. HISTORIA A: al agente le hacen
// prompt injection y firma un pago al atacante; la red lo rechaza igual.
//
//  1. pasaporte NUEVO + cuenta vía PassportFactory.register (contracts/scripts/register-demo.mjs)
//  2. la cuenta nace sin destinos: un pago al comercio lo rechaza __check_auth (#10)
//  3. el dueño agrega al comercio (add_payee)
//  4. pago x402 al comercio: verify + settle con el facilitador OFICIAL (@x402/stellar)
//  5. HISTORIA A: un 402 malicioso pide pagarle al atacante. El agente firma igual:
//     - su propia simulación enforcing da #10,
//     - el facilitador oficial lo rechaza en verify,
//     - mandado directo a la red (sin servidor ni facilitador): FAILED #10.
//  6. control con el mismo armado de tx: al comercio SUCCESS; por encima del tope FAILED #6;
//     con la cuenta revocada FAILED #1. Después des-revoca con la misma clave.
//
// Uso (desde la raíz): node contracts/scripts/smoke-payees.mjs
// Costo: 0.05 USDC de depósito, ~0.02 USDC de pagos al comercio y centavos de XLM.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { createOnchain, addr, i128, bytes32 } from "../../agent/src/onchain.mjs";
import { PassportAccountExactScheme, OnchainRejection } from "../../agent/src/passport-account-scheme.mjs";
import { createOfficialFacilitator } from "../../server/src/facilitator.mjs";

const root = new URL("../../", import.meta.url);
process.loadEnvFile(new URL(".env", root));
const env = process.env;
const NETWORK = "stellar:testnet";
const USDC = env.USDC_SAC ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MERCHANT = env.MERCHANT_PUBLIC;
const ATTACKER = arg("--attacker", "GCSNRR57ZTUN7HI7YLFGSDV2MMJS4BF3OZIY3NXO2AKPFQKFFRFC3DFO"); // identidad pp-attacker
const PRICE = 100_000n; // 0.01 USDC
const CAP = 300_000n; // 0.03 USDC por período
const owner = Keypair.fromSecret(env.OWNER_SECRET);
const chain = createOnchain({ rpcUrl: env.RPC_URL });

function arg(k, d) {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
}

const out = { at: new Date().toISOString(), steps: [] };
let failures = 0;
function log(step, v, ok = true) {
  if (!ok) failures++;
  out.steps.push({ step, ok, ...v });
  console.log(`${ok ? "OK  " : "FAIL"} ${step} ${JSON.stringify(v)}`);
}

async function accountWasmHash(id) {
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new Address(id).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
  }));
  const r = await chain.server.getLedgerEntries(key);
  return r.entries[0].val.contractData().val().instance().executable().wasmHash().toString("hex");
}

const requirements = (payTo) => ({
  scheme: "exact",
  network: NETWORK,
  asset: USDC,
  amount: PRICE.toString(),
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
});

async function agentPayload(accountId, agentSecret, payTo, preflight) {
  const scheme = new PassportAccountExactScheme({ accountId, agentSecret, rpcConfig: { url: env.RPC_URL }, preflight });
  const req = requirements(payTo);
  const p = await scheme.createPaymentPayload(2, req);
  return { payload: { ...p, accepted: req, resource: { url: "https://passport-pay.invalid/api/premium/insight" } }, req };
}

// 1) pasaporte nuevo + cuenta (wasm actual de la factory), sin destinos a propósito (--no-payee)
const reg = spawnSync("node", [new URL("contracts/scripts/register-demo.mjs", root).pathname, "--cap", CAP.toString(), "--period", "17280", "--no-payee"], {
  cwd: root.pathname, encoding: "utf8",
});
const line = /REGISTER_RESULT=(.*)/.exec(reg.stdout ?? "");
if (reg.status !== 0 || !line) {
  console.error(reg.stdout, reg.stderr);
  throw new Error("register-demo falló");
}
const R = JSON.parse(line[1]);
const ACCOUNT = R.account;
const agentSecret = JSON.parse(readFileSync(new URL(`.secrets/demo-agent-${R.agentId}.json`, root), "utf8")).agentSecret;
out.account = ACCOUNT;
out.agentId = R.agentId;
out.agentPublic = R.agentPublic;
const wasm = await accountWasmHash(ACCOUNT);
const factoryWasm = readFileSync(new URL("deploy/passport-account.wasm-hash.txt", root), "utf8").trim();
log("register", { account: ACCOUNT, tx: R.tx, wasm }, wasm === factoryWasm);
const payees0 = await chain.read(ACCOUNT, "payees");
log("cuenta_nueva_sin_destinos", { payees: payees0 }, Array.isArray(payees0) && payees0.length === 0);

// depósito del dueño
const dep = await chain.invoke(owner, USDC, "transfer", [addr(owner.publicKey()), addr(ACCOUNT), i128(500_000n)]);
log("deposito_0.05", dep, dep.status === "SUCCESS");

// 2) sin destinos: ni siquiera al comercio
try {
  await agentPayload(ACCOUNT, agentSecret, MERCHANT, true);
  log("sin_destinos_pago_al_comercio", { result: "pasó (no debería)" }, false);
} catch (e) {
  const ce = e instanceof OnchainRejection ? e.contractError : null;
  log("sin_destinos_pago_al_comercio", { rechazo: ce?.raw ?? String(e.message).slice(0, 200), stage: e.stage }, ce?.code === 10);
}

// 3) el dueño agrega al comercio
const add = await chain.invoke(owner, ACCOUNT, "add_payee", [addr(MERCHANT)]);
const payees1 = await chain.read(ACCOUNT, "payees");
log("add_payee_comercio", { ...add, payees: payees1 }, add.status === "SUCCESS" && payees1.length === 1 && payees1[0] === MERCHANT);

// 4) pago x402 al comercio con el facilitador oficial
const facilitator = createOfficialFacilitator({
  network: NETWORK,
  facilitatorSecret: env.FACILITATOR_SECRET,
  maxFeeStroops: Number(env.FACILITATOR_MAX_FEE_STROOPS ?? 100_000_000),
  rpcUrl: env.RPC_URL,
});
{
  const { payload, req } = await agentPayload(ACCOUNT, agentSecret, MERCHANT, true);
  const v = await facilitator.verify(payload, req);
  log("x402_comercio_verify", { isValid: v.isValid, invalidReason: v.invalidReason, payer: v.payer }, v.isValid === true);
  const s = await facilitator.settle(payload, req);
  log("x402_comercio_settle", { success: s.success, tx: s.transaction, errorReason: s.errorReason }, s.success === true);
}

// 5) HISTORIA A: 402 malicioso con payTo = atacante
try {
  await agentPayload(ACCOUNT, agentSecret, ATTACKER, true);
  log("atacante_simulacion_del_agente", { result: "pasó (no debería)" }, false);
} catch (e) {
  const ce = e instanceof OnchainRejection ? e.contractError : null;
  log("atacante_simulacion_del_agente", { rechazo: ce?.raw ?? String(e.message).slice(0, 200), stage: e.stage }, ce?.code === 10);
}
{
  const { payload, req } = await agentPayload(ACCOUNT, agentSecret, ATTACKER, false); // el agente firma sin chequear
  const v = await facilitator.verify(payload, req);
  log("atacante_facilitador_oficial_verify", { isValid: v.isValid, invalidReason: v.invalidReason }, v.isValid === false);
}
const fp = { accountId: ACCOUNT, agentSecret, feePayerSecret: env.PAYER_SECRET, asset: USDC };
const atk = await chain.forceTransferOnchain({ ...fp, payTo: ATTACKER, amount: PRICE });
log("atacante_directo_a_la_red", { status: atk.status, tx: atk.hash, contractError: atk.contractError?.raw, attributedTo: atk.contractError?.account },
  atk.status === "FAILED" && atk.contractError?.code === 10 && atk.contractError?.account === ACCOUNT);

// 6) controles con el mismo armado de tx
const ctl = await chain.forceTransferOnchain({ ...fp, payTo: MERCHANT, amount: PRICE });
log("control_comercio_directo_a_la_red", { status: ctl.status, tx: ctl.hash }, ctl.status === "SUCCESS");
const st = await chain.read(ACCOUNT, "spend_status");
log("spend_status", { spent: String(st.spent), effective_cap: String(st.effective_cap), remaining: String(st.remaining) }, BigInt(st.spent) === 2n * PRICE);
const over = await chain.forceTransferOnchain({ ...fp, payTo: MERCHANT, amount: BigInt(st.remaining) + 1n });
log("comercio_por_encima_del_tope", { status: over.status, tx: over.hash, contractError: over.contractError?.raw },
  over.status === "FAILED" && over.contractError?.code === 6 && over.contractError?.account === ACCOUNT);
const rv = await chain.invoke(owner, ACCOUNT, "revoke", []);
log("revoke", rv, rv.status === "SUCCESS");
const rvd = await chain.forceTransferOnchain({ ...fp, payTo: MERCHANT, amount: PRICE });
log("comercio_con_cuenta_revocada", { status: rvd.status, tx: rvd.hash, contractError: rvd.contractError?.raw },
  rvd.status === "FAILED" && rvd.contractError?.code === 1 && rvd.contractError?.account === ACCOUNT);
const agentRaw = Keypair.fromSecret(agentSecret).rawPublicKey();
const un = await chain.invoke(owner, ACCOUNT, "set_agent_key", [bytes32(agentRaw)]);
log("des_revocar", un, un.status === "SUCCESS");

const attackerBal = await chain.read(USDC, "balance", [addr(ATTACKER)]).catch((e) => `sin trustline (${String(e.message).slice(0, 80)})`);
log("saldo_atacante", { attacker: ATTACKER, balance: String(attackerBal) });

out.failures = failures;
writeFileSync(new URL("deploy/demo-payees.json", root), JSON.stringify({
  note: "Cuenta de prueba de la allowlist de destinos (contracts/scripts/smoke-payees.mjs). Solo IDs públicos.",
  account: ACCOUNT, agentId: R.agentId, agentPublic: R.agentPublic, wasm, payees: [MERCHANT], cap: CAP.toString(),
  agentSecretFile: `.secrets/demo-agent-${R.agentId}.json`, at: out.at,
}, null, 2) + "\n");
console.log("RESULT_JSON=" + JSON.stringify(out));
console.log(failures ? `SMOKE PAYEES: ${failures} FALLAS` : "SMOKE PAYEES OK");
process.exit(failures ? 1 : 0);
