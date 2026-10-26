/**
 * Client-side Groth16 proving for the Agent Passport circuit.
 *
 * Everything here runs where the secrets live — the user's browser or device.
 * `privateKey` and `balance` never leave; only the proof + public inputs do.
 * Works in Node (artifact = filesystem path) and the browser (artifact = URL
 * or `Uint8Array`), since that's exactly what snarkjs accepts.
 */
import * as snarkjs from "snarkjs";
import type { Groth16Proof } from "../bindings/src/index.js";

/** A snarkjs artifact: a path (Node), a URL (browser), or raw bytes. */
export type Artifact = string | Uint8Array;

export interface PassportArtifacts {
  /** Compiled circuit witness generator: `agent_passport_js/agent_passport.wasm`. */
  wasm: Artifact;
  /** Proving key: `agent_passport_final.zkey`. */
  zkey: Artifact;
  /** Optional helper circuit to derive registryRoot + nullifierHash from secrets. */
  witnessWasm?: Artifact;
  /** Optional verification key for an off-chain sanity check before submitting. */
  vk?: object;
}

/** The four public inputs, in the exact order the circuit (and contract) expect. */
export interface PublicInputs {
  registryRoot: string;
  nullifierHash: string;
  agentId: string;
  spendCap: string;
}

/** Private + public witness for `agent_passport.circom`. All values are decimal strings. */
export interface PassportWitness extends PublicInputs {
  privateKey: string;
  balance: string;
  pathElements: string[];
  pathIndices: string;
}

/** A proof packaged for the AgentPassportValidator contract. */
export interface SorobanProof {
  /** Ready for the typed contract client (`Groth16Proof`). */
  proof: Groth16Proof;
  /** Hex form (no `0x`) — handy for `stellar contract invoke` / debugging. */
  proofHex: { a: string; b: string; c: string };
  /** `[registryRoot, nullifierHash, agentId, spendCap]` as decimal strings. */
  publicInputs: string[];
  /** Raw snarkjs outputs, in case you want to re-verify off-chain. */
  raw: { proof: snarkjs.Groth16Proof; publicSignals: string[] };
}

const FIELD_HEX = 64; // 32-byte BE field element.

const be32 = (dec: string | bigint): string => {
  const h = BigInt(dec).toString(16);
  if (h.length > FIELD_HEX) throw new Error(`field element overflow: ${dec}`);
  return h.padStart(FIELD_HEX, "0");
};

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

// Soroban byte layout: G1 (64B) = x||y; G2 (128B) = x.c1||x.c0||y.c1||y.c0.
const g1Hex = (p: string[]): string => be32(p[0]) + be32(p[1]);
const g2Hex = (p: string[][]): string =>
  be32(p[0][1]) + be32(p[0][0]) + be32(p[1][1]) + be32(p[1][0]);

/**
 * Convert a snarkjs proof into the AgentPassportValidator's argument format.
 * Pure / synchronous — no proving, just re-encoding.
 */
export function toSorobanProof(
  proof: snarkjs.Groth16Proof,
  publicSignals: string[],
): SorobanProof {
  const a = g1Hex(proof.pi_a);
  const b = g2Hex(proof.pi_b);
  const c = g1Hex(proof.pi_c);
  return {
    proof: {
      a: Buffer.from(hexToBytes(a)),
      b: Buffer.from(hexToBytes(b)),
      c: Buffer.from(hexToBytes(c)),
    },
    proofHex: { a, b, c },
    publicInputs: publicSignals.map(String),
    raw: { proof, publicSignals },
  };
}

/**
 * Derive `registryRoot` + `nullifierHash` from the private witness using the
 * helper circuit, so callers don't have to reimplement Poseidon2 off-circuit.
 * Requires `artifacts.witnessWasm`.
 */
export async function derivePublicInputs(
  secret: { privateKey: string; agentId: string; pathElements: string[]; pathIndices: string },
  witnessWasm: Artifact,
): Promise<{ registryRoot: string; nullifierHash: string }> {
  const { type, data } = await snarkjs.wtns.calculate(secret, witnessWasm as any, undefined as any);
  const w = await snarkjs.wtns.exportJson({ type, data } as any);
  return { registryRoot: w[1].toString(), nullifierHash: w[2].toString() };
}

/**
 * Generate a passport proof from a full witness and package it for Soroban.
 * If `artifacts.vk` is supplied, the proof is sanity-checked off-chain first.
 */
export async function generatePassportProof(
  witness: PassportWitness,
  artifacts: PassportArtifacts,
): Promise<SorobanProof> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness,
    artifacts.wasm as any,
    artifacts.zkey as any,
  );

  if (artifacts.vk) {
    const ok = await snarkjs.groth16.verify(artifacts.vk, publicSignals, proof);
    if (!ok) throw new Error("off-chain verification failed — refusing to submit");
  }

  return toSorobanProof(proof, publicSignals);
}
