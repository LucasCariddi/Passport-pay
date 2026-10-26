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





export interface Config {
  agent_id: u256;
  agent_key: Buffer;
  /**
 * Tope del dueño por período, en unidades base del token (7 decimales).
 */
cap: i128;
  /**
 * Nullifier del pasaporte vigente al crear la cuenta (lo fija el constructor).
 */
nullifier: u256;
  owner: string;
  /**
 * Largo del período en ledgers (~5 s por ledger; 17280 = ~1 día).
 */
period_ledgers: u32;
  revoked: boolean;
  token: string;
  validator: string;
}



export const AccError = {
  1: {message:"Revoked"},
  2: {message:"BadSignatureCount"},
  3: {message:"UnknownSigner"},
  4: {message:"NoPassport"},
  5: {message:"ContextNotAllowed"},
  6: {message:"CapExceeded"},
  7: {message:"BadAmount"},
  8: {message:"InvalidConfig"},
  /**
   * Ya no se devuelve (ver el comentario del módulo). Se deja para no correr los códigos.
   */
  9: {message:"PassportChanged"},
  /**
   * El destino del `transfer` no está en la lista de destinos permitidos del dueño.
   */
  10: {message:"PayeeNotAllowed"}
}



export interface SpendStatus {
  effective_cap: i128;
  period: u32;
  period_ends_ledger: u32;
  remaining: i128;
  spent: i128;
}



/**
 * Firma con el mismo formato que arma `authorizeEntry` de stellar-sdk
 * (`Vec<{public_key, signature}>`), así el tooling estándar la sabe serializar.
 */
export interface Ed25519Signature {
  public_key: Buffer;
  signature: Buffer;
}

/**
 * Contract executable used for creating a new contract and used in
 * `CreateContractHostFnContext`.
 */
export type ContractExecutable = {tag: "Wasm", values: readonly [Buffer]} | {tag: "ExternalRef", values: readonly [ContractExecutableRef]};


/**
 * Executable referenced via a persistent storage entry owned by a contract,
 * either this contract or another contract.
 * 
 * The persistent storage entry owned by the `owner` has the `tag` as its key.
 */
export interface ContractExecutableRef {
  owner: string;
  tag: string;
}

/**
 * Context of a single authorized call performed by an address.
 * 
 * Custom account contracts that implement `__check_auth` special function
 * receive a list of `Context` values corresponding to all the calls that
 * need to be authorized.
 */
export type Context = {tag: "Contract", values: readonly [ContractContext]} | {tag: "CreateContractHostFn", values: readonly [CreateContractHostFnContext]} | {tag: "CreateContractWithCtorHostFn", values: readonly [CreateContractWithConstructorHostFnContext]};


/**
 * Authorization context of a single contract call.
 * 
 * This struct corresponds to a `require_auth_for_args` call for an address
 * from `contract` function with `fn_name` name and `args` arguments.
 */
export interface ContractContext {
  args: Array<any>;
  contract: string;
  fn_name: string;
}


/**
 * Authorization context for `create_contract` host function that creates a
 * new contract on behalf of authorizer address.
 */
export interface CreateContractHostFnContext {
  executable: ContractExecutable;
  salt: Buffer;
}


/**
 * Authorization context for `create_contract` host function that creates a
 * new contract on behalf of authorizer address.
 * This is the same as `CreateContractHostFnContext`, but also has
 * contract constructor arguments.
 */
export interface CreateContractWithConstructorHostFnContext {
  constructor_args: Array<any>;
  executable: ContractExecutable;
  salt: Buffer;
}

