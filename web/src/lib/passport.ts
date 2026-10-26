// Pasaporte ZK del agente: prueba Groth16 en el navegador (librería previa
// open-stellar-passport, vendor/osp) y alta onchain firmada por el dueño.
import * as snarkjs from "snarkjs";
import { StrKey } from "@stellar/stellar-sdk";
import { generatePassportProof, type SorobanProof } from "../../../vendor/osp/sdk/src/prover";
import { CONFIG } from "./config";
import { addr, bytes, i128, invoke, read, struct, u256, u32, vec, type Phase, type Signer } from "./soroban";

const BASE = import.meta.env.BASE_URL;
export const ZK = {
  circuit: `${BASE}zk/agent_passport.wasm`,
  zkey: `${BASE}zk/agent_passport_final.zkey`,
  witness: `${BASE}zk/passport_witness.wasm`,
  vk: `${BASE}zk/verification_key.json`,
};

export interface Attestation {
  agent_id: bigint;
  ledger: number;
  nullifier: bigint;
  registry_root: bigint;
  spend_cap: bigint;
}

export interface BrowserProof extends SorobanProof {
  agentId: string;
  spendCap: string;
  provingMs: number;
  offChainValid: boolean;
}

const randomField = (nBytes: number) =>
  BigInt(
    "0x" + [...crypto.getRandomValues(new Uint8Array(nBytes))].map((b) => b.toString(16).padStart(2, "0")).join(""),
  ).toString();

const fetchBytes = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not download ${url} (HTTP ${r.status}). Reload the page and try again.`);
  return new Uint8Array(await r.arrayBuffer());
};

/**
 * Deriva registryRoot y nullifierHash con el circuito auxiliar de OSP.
 * No usamos `derivePublicInputs` de vendor/osp/sdk/src/prover.ts porque con
 * snarkjs 0.7.6 `wtns.calculate` no devuelve el testigo: lo escribe en el
 * tercer argumento, y el prover le pasa `undefined`. Acá le pasamos un
 * destino en memoria, igual que el frontend de OSP.
 */
async function derivePublic(secret: {
  privateKey: string;
  agentId: string;
  pathElements: string[];
  pathIndices: string;
}): Promise<{ registryRoot: string; nullifierHash: string }> {
  const out = { type: "mem" } as object;
  await snarkjs.wtns.calculate(secret, await fetchBytes(ZK.witness), out);
  const w = await snarkjs.wtns.exportJson(out);
  return { registryRoot: w[1].toString(), nullifierHash: w[2].toString() };
}

/**
 * Genera un pasaporte nuevo en el navegador. El secreto del dueño
 * (privateKey) y su saldo nunca salen de acá: solo viajan la prueba y las
 * cuatro entradas públicas. El validador desplegado no tiene lista de raíces
 * aprobadas (ver ARCHITECTURE.md 4.3), así que el registro es un árbol propio
 * de una sola hoja.
 */
export async function proveInBrowser(spendCapBase: bigint, onStep?: (s: string) => void): Promise<BrowserProof> {
  const privateKey = randomField(28);
  const agentId = randomField(5); // id corto y legible, sigue siendo un elemento del campo
  const spendCap = spendCapBase.toString();
  const balance = (spendCapBase + BigInt(randomField(4))).toString(); // >= tope, queda oculto
  const pathIndices = "0";
  const pathElements = Array.from({ length: 20 }, () => randomField(28));

  onStep?.("Computing the identity commitment");
  const { registryRoot, nullifierHash } = await derivePublic({ privateKey, agentId, pathElements, pathIndices });

  onStep?.("Downloading the proving key (4.4 MB)");
  const [wasm, zkey, vk] = await Promise.all([
    fetchBytes(ZK.circuit),
    fetchBytes(ZK.zkey),
    fetch(ZK.vk).then((r) => r.json()),
  ]);

  onStep?.("Generating the Groth16 proof");
  const t0 = performance.now();
  let proof: SorobanProof;
  try {
    proof = await generatePassportProof(
      { registryRoot, nullifierHash, agentId, spendCap, privateKey, balance, pathElements, pathIndices },
      { wasm, zkey, vk }, // con vk, el prover la verifica localmente antes de devolverla
    );
  } catch (e) {
    // The OSP prover (prior library, unmodified) throws terse messages: reword them here.
    const msg = String((e as Error)?.message ?? e);
    if (/off-chain verification failed/i.test(msg)) {
      throw new Error("The proof did not pass verification in your browser, so it is not sent to the network. Generate it again.");
    }
    throw new Error(`Could not generate the proof: ${msg}`);
  }
  const provingMs = Math.round(performance.now() - t0);
  return { ...proof, agentId, spendCap, provingMs, offChainValid: true };
}

const proofScVal = (p: SorobanProof) =>
  struct({ a: bytes(p.proof.a), b: bytes(p.proof.b), c: bytes(p.proof.c) });
const inputsScVal = (p: SorobanProof) => vec(p.publicInputs.map((s) => u256(s)));

export const VALIDATOR_ERRORS: Record<number, string> = {
  1: "The validator is not initialized",
  2: "The validator was already initialized",
  3: "Invalid public inputs",
  4: "That nullifier was already used: this proof already registered a passport",
  5: "The proof does not verify",
};
export const FACTORY_ERRORS: Record<number, string> = {
  1: "That agent already has an account",
  2: "The validator rejected the proof",
  3: "Invalid public inputs",
  4: "There is no passport for that agent",
  5: "Invalid configuration (cap or period)",
  6: "That nullifier was already used: this proof already registered a passport",
};

export interface RegisterResult {
  hash: string;
  ledger: number;
  account: string | null; // null si se registró directo en el validador
  via: "factory" | "validator";
}

/**
 * Alta onchain firmada por el dueño. Con PassportFactory desplegada llama
 * `register` (verifica la prueba y despliega la cuenta en la misma tx). Sin
 * factory, llama `verify_and_register` del validador: queda el pasaporte,
 * pero la cuenta que paga se crea después.
 */
export async function registerPassport(opts: {
  proof: SorobanProof;
  owner: string;
  agentKey: string; // G... de la clave del agente
  capBase: bigint;
  periodLedgers: number;
  sign: Signer;
  onPhase?: (p: Phase) => void;
}): Promise<RegisterResult> {
  const { proof, owner, sign, onPhase } = opts;
  if (CONFIG.factoryId) {
    const agentKey = StrKey.decodeEd25519PublicKey(opts.agentKey);
    const r = await invoke<string>({
      contractId: CONFIG.factoryId,
      method: "register",
      args: [addr(owner), bytes(agentKey), proofScVal(proof), inputsScVal(proof), i128(opts.capBase), u32(opts.periodLedgers)],
      source: owner,
      sign,
      onPhase,
    });
    return { hash: r.hash, ledger: r.ledger, account: String(r.value), via: "factory" };
  }
  const r = await invoke<Attestation>({
    contractId: CONFIG.validatorId,
    method: "verify_and_register",
    args: [proofScVal(proof), inputsScVal(proof)],
    source: owner,
    sign,
    onPhase,
  });
  return { hash: r.hash, ledger: r.ledger, account: null, via: "validator" };
}

export const getPassport = (agentId: bigint | string) =>
  read<Attestation | undefined>(CONFIG.validatorId, "get_passport", [u256(agentId)]);

export async function accountOf(agentId: bigint | string): Promise<string | null> {
  if (!CONFIG.factoryId) return null;
  const r = await read<string | undefined>(CONFIG.factoryId, "account_of", [u256(agentId)]);
  return r ? String(r) : null;
}
