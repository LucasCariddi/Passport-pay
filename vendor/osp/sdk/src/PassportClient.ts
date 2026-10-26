import { Client, type VerifyInput, type VerifyResult, type Groth16Proof, networks } from "../bindings/src/index.js";

/**
 * Errors surfaced by the PassportValidator contract.
 */
export enum PassportError {
  NotInitialized = "NotInitialized",
  AlreadyInitialized = "AlreadyInitialized",
  BadPublicInputs = "BadPublicInputs",
  NullifierUsed = "NullifierUsed",
  InvalidProof = "InvalidProof",
  BatchTooLarge = "BatchTooLarge",
  UnknownRegistryRoot = "UnknownRegistryRoot",
  RateLimitExceeded = "RateLimitExceeded",
  Unknown = "Unknown",
}

export type VerifyCredentialInput = {
  /** registry root, 32 bytes */
  root: Buffer;
  /** Groth16 proof bytes (implementation-specific packing) */
  proof: Buffer;
  /** circuit public inputs (as field elements) */
  publicInputs: bigint[];
  /** optional unix timestamp */
  expiryDateUnix?: number;
};

export type VerifyBatchInput = VerifyInput;

export type VerifyBatchResult = VerifyResult & {
  /** mapped error */
  error?: PassportError;
};

const mapSymbolToPassportError = (err: unknown): PassportError | undefined => {
  if (typeof err !== "string") return undefined;
  switch (err) {
    case "NotInitialized":
      return PassportError.NotInitialized;
    case "AlreadyInitialized":
      return PassportError.AlreadyInitialized;
    case "BadPublicInputs":
      return PassportError.BadPublicInputs;
    case "NullifierUsed":
      return PassportError.NullifierUsed;
    case "InvalidProof":
      return PassportError.InvalidProof;
    case "BatchTooLarge":
      return PassportError.BatchTooLarge;
    case "UnknownRegistryRoot":
      return PassportError.UnknownRegistryRoot;
    case "RateLimitExceeded":
      return PassportError.RateLimitExceeded;
    default:
      return PassportError.Unknown;
  }
};

/**
 * Typed client for the Agent Passport validator contract.
 *
 * This SDK currently implements the required functionality using the
 * generated typed contract bindings under `sdk/bindings`.
 */
export class PassportClient {
  private readonly typed: Client;

  /**
   * @param rpc - Soroban RPC server instance (not directly used; kept for API parity)
   * @param contractId - validator contract ID
   */
  constructor(rpc: unknown, contractId: string) {
    this.typed = new Client({
      contractId,
      networkPassphrase: networks.testnet.networkPassphrase,
      rpcUrl: (rpc as any)?.rpcUrl ?? "",
    });
  }

  /**
   * Verify a single credential proof.
   *
   * Note: the contract interface exposes `verify_batch`; this method submits
   * a single-element batch and returns the first result.
   *
   * @param input - proof + public inputs.
   * @returns typed result indicating success and optional error.
   */
  async verifyCredential(
    input: VerifyCredentialInput,
  ): Promise<{ success: boolean; error?: string }> {
    const proofs: VerifyInput[] = [
      {
        proof: input.proof as unknown as Groth16Proof,
        public_inputs: input.publicInputs.map((x) => BigInt(x)),
      },
    ];

    const tx = await this.typed.verify_batch({ proofs });
    const { result } = await tx.signAndSend();
    const arr = (result.unwrap?.() ?? result) as VerifyResult[];

    const r0 = arr[0];
    if (!r0?.success) return { success: false, error: r0?.error ?? undefined };
    return { success: true };
  }

  /**
   * Verify multiple proofs.
   *
   * Automatically splits into chunks of 8 to respect the contract's batch
   * limit.
   */
  async verifyBatch(inputs: VerifyBatchInput[]): Promise<VerifyBatchResult[]> {
    const BATCH_LIMIT = 8;
    const out: VerifyBatchResult[] = [];

    for (let i = 0; i < inputs.length; i += BATCH_LIMIT) {
      const chunk = inputs.slice(i, i + BATCH_LIMIT);
      const tx = await this.typed.verify_batch({ proofs: chunk });
      const { result } = await tx.signAndSend();
      const resArr = (result.unwrap?.() ?? result) as VerifyResult[];

      for (const r of resArr) {
        out.push({
          ...r,
          error: r.success ? undefined : mapSymbolToPassportError(r.error),
        });
      }
    }

    return out;
  }

  /**
   * Check whether a registry root has been revoked.
   *
   * The contract does not expose a dedicated `is_revoked` read method; this
   * scans the audit log entries for a matching `revoke` action.
   */
  async isRevoked(root: Buffer): Promise<boolean> {
    const count = await this.typed.audit_count();
    const total = count.result ?? count;

    for (let i = 0n; i < total; i++) {
      const tx = await this.typed.get_audit_entry({ seq: i });
      const rec = tx.result ?? undefined;
      if (!rec) continue;
      if (rec.action === "revoke" && Buffer.isBuffer(rec.root) && rec.root.equals(root)) {
        return true;
      }
    }

    return false;
  }
}
