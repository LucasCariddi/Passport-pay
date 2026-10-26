import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDNSZUNEWFCGSPWLPDSWTENR2WPHKC34RGZQG7RJA54OPGTZGVVRFYBA",
  }
} as const

export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"AlreadyInitialized"},
  /**
   * Wrong number of public inputs for the agent_passport circuit.
   */
  3: {message:"BadPublicInputs"},
  /**
   * This nullifier was already spent — replay / Sybil attempt.
   */
  4: {message:"NullifierUsed"},
  /**
   * The Groth16 proof did not verify against the embedded key.
   */
  5: {message:"InvalidProof"},
  6: {message:"BatchTooLarge"},
  7: {message:"UnknownRegistryRoot"}
}


export interface Attestation {
  agent_id: u256;
  /**
 * Ledger sequence at which the passport was minted.
 */
ledger: u32;
  nullifier: u256;
  registry_root: u256;
  spend_cap: u256;
}

export interface AuditRecord {
  action: string;
  actor: string;
  ledger: u32;
  root: Buffer;
  success: boolean;
}


/**
 * Groth16 proof over BN254, re-declared in *this* contract's spec (the
 * imported one isn't exported) so SDKs/CLI can build the argument directly.
 * Byte layout: G1 `a`/`c` = x||y (32B BE each); G2 `b` = x.c1||x.c0||y.c1||y.c0.
 */
export interface Groth16Proof {
  a: Buffer;
  b: Buffer;
  c: Buffer;
}

export interface VerifyInput {
  proof: Groth16Proof;
  public_inputs: Array<u256>;
}

export interface VerifyResult {
  error: Option<string>;
  root: u256;
  success: boolean;
}

