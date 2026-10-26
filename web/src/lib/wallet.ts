// Conexión con la wallet del dueño vía Stellar Wallets Kit (Freighter primero).
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { FreighterModule, FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";
import { CONFIG } from "./config";
import type { Signer } from "./soroban";

// Firmante de pruebas: e2e/mint-e2e.mjs lo inyecta con page.exposeFunction y
// firma en Node con la clave de testnet del dueño. Solo existe si el bundle se
// compiló con VITE_E2E_SIGNER=1.
declare global {
  interface Window {
    __ppTestSigner?: { address: () => Promise<string>; sign: (xdr: string) => Promise<string> };
  }
}

let ready = false;
function init() {
  if (ready) return;
  StellarWalletsKit.init({
    modules: [new FreighterModule(), new xBullModule(), new AlbedoModule()],
    selectedWalletId: FREIGHTER_ID,
    network: Networks.TESTNET,
  });
  ready = true;
}

const testSigner = () => (CONFIG.e2eSigner ? window.__ppTestSigner : undefined);

export interface Wallet {
  address: string;
  label: string;
  sign: Signer;
}

/** Abre el selector de wallets (o usa el firmante de pruebas) y devuelve la dirección. */
export async function connectWallet(): Promise<Wallet> {
  const t = testSigner();
  if (t) {
    return { address: await t.address(), label: "Test signer (e2e)", sign: (x) => t.sign(x) };
  }
  init();
  const { address } = await StellarWalletsKit.authModal();
  const label = StellarWalletsKit.selectedModule?.productName ?? "Wallet";
  return {
    address,
    label,
    sign: async (txXdr, signer) => {
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(txXdr, {
        networkPassphrase: CONFIG.networkPassphrase,
        address: signer,
      });
      return signedTxXdr;
    },
  };
}

export async function disconnectWallet() {
  if (testSigner() || !ready) return;
  await StellarWalletsKit.disconnect();
}
