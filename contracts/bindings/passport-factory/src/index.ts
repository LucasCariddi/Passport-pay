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
    contractId: "CDJKAFUYH6WE6OWLP3BPMUDLKHQTCENLZSKIMHBMH436F6DGSVJN26TJ",
  }
} as const


export const FactoryError = {
  /**
   * Ya hay una cuenta para ese agent_id.
   */
  1: {message:"AgentTaken"},
  /**
   * El validador rechazó la prueba (prueba inválida o error del verificador).
   */
  2: {message:"ProofRejected"},
  /**
   * `public_inputs` no tiene 4 elementos.
   */
  3: {message:"BadPublicInputs"},
  /**
   * `adopt`: el validador no tiene pasaporte para ese agent_id.
   */
  4: {message:"NoPassport"},
  /**
   * `cap < 0` o `period_ledgers == 0`.
   */
  5: {message:"InvalidConfig"},
  /**
   * El nullifier de la prueba ya se usó (la prueba ya se registró antes).
   */
  6: {message:"NullifierUsed"}
}


/**
 * Prueba Groth16 BN254, mismo layout que el validador:
 * `a`/`c` = x||y (32 B BE cada uno); `b` = x.c1||x.c0||y.c1||y.c0.
 */
export interface Groth16Proof {
  a: Buffer;
  b: Buffer;
  c: Buffer;
}


export interface FactoryConfig {
  account_wasm_hash: Buffer;
  admin: string;
  token: string;
  validator: string;
}