export interface Client {
  /**
   * Construct and simulate a init transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One-time wiring: who can re-point the verifier, and the verifier's
   * contract address. Panics on a second call.
   */
  init: ({admin, verifier}: {admin: string, verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The verifier contract this validator delegates proof-checking to.
   */
  verifier: (options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a get_passport transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch the stored attestation for an agent, if any.
   */
  get_passport: ({agent_id}: {agent_id: u256}, options?: MethodOptions) => Promise<AssembledTransaction<Option<Attestation>>>

  /**
   * Construct and simulate a set_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only: re-point to a new verifier (e.g. after a circuit upgrade).
   */
  set_verifier: ({verifier}: {verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_registered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * True iff `agent_id` holds a minted zk-passport.
   */
  is_registered: ({agent_id}: {agent_id: u256}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_nullifier_used transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * True iff this nullifier has already been spent.
   */
  is_nullifier_used: ({nullifier}: {nullifier: u256}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a verify_and_register transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Verify a passport proof and, if sound and unspent, mint the attestation.
   * 
   * This is the load-bearing entry point: the proof *is* the authorization,
   * so no `require_auth` is needed — anyone relaying a valid, fresh proof
   * registers the agent. Returns the freshly stored [`Attestation`].
   */
  verify_and_register: ({proof, public_inputs}: {proof: Groth16Proof, public_inputs: Array<u256>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Attestation>>>

  /**
   * Construct and simulate a verify_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Verify multiple proofs in a single call.
   *
   * Returns results for all proofs; doesn't short-circuit on first failure.
   * Each proof is validated independently. Max batch size is 8.
   */
  verify_batch: ({proofs}: {proofs: Array<VerifyInput>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<VerifyResult>>>>

  /**
   * Construct and simulate a add_registry_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only: add a new trusted registry root to the allow-list.
   */
  add_registry_root: ({root}: {root: u256}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a remove_registry_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only: remove a registry root from the allow-list.
   */
  remove_registry_root: ({root}: {root: u256}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only: Propose a new admin.
   */
  transfer_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The proposed admin accepts the role.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a renounce_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only: Renounce the admin role.
   */
  renounce_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_registry_root_approved transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * True iff `root` is in the approved allow-list.
   */
  is_registry_root_approved: ({root}: {root: u256}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a bump_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Explicitly bump the TTL of the contract instance.
   */
  bump_ttl: (options?: MethodOptions) => Promise<AssembledTransaction<void>>

  /**
   * Construct and simulate a issue_credential transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  issue_credential: ({actor, root}: {actor: string, root: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a verify_credential transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  verify_credential: ({actor, root, success}: {actor: string, root: Buffer, success: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a revoke_credential transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  revoke_credential: ({actor, root}: {actor: string, root: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_audit_entry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_audit_entry: ({seq}: {seq: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<AuditRecord>>>

  /**
   * Construct and simulate a audit_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  audit_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABgAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAAEkFscmVhZHlJbml0aWFsaXplZAAAAAAAAgAAAD1Xcm9uZyBudW1iZXIgb2YgcHVibGljIGlucHV0cyBmb3IgdGhlIGFnZW50X3Bhc3Nwb3J0IGNpcmN1aXQuAAAAAAAAD0JhZFB1YmxpY0lucHV0cwAAAAADAAAAPFRoaXMgbnVsbGlmaWVyIHdhcyBhbHJlYWR5IHNwZW50IOKAlCByZXBsYXkgLyBTeWJpbCBhdHRlbXB0LgAAAA1OdWxsaWZpZXJVc2VkAAAAAAAABAAAADpUaGUgR3JvdGgxNiBwcm9vZiBkaWQgbm90IHZlcmlmeSBhZ2FpbnN0IHRoZSBlbWJlZGRlZCBrZXkuAAAAAAAMSW52YWxpZFByb29mAAAABQAAAB1CYXRjaCBzaXplIGV4Y2VlZHMgdGhlIGxpbWl0IG9mIDguAAAAAAANQmF0Y2hUb29MYXJnZSAAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAAC0F0dGVzdGF0aW9uAAAAAAUAAAAAAAAACGFnZW50X2lkAAAADAAAADFMZWRnZXIgc2VxdWVuY2UgYXQgd2hpY2ggdGhlIHBhc3Nwb3J0IHdhcyBtaW50ZWQuAAAAAAAABmxlZGdlcgAAAAAABAAAAAAAAAAJbnVsbGlmaWVyAAAAAAAADAAAAAAAAAANcmVnaXN0cnlfcm9vdAAAAAAAAAwAAAAAAAAACXNwZW5kX2NhcAAAAAAAAAw=",
        "AAAAAQAAAN1Hcm90aDE2IHByb29mIG92ZXIgQk4yNTQsIHJlLWRlY2xhcmVkIGluICp0aGlzKiBjb250cmFjdCdzIHNwZWMgKHRoZQppbXBvcnRlZCBvbmUgaXNuJ3QgZXhwb3J0ZWQpIHNvIFNES3MvQ0xJIGNhbiBidWlsZCB0aGUgYXJndW1lbnQgZGlyZWN0bHkuCkJ5dGUgbGF5b3V0OiBHMSBgYWAvYGNgID0geHx8eSAoMzJCIEJFIGVhY2gpOyBHMiBgYmAgPSB4LmMxfHx4LmMwfHx5LmMxfHx5LmMwLgAAAAAAAAAAAAAMR3JvdGgxNlByb29mAAAAAwAAAAAAAAABYQAAAAAAA+4AAABAAAAAAAAAAAFiAAAAAAAD7gAAAIAAAAAAAAAAAWMAAAAAAAPuAAAAQA==",
        "AAAAAQAAAAAAAAAAAAAAB1ZlcmlmeUlucHV0AAAAAAIAAAAAAAAABXByb29mAAAAAAAH0AAAAAxHcm90aDE2UHJvb2YAAAAAAAAADXB1YmxpY19pbnB1dHMAAAAAAAPqAAAADAAAAAEAAAPp",
        "AAAAAQAAAAAAAAAAAAAABFZlcmlmeVJlc3VsdAAAAAMAAAAAAAAABWVycm9yAAAAAAAD6QAAAAEAAAPpAAAABAAAAAAAAAAEcrootAAAAAAAAAwAAAAAAAAAB3N1Y2Nlc3MAAAAAAAE=",
        "AAAAAAAAAG1PbmUtdGltZSB3aXJpbmc6IHdobyBjYW4gcmUtcG9pbnQgdGhlIHZlcmlmaWVyLCBhbmQgdGhlIHZlcmlmaWVyJ3MKY29udHJhY3QgYWRkcmVzcy4gUGFuaWNzIG9uIGEgc2Vjb25kIGNhbGwuAAAAAAAABGluaXQAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAACHZlcmlmaWVyAAAAEwAAAAA=",
        "AAAAAAAAAEFUaGUgdmVyaWZpZXIgY29udHJhY3QgdGhpcyB2YWxpZGF0b3IgZGVsZWdhdGVzIHByb29mLWNoZWNraW5nIHRvLgAAAAAAAAh2ZXJpZmllcgAAAAAAAAABAAAD6QAAABMAAAAD",
        "AAAAAAAAADJGZXRjaCB0aGUgc3RvcmVkIGF0dGVzdGF0aW9uIGZvciBhbiBhZ2VudCwgaWYgYW55LgAAAAAADGdldF9wYXNzcG9ydAAAAAEAAAAAAAAACGFnZW50X2lkAAAADAAAAAEAAAPoAAAH0AAAAAtBdHRlc3RhdGlvbgA=",
        "AAAAAAAAAEZBZG1pbi1vbmx5OiByZS1wb2ludCB0byBhIG5ldyB2ZXJpZmllciAoZS5nLiBhZnRlciBhIGNpcmN1aXQgdXBncmFkZSkuAAAAAAAMc2V0X3ZlcmlmaWVyAAAAAQAAAAAAAAAIdmVyaWZpZXIAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAC9UcnVlIGlmZiBgYWdlbnRfaWRgIGhvbGRzIGEgbWludGVkIHprLXBhc3Nwb3J0LgAAAAANaXNfcmVnaXN0ZXJlZAAAAAAAAAEAAAAAAAAACGFnZW50X2lkAAAADAAAAAEAAAAB",
        "AAAAAAAAAC9UcnVlIGlmZiB0aGlzIG51bGxpZmllciBoYXMgYWxyZWFkeSBiZWVuIHNwZW50LgAAAAARaXNfbnVsbGlmaWVyX3VzZWQAAAAAAAABAAAAAAAAAAludWxsaWZpZXIAAAAAAAAMAAAAAQAAAAE=",
        "AAAAAAAAARpWZXJpZnkgYSBwYXNzcG9ydCBwcm9vZiBhbmQsIGlmIHNvdW5kIGFuZCB1bnNwZW50LCBtaW50IHRoZSBhdHRlc3RhdGlvbi4KClRoaXMgaXMgdGhlIGxvYWQtYmVhcmluZyBlbnRyeSBwb2ludDogdGhlIHByb29mICppcyogdGhlIGF1dGhvcml6YXRpb24sCnNvIG5vIGByZXF1aXJlX2F1dGhgIGlzIG5lZWRlZCDigJQgYW55b25lIHJlbGF5aW5nIGEgdmFsaWQsIGZyZXNoIHByb29mCnJlZ2lzdGVycyB0aGUgYWdlbnQuIFJldHVybnMgdGhlIGZyZXNobHkgc3RvcmVkIFtgQXR0ZXN0YXRpb25gXS4AAAAAABN2ZXJpZnlfYW5kX3JlZ2lzdGVyAAAAAAIAAAAAAAAABXByb29mAAAAAAAH0AAAAAxHcm90aDE2UHJvb2YAAAAAAAAADXB1YmxpY19pbnB1dHMAAAAAAAPqAAAADAAAAAEAAAPpAAAH0AAAAAtBdHRlc3RhdGlvbgAAAAAD",
        "AAAAAAAAALhWZXJpZnkgbXVsdGlwbGUgcHJvb2ZzIGluIGEgc2luZ2xlIGNhbGwuCgpSZXR1cm5zIHJlc3VsdHMgZm9yIGFsbCBwcm9vZnM7IGRvZXNuJ3Qgc2hvcnQtY2lyY3VpdCBvbiBmaXJzdCBmYWlsdXJlLgpFYWNoIHByb29mIGlzIHZhbGlkYXRlZCBpbmRlcGVuZGVudGx5LiBNYXggYmF0Y2ggc2l6ZSBpcyA4LgAAAAAAAAAMdmVyaWZ5X2JhdGNoAAAAAQAAAAAAAAAGcHJvb2ZzAAAAAAAD6gAAB9AAAAAHVmVyaWZ5SW5wdXQAAAABAAAD6QAAB9AAAAAFAAAA7HZlcmlmeVJlc3VsdAAAAAA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    init: this.txFromJSON<null>,
        verifier: this.txFromJSON<Result<string>>,
        get_passport: this.txFromJSON<Option<Attestation>>,
        set_verifier: this.txFromJSON<Result<void>>,
        is_registered: this.txFromJSON<boolean>,
        is_nullifier_used: this.txFromJSON<boolean>,
        verify_and_register: this.txFromJSON<Result<Attestation>>,
        verify_batch: this.txFromJSON<Result<Array<VerifyResult>>>,
        add_registry_root: this.txFromJSON<Result<void>>,
        remove_registry_root: this.txFromJSON<Result<void>>,
        transfer_admin: this.txFromJSON<Result<void>>,
        accept_admin: this.txFromJSON<Result<void>>,
        renounce_admin: this.txFromJSON<Result<void>>,
        is_registry_root_approved: this.txFromJSON<boolean>,
        bump_ttl: this.txFromJSON<void>,
        issue_credential: this.txFromJSON<Result<void>>,
        verify_credential: this.txFromJSON<Result<boolean>>,
        revoke_credential: this.txFromJSON<Result<void>>,
        get_audit_entry: this.txFromJSON<Option<AuditRecord>>,
        audit_count: this.txFromJSON<u64>
  }
}