export interface Client {
  /**
   * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  config: (options?: MethodOptions) => Promise<AssembledTransaction<Config>>

  /**
   * Construct and simulate a payees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Destinos a los que el agente puede pagar.
   */
  payees: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a revoke transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dueño: revoca la cuenta. Desde acá todo `transfer` del agente falla onchain.
   */
  revoke: (options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_cap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dueño: cambia tope y largo del período. Si cambia el largo, el acumulado
   * se reinterpreta con el nuevo número de período (normalmente arranca en 0).
   */
  set_cap: ({cap, period_ledgers}: {cap: i128, period_ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_payee transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_payee: ({to}: {to: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dueño: retira fondos de la cuenta. La cuenta se autoriza a sí misma
   * porque es el contrato invocador del `transfer` (no pasa por `__check_auth`).
   */
  withdraw: ({to, amount}: {to: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a add_payee transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dueño: agrega un destino permitido (si ya estaba, no cambia nada).
   */
  add_payee: ({payee}: {payee: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_payees transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dueño: reemplaza la lista de destinos permitidos (los repetidos se ignoran).
   * Lista vacía = el agente no puede pagar a nadie. Máximo `MAX_PAYEES`.
   */
  set_payees: ({payees}: {payees: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a remove_payee transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dueño: saca un destino de la lista (si no estaba, no cambia nada).
   */
  remove_payee: ({payee}: {payee: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a spend_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Gasto del período actual. Falla con NoPassport / PassportChanged igual que un pago.
   */
  spend_status: (options?: MethodOptions) => Promise<AssembledTransaction<Result<SpendStatus>>>

  /**
   * Construct and simulate a set_agent_key transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dueño: rota la clave del agente (y des-revoca).
   */
  set_agent_key: ({agent_key}: {agent_key: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {owner, agent_key, validator, agent_id, token, cap, period_ledgers}: {owner: string, agent_key: Buffer, validator: string, agent_id: u256, token: string, cap: i128, period_ledgers: u32},
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
    return ContractClient.deploy({owner, agent_key, validator, agent_id, token, cap, period_ledgers}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "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",
        "AAAAAQAAAJNGaXJtYSBjb24gZWwgbWlzbW8gZm9ybWF0byBxdWUgYXJtYSBgYXV0aG9yaXplRW50cnlgIGRlIHN0ZWxsYXItc2RrCihgVmVjPHtwdWJsaWNfa2V5LCBzaWduYXR1cmV9PmApLCBhc8OtIGVsIHRvb2xpbmcgZXN0w6FuZGFyIGxhIHNhYmUgc2VyaWFsaXphci4AAAAAAAAAABBFZDI1NTE5U2lnbmF0dXJlAAAAAgAAAAAAAAAKcHVibGljX2tleQAAAAAD7gAAACAAAAAAAAAACXNpZ25hdHVyZQAAAAAAA+4AAABA",
        "AAAAAAAAAAAAAAAIaXNfcGF5ZWUAAAABAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAJJEdWXDsW86IHJldGlyYSBmb25kb3MgZGUgbGEgY3VlbnRhLiBMYSBjdWVudGEgc2UgYXV0b3JpemEgYSBzw60gbWlzbWEKcG9ycXVlIGVzIGVsIGNvbnRyYXRvIGludm9jYWRvciBkZWwgYHRyYW5zZmVyYCAobm8gcGFzYSBwb3IgYF9fY2hlY2tfYXV0aGApLgAAAAAACHdpdGhkcmF3AAAAAgAAAAAAAAACdG8AAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAB9AAAAAIQWNjRXJyb3I=",
        "AAAAAAAAAENEdWXDsW86IGFncmVnYSB1biBkZXN0aW5vIHBlcm1pdGlkbyAoc2kgeWEgZXN0YWJhLCBubyBjYW1iaWEgbmFkYSkuAAAAAAlhZGRfcGF5ZWUAAAAAAAABAAAAAAAAAAVwYXllZQAAAAAAABMAAAABAAAD6QAAAAIAAAfQAAAACEFjY0Vycm9y",
        "AAAAAAAAAJREdWXDsW86IHJlZW1wbGF6YSBsYSBsaXN0YSBkZSBkZXN0aW5vcyBwZXJtaXRpZG9zIChsb3MgcmVwZXRpZG9zIHNlIGlnbm9yYW4pLgpMaXN0YSB2YWPDrWEgPSBlbCBhZ2VudGUgbm8gcHVlZGUgcGFnYXIgYSBuYWRpZS4gTcOheGltbyBgTUFYX1BBWUVFU2AuAAAACnNldF9wYXllZXMAAAAAAAEAAAAAAAAABnBheWVlcwAAAAAD6gAAABMAAAABAAAD6QAAAAIAAAfQAAAACEFjY0Vycm9y",
        "AAAAAAAAAAAAAAAMX19jaGVja19hdXRoAAAAAwAAAAAAAAARc2lnbmF0dXJlX3BheWxvYWQAAAAAAAPuAAAAIAAAAAAAAAAKc2lnbmF0dXJlcwAAAAAD6gAAB9AAAAAQRWQyNTUxOVNpZ25hdHVyZQAAAAAAAAANYXV0aF9jb250ZXh0cwAAAAAAA+oAAAfQAAAAB0NvbnRleHQAAAAAAQAAA+kAAAACAAAH0AAAAAhBY2NFcnJvcg==",
        "AAAAAAAAAENEdWXDsW86IHNhY2EgdW4gZGVzdGlubyBkZSBsYSBsaXN0YSAoc2kgbm8gZXN0YWJhLCBubyBjYW1iaWEgbmFkYSkuAAAAAAxyZW1vdmVfcGF5ZWUAAAABAAAAAAAAAAVwYXllZQAAAAAAABMAAAABAAAD6QAAAAIAAAfQAAAACEFjY0Vycm9y",
        "AAAAAAAAAFRHYXN0byBkZWwgcGVyw61vZG8gYWN0dWFsLiBGYWxsYSBjb24gTm9QYXNzcG9ydCAvIFBhc3Nwb3J0Q2hhbmdlZCBpZ3VhbCBxdWUgdW4gcGFnby4AAAAMc3BlbmRfc3RhdHVzAAAAAAAAAAEAAAPpAAAH0AAAAAtTcGVuZFN0YXR1cwAAAAfQAAAACEFjY0Vycm9y",
        "AAAAAAAAAIFDcmVhIGxhIGN1ZW50YS4gRXhpZ2UgcXVlIGVsIHZhbGlkYWRvciB5YSB0ZW5nYSBlbCBwYXNhcG9ydGUgZGUgYGFnZW50X2lkYAp5IGZpamEgc3UgbnVsbGlmaWVyLiBgY2FwYCBlbiB1bmlkYWRlcyBiYXNlIGRlbCB0b2tlbi4AAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAcAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAJYWdlbnRfa2V5AAAAAAAD7gAAACAAAAAAAAAACXZhbGlkYXRvcgAAAAAAABMAAAAAAAAACGFnZW50X2lkAAAADAAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAANjYXAAAAAACwAAAAAAAAAOcGVyaW9kX2xlZGdlcnMAAAAAAAQAAAABAAAD6QAAAAIAAAfQAAAACEFjY0Vycm9y",
        "AAAAAAAAADBEdWXDsW86IHJvdGEgbGEgY2xhdmUgZGVsIGFnZW50ZSAoeSBkZXMtcmV2b2NhKS4AAAANc2V0X2FnZW50X2tleQAAAAAAAAEAAAAAAAAACWFnZW50X2tleQAAAAAAA+4AAAAgAAAAAA==",
        "AAAAAgAAAF9Db250cmFjdCBleGVjdXRhYmxlIHVzZWQgZm9yIGNyZWF0aW5nIGEgbmV3IGNvbnRyYWN0IGFuZCB1c2VkIGluCmBDcmVhdGVDb250cmFjdEhvc3RGbkNvbnRleHRgLgAAAAAAAAAAEkNvbnRyYWN0RXhlY3V0YWJsZQAAAAAAAgAAAAEAAAB4RXhlY3V0YWJsZSBzcGVjaWZpZWQgYnkgdGhlIGNvbnRyYWN0IGluc3RhbmNlIGFzIGEgc3BlY2lmaWMgV2FzbSBjb250cmFjdCBjb2RlIGVudHJ5IGlkZW50aWZpZWQgYnkgaXRzIFdhc20gc2hhMjU2IGhhc2guAAAABFdhc20AAAABAAAD7gAAACAAAAABAAAAX0V4ZWN1dGFibGUgcmVmZXJlbmNlIHZpYSBhIHBlcnNpc3RlbnQgc3RvcmFnZSBlbnRyeSBvd25lZCBieSB0aGlzIGNvbnRyYWN0IG9yIGFub3RoZXIgY29udHJhY3QuAAAAAAtFeHRlcm5hbFJlZgAAAAABAAAH0AAAABVDb250cmFjdEV4ZWN1dGFibGVSZWYAAAA=",
        "AAAAAQAAAMBFeGVjdXRhYmxlIHJlZmVyZW5jZWQgdmlhIGEgcGVyc2lzdGVudCBzdG9yYWdlIGVudHJ5IG93bmVkIGJ5IGEgY29udHJhY3QsCmVpdGhlciB0aGlzIGNvbnRyYWN0IG9yIGFub3RoZXIgY29udHJhY3QuCgpUaGUgcGVyc2lzdGVudCBzdG9yYWdlIGVudHJ5IG93bmVkIGJ5IHRoZSBgb3duZXJgIGhhcyB0aGUgYHRhZ2AgYXMgaXRzIGtleS4AAAAAAAAAFUNvbnRyYWN0RXhlY3V0YWJsZVJlZgAAAAAAAAIAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAADdGFnAAAAABA=",
        "AAAAAgAAAONDb250ZXh0IG9mIGEgc2luZ2xlIGF1dGhvcml6ZWQgY2FsbCBwZXJmb3JtZWQgYnkgYW4gYWRkcmVzcy4KCkN1c3RvbSBhY2NvdW50IGNvbnRyYWN0cyB0aGF0IGltcGxlbWVudCBgX19jaGVja19hdXRoYCBzcGVjaWFsIGZ1bmN0aW9uCnJlY2VpdmUgYSBsaXN0IG9mIGBDb250ZXh0YCB2YWx1ZXMgY29ycmVzcG9uZGluZyB0byBhbGwgdGhlIGNhbGxzIHRoYXQKbmVlZCB0byBiZSBhdXRob3JpemVkLgAAAAAAAAAAB0NvbnRleHQAAAAAAwAAAAEAAAAUQ29udHJhY3QgaW52b2NhdGlvbi4AAAAIQ29udHJhY3QAAAABAAAH0AAAAA9Db250cmFjdENvbnRleHQAAAAAAQAAAD1Db250cmFjdCB0aGF0IGhhcyBhIGNvbnN0cnVjdG9yIHdpdGggbm8gYXJndW1lbnRzIGlzIGNyZWF0ZWQuAAAAAAAAFENyZWF0ZUNvbnRyYWN0SG9zdEZuAAAAAQAAB9AAAAAbQ3JlYXRlQ29udHJhY3RIb3N0Rm5Db250ZXh0AAAAAAEAAABEQ29udHJhY3QgdGhhdCBoYXMgYSBjb25zdHJ1Y3RvciB3aXRoIDEgb3IgbW9yZSBhcmd1bWVudHMgaXMgY3JlYXRlZC4AAAAcQ3JlYXRlQ29udHJhY3RXaXRoQ3Rvckhvc3RGbgAAAAEAAAfQAAAAKkNyZWF0ZUNvbnRyYWN0V2l0aENvbnN0cnVjdG9ySG9zdEZuQ29udGV4dAAA",
        "AAAAAQAAAL1BdXRob3JpemF0aW9uIGNvbnRleHQgb2YgYSBzaW5nbGUgY29udHJhY3QgY2FsbC4KClRoaXMgc3RydWN0IGNvcnJlc3BvbmRzIHRvIGEgYHJlcXVpcmVfYXV0aF9mb3JfYXJnc2AgY2FsbCBmb3IgYW4gYWRkcmVzcwpmcm9tIGBjb250cmFjdGAgZnVuY3Rpb24gd2l0aCBgZm5fbmFtZWAgbmFtZSBhbmQgYGFyZ3NgIGFyZ3VtZW50cy4AAAAAAAAAAAAAD0NvbnRyYWN0Q29udGV4dAAAAAADAAAAAAAAAARhcmdzAAAD6gAAAAAAAAAAAAAACGNvbnRyYWN0AAAAEwAAAAAAAAAHZm5fbmFtZQAAAAAR",
        "AAAAAQAAAHZBdXRob3JpemF0aW9uIGNvbnRleHQgZm9yIGBjcmVhdGVfY29udHJhY3RgIGhvc3QgZnVuY3Rpb24gdGhhdCBjcmVhdGVzIGEKbmV3IGNvbnRyYWN0IG9uIGJlaGFsZiBvZiBhdXRob3JpemVyIGFkZHJlc3MuAAAAAAAAAAAAG0NyZWF0ZUNvbnRyYWN0SG9zdEZuQ29udGV4dAAAAAACAAAAAAAAAApleGVjdXRhYmxlAAAAAAfQAAAAEkNvbnRyYWN0RXhlY3V0YWJsZQAAAAAAAAAAAARzYWx0AAAD7gAAACA=",
        "AAAAAQAAANZBdXRob3JpemF0aW9uIGNvbnRleHQgZm9yIGBjcmVhdGVfY29udHJhY3RgIGhvc3QgZnVuY3Rpb24gdGhhdCBjcmVhdGVzIGEKbmV3IGNvbnRyYWN0IG9uIGJlaGFsZiBvZiBhdXRob3JpemVyIGFkZHJlc3MuClRoaXMgaXMgdGhlIHNhbWUgYXMgYENyZWF0ZUNvbnRyYWN0SG9zdEZuQ29udGV4dGAsIGJ1dCBhbHNvIGhhcwpjb250cmFjdCBjb25zdHJ1Y3RvciBhcmd1bWVudHMuAAAAAAAAAAAAKkNyZWF0ZUNvbnRyYWN0V2l0aENvbnN0cnVjdG9ySG9zdEZuQ29udGV4dAAAAAAAAwAAAAAAAAAQY29uc3RydWN0b3JfYXJncwAAA+oAAAAAAAAAAAAAAApleGVjdXRhYmxlAAAAAAfQAAAAEkNvbnRyYWN0RXhlY3V0YWJsZQAAAAAAAAAAAARzYWx0AAAD7gAAACA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    config: this.txFromJSON<Config>,
        payees: this.txFromJSON<Array<string>>,
        revoke: this.txFromJSON<null>,
        set_cap: this.txFromJSON<Result<void>>,
        is_payee: this.txFromJSON<boolean>,
        withdraw: this.txFromJSON<Result<void>>,
        add_payee: this.txFromJSON<Result<void>>,
        set_payees: this.txFromJSON<Result<void>>,
        remove_payee: this.txFromJSON<Result<void>>,
        spend_status: this.txFromJSON<Result<SpendStatus>>,
        set_agent_key: this.txFromJSON<null>
  }
}