export interface Client {
  /**
   * Construct and simulate a bump transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cualquiera: extiende el TTL de la instancia y de los índices de `agent_id`
   * para que `is_account` no quede archivado.
   */
  bump: ({agent_id}: {agent_id: u256}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a adopt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: crea la cuenta para un pasaporte que ya estaba registrado en el
   * validador (sin prueba nueva). Exige `get_passport(agent_id)`.
   */
  adopt: ({owner, agent_key, agent_id, cap, period_ledgers}: {owner: string, agent_key: Buffer, agent_id: u256, cap: i128, period_ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  config: (options?: MethodOptions) => Promise<AssembledTransaction<FactoryConfig>>

  /**
   * Construct and simulate a agent_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  agent_of: ({account}: {account: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u256>>>

  /**
   * Construct and simulate a register transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dueño: registra el pasaporte (prueba ZK) y crea su cuenta en la misma tx.
   * Devuelve la dirección C de la cuenta. `cap` en unidades base del token.
   * 
   * Ojo: la prueba no está atada a `owner` (el circuito no lo incluye), así que
   * quien envíe primero una prueba válida se queda con la cuenta.
   */
  register: ({owner, agent_key, proof, public_inputs, cap, period_ledgers}: {owner: string, agent_key: Buffer, proof: Groth16Proof, public_inputs: Array<u256>, cap: i128, period_ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: transfiere la administración.
   */
  set_admin: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a account_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  account_of: ({agent_id}: {agent_id: u256}, options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a is_account transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * true solo para cuentas desplegadas por esta factory.
   */
  is_account: ({account}: {account: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a predict_account transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dirección que va a tener (o tiene) la cuenta de `agent_id`.
   */
  predict_account: ({agent_id}: {agent_id: u256}, options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_account_wasm transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: wasm de las cuentas NUEVAS (las existentes no cambian).
   */
  set_account_wasm: ({account_wasm_hash}: {account_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, validator, account_wasm_hash, token}: {admin: string, validator: string, account_wasm_hash: Buffer, token: string},
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
    return ContractClient.deploy({admin, validator, account_wasm_hash, token}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABQAAAAAAAAAAAAAACEFkbWluU2V0AAAAAQAAAAlhZG1pbl9zZXQAAAAAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAAg==",
        "AAAABAAAAAAAAAAAAAAADEZhY3RvcnlFcnJvcgAAAAYAAAAkWWEgaGF5IHVuYSBjdWVudGEgcGFyYSBlc2UgYWdlbnRfaWQuAAAACkFnZW50VGFrZW4AAAAAAAEAAABLRWwgdmFsaWRhZG9yIHJlY2hhesOzIGxhIHBydWViYSAocHJ1ZWJhIGludsOhbGlkYSBvIGVycm9yIGRlbCB2ZXJpZmljYWRvcikuAAAAAA1Qcm9vZlJlamVjdGVkAAAAAAAAAgAAACVgcHVibGljX2lucHV0c2Agbm8gdGllbmUgNCBlbGVtZW50b3MuAAAAAAAAD0JhZFB1YmxpY0lucHV0cwAAAAADAAAAO2BhZG9wdGA6IGVsIHZhbGlkYWRvciBubyB0aWVuZSBwYXNhcG9ydGUgcGFyYSBlc2UgYWdlbnRfaWQuAAAAAApOb1Bhc3Nwb3J0AAAAAAAEAAAAImBjYXAgPCAwYCBvIGBwZXJpb2RfbGVkZ2VycyA9PSAwYC4AAAAAAA1JbnZhbGlkQ29uZmlnAAAAAAAABQAAAEdFbCBudWxsaWZpZXIgZGUgbGEgcHJ1ZWJhIHlhIHNlIHVzw7MgKGxhIHBydWViYSB5YSBzZSByZWdpc3Ryw7MgYW50ZXMpLgAAAAANTnVsbGlmaWVyVXNlZAAAAAAAAAY=",
        "AAAAAQAAAHVQcnVlYmEgR3JvdGgxNiBCTjI1NCwgbWlzbW8gbGF5b3V0IHF1ZSBlbCB2YWxpZGFkb3I6CmBhYC9gY2AgPSB4fHx5ICgzMiBCIEJFIGNhZGEgdW5vKTsgYGJgID0geC5jMXx8eC5jMHx8eS5jMXx8eS5jMC4AAAAAAAAAAAAADEdyb3RoMTZQcm9vZgAAAAMAAAAAAAAAAWEAAAAAAAPuAAAAQAAAAAAAAAABYgAAAAAAA+4AAACAAAAAAAAAAAFjAAAAAAAD7gAAAEA=",
        "AAAAAAAAAHVDdWFscXVpZXJhOiBleHRpZW5kZSBlbCBUVEwgZGUgbGEgaW5zdGFuY2lhIHkgZGUgbG9zIMOtbmRpY2VzIGRlIGBhZ2VudF9pZGAKcGFyYSBxdWUgYGlzX2FjY291bnRgIG5vIHF1ZWRlIGFyY2hpdmFkby4AAAAAAAAEYnVtcAAAAAEAAAAAAAAACGFnZW50X2lkAAAADAAAAAA=",
        "AAAAAQAAAAAAAAAAAAAADUZhY3RvcnlDb25maWcAAAAAAAAEAAAAAAAAABFhY2NvdW50X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAJdmFsaWRhdG9yAAAAAAAAEw==",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAIRBZG1pbjogY3JlYSBsYSBjdWVudGEgcGFyYSB1biBwYXNhcG9ydGUgcXVlIHlhIGVzdGFiYSByZWdpc3RyYWRvIGVuIGVsCnZhbGlkYWRvciAoc2luIHBydWViYSBudWV2YSkuIEV4aWdlIGBnZXRfcGFzc3BvcnQoYWdlbnRfaWQpYC4AAAAFYWRvcHQAAAAAAAAFAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAACWFnZW50X2tleQAAAAAAA+4AAAAgAAAAAAAAAAhhZ2VudF9pZAAAAAwAAAAAAAAAA2NhcAAAAAALAAAAAAAAAA5wZXJpb2RfbGVkZ2VycwAAAAAABAAAAAEAAAPpAAAAEwAAB9AAAAAMRmFjdG9yeUVycm9y",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAAAAAAAAQAAB9AAAAANRmFjdG9yeUNvbmZpZwAAAA==",
        "AAAABQAAAIRTZSBlbWl0ZSBhbCBjcmVhciB1bmEgY3VlbnRhIChwb3IgYHJlZ2lzdGVyYCBvIGBhZG9wdGApLiBgb3duZXJgIHZhIGNvbW8gdG9waWMKcGFyYSBxdWUgbGEgd2ViIGZpbHRyZSAibWlzIGN1ZW50YXMiIGNvbiBgZ2V0RXZlbnRzYC4AAAAAAAAADkFjY291bnRDcmVhdGVkAAAAAAABAAAAD2FjY291bnRfY3JlYXRlZAAAAAAEAAAAAAAAAAVvd25lcgAAAAAAABMAAAABAAAAAAAAAAhhZ2VudF9pZAAAAAwAAAAAAAAAAAAAAAdhY2NvdW50AAAAABMAAAAAAAAAAAAAAAdhZG9wdGVkAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADkFjY291bnRXYXNtU2V0AAAAAAABAAAAEGFjY291bnRfd2FzbV9zZXQAAAABAAAAAAAAABFhY2NvdW50X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAAAAAAAAAAAAAIYWdlbnRfb2YAAAABAAAAAAAAAAdhY2NvdW50AAAAABMAAAABAAAD6AAAAAw=",
        "AAAAAAAAASJEdWXDsW86IHJlZ2lzdHJhIGVsIHBhc2Fwb3J0ZSAocHJ1ZWJhIFpLKSB5IGNyZWEgc3UgY3VlbnRhIGVuIGxhIG1pc21hIHR4LgpEZXZ1ZWx2ZSBsYSBkaXJlY2Npw7NuIEMgZGUgbGEgY3VlbnRhLiBgY2FwYCBlbiB1bmlkYWRlcyBiYXNlIGRlbCB0b2tlbi4KCk9qbzogbGEgcHJ1ZWJhIG5vIGVzdMOhIGF0YWRhIGEgYG93bmVyYCAoZWwgY2lyY3VpdG8gbm8gbG8gaW5jbHV5ZSksIGFzw60gcXVlCnF1aWVuIGVudsOtZSBwcmltZXJvIHVuYSBwcnVlYmEgdsOhbGlkYSBzZSBxdWVkYSBjb24gbGEgY3VlbnRhLgAAAAAACHJlZ2lzdGVyAAAABgAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAlhZ2VudF9rZXkAAAAAAAPuAAAAIAAAAAAAAAAFcHJvb2YAAAAAAAfQAAAADEdyb3RoMTZQcm9vZgAAAAAAAAANcHVibGljX2lucHV0cwAAAAAAA+oAAAAMAAAAAAAAAANjYXAAAAAACwAAAAAAAAAOcGVyaW9kX2xlZGdlcnMAAAAAAAQAAAABAAAD6QAAABMAAAfQAAAADEZhY3RvcnlFcnJvcg==",
        "AAAAAAAAACVBZG1pbjogdHJhbnNmaWVyZSBsYSBhZG1pbmlzdHJhY2nDs24uAAAAAAAACXNldF9hZG1pbgAAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAAKYWNjb3VudF9vZgAAAAAAAQAAAAAAAAAIYWdlbnRfaWQAAAAMAAAAAQAAA+gAAAAT",
        "AAAAAAAAADR0cnVlIHNvbG8gcGFyYSBjdWVudGFzIGRlc3BsZWdhZGFzIHBvciBlc3RhIGZhY3RvcnkuAAAACmlzX2FjY291bnQAAAAAAAEAAAAAAAAAB2FjY291bnQAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAJdmFsaWRhdG9yAAAAAAAAEwAAAAAAAAARYWNjb3VudF93YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAA==",
        "AAAAAAAAADxEaXJlY2Npw7NuIHF1ZSB2YSBhIHRlbmVyIChvIHRpZW5lKSBsYSBjdWVudGEgZGUgYGFnZW50X2lkYC4AAAAPcHJlZGljdF9hY2NvdW50AAAAAAEAAAAAAAAACGFnZW50X2lkAAAADAAAAAEAAAAT",
        "AAAAAAAAAD5BZG1pbjogd2FzbSBkZSBsYXMgY3VlbnRhcyBOVUVWQVMgKGxhcyBleGlzdGVudGVzIG5vIGNhbWJpYW4pLgAAAAAAEHNldF9hY2NvdW50X3dhc20AAAABAAAAAAAAABFhY2NvdW50X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAA==" ]),
      options
    )
  }
  public readonly fromJSON = {
    bump: this.txFromJSON<null>,
        admin: this.txFromJSON<string>,
        adopt: this.txFromJSON<Result<string>>,
        config: this.txFromJSON<FactoryConfig>,
        agent_of: this.txFromJSON<Option<u256>>,
        register: this.txFromJSON<Result<string>>,
        set_admin: this.txFromJSON<null>,
        account_of: this.txFromJSON<Option<string>>,
        is_account: this.txFromJSON<boolean>,
        predict_account: this.txFromJSON<string>,
        set_account_wasm: this.txFromJSON<null>
  }
}