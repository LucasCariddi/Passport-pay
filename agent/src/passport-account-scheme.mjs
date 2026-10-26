// Esquema cliente x402 "exact" para Stellar cuyo pagador es una PassportAccount
// (dirección C...), no una cuenta G.
//
// Por qué no alcanza el cliente de @x402/stellar: su ExactStellarScheme llama a
// `tx.signAuthEntries({ address, signAuthEntry })` y el `authorizeEntry` por defecto
// de stellar-sdk deriva la clave pública de la dirección del auth entry. Con una
// dirección C eso tira (`Keypair.fromPublicKey(C...)`). Acá construimos la MISMA
// transacción (SAC.transfer(from=C..., to=payTo, amount)) y firmamos el auth entry
// con la clave ed25519 del agente, en el formato Vec<{public_key, signature}> que
// espera `__check_auth` de la PassportAccount.
//
// El payload resultante es idéntico en forma al del cliente oficial, así que el
// facilitador oficial (@x402/stellar/exact/facilitator) lo verifica y liquida sin cambios.
import { authorizeEntry, contract, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import {
  findDefaultAsset,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  handleSimulationResult,
} from "@x402/stellar";
import { extractContractError } from "./errors.mjs";

/** Firma un auth entry con la clave ed25519 del agente (formato Vec<{public_key, signature}>). */
export function agentAuthorizer(agent) {
  return (entry, _signer, validUntil, passphrase) =>
    authorizeEntry(
      entry,
      async (_preimage, payloadHash) => ({ signature: agent.sign(payloadHash), publicKey: agent.publicKey() }),
      validUntil,
      passphrase,
    );
}

/** Error de la simulación onchain con el `Error(Contract, #n)` ya parseado. */
export class OnchainRejection extends Error {
  constructor(stage, cause) {
    const raw = String(cause?.message ?? cause);
    const ce = extractContractError(raw);
    super(ce ? `${ce.raw} ${ce.name}: ${ce.es}` : raw.slice(0, 400));
    this.name = "OnchainRejection";
    this.stage = stage;
    this.contractError = ce;
    this.raw = raw;
  }
}

export class PassportAccountExactScheme {
  /**
   * @param {{ accountId: string, agentSecret: string, rpcConfig?: { url?: string }, preflight?: boolean,
   *           onPrepared?: (info: object) => void }} opts
   *   preflight=false saltea la re-simulación en modo enforcing: el pago se manda igual y
   *   lo rechaza la simulación del facilitador (sirve para mostrar el rechazo del lado servidor).
   */
  constructor({ accountId, agentSecret, rpcConfig, preflight = true, onPrepared }) {
    this.scheme = "exact";
    this.accountId = accountId;
    this.agent = Keypair.fromSecret(agentSecret);
    this.rpcConfig = rpcConfig;
    this.preflight = preflight;
    this.onPrepared = onPrepared;
    // x402Client usa esto en spendControls para aceptar USDC como asset por defecto.
    this.findDefaultAsset = findDefaultAsset;
  }

  async createPaymentPayload(x402Version, req) {
    const { network, payTo, asset, amount, extra, maxTimeoutSeconds } = req;
    if (req.scheme !== "exact") throw new Error(`esquema no soportado: ${req.scheme}`);
    if (!extra?.areFeesSponsored) throw new Error("exact requiere areFeesSponsored=true");
    const networkPassphrase = getNetworkPassphrase(network);
    const rpcUrl = getRpcUrl(network, this.rpcConfig);
    const rpc = getRpcClient(network, this.rpcConfig);
    const latest = await rpc.getLatestLedger();
    const ledgerSecs = await getEstimatedLedgerCloseTimeSeconds(network);
    const maxLedger = latest.sequence + Math.ceil(maxTimeoutSeconds / ledgerSecs);

    let tx;
    try {
      // Simulación en modo "recording": todavía no corre __check_auth.
      tx = await contract.AssembledTransaction.build({
        contractId: asset,
        method: "transfer",
        args: [
          nativeToScVal(this.accountId, { type: "address" }),
          nativeToScVal(payTo, { type: "address" }),
          nativeToScVal(amount, { type: "i128" }),
        ],
        networkPassphrase,
        rpcUrl,
        parseResultXdr: (r) => r,
      });
      handleSimulationResult(tx.simulation);
    } catch (e) {
      throw new OnchainRejection("recording", e);
    }
    const missing = tx.needsNonInvokerSigningBy();
    if (missing.length !== 1 || missing[0] !== this.accountId) {
      throw new Error(`se esperaba firmar solo por ${this.accountId}, se pide [${missing.join(", ")}]`);
    }

    await tx.signAuthEntries({ address: this.accountId, expiration: maxLedger, authorizeEntry: agentAuthorizer(this.agent) });

    if (this.preflight) {
      // Re-simulación en modo enforcing: acá corre __check_auth de la PassportAccount
      // contra el estado real de testnet (pasaporte, revocación, tope).
      try {
        await tx.simulate();
        handleSimulationResult(tx.simulation);
      } catch (e) {
        throw new OnchainRejection("enforcing", e);
      }
      const still = tx.needsNonInvokerSigningBy();
      if (still.length > 0) throw new Error(`firmas pendientes inesperadas: [${still.join(", ")}]`);
    }

    const xdrTx = tx.built.toXDR();
    this.onPrepared?.({ amount, payTo, asset, preflight: this.preflight, maxLedger });
    return { x402Version, payload: { transaction: xdrTx } };
  }
}
