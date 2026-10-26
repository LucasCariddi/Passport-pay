/** Minimal ambient types for the snarkjs surface this SDK uses. */
declare module "snarkjs" {
  /** A Groth16 proof in snarkjs' projective-coordinate JSON form. */
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  type Artifact = string | Uint8Array;

  export const groth16: {
    fullProve(
      input: object,
      wasm: Artifact,
      zkey: Artifact,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vk: object, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };

  export const wtns: {
    calculate(input: object, wasm: Artifact, output?: unknown): Promise<any>;
    exportJson(wtns: unknown): Promise<bigint[]>;
  };
}
