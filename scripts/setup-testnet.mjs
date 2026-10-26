// Prepara las cuentas de testnet: trustline a USDC de Circle (testnet) y
// compra de USDC en el DEX de testnet con un path payment desde XLM.
// No hace falta el faucet web de Circle: el DEX de testnet tiene liquidez.
// Uso: node scripts/setup-testnet.mjs
import {
  Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder,
} from "@stellar/stellar-sdk";

process.loadEnvFile(new URL("../.env", import.meta.url));

export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const horizon = new Horizon.Server(process.env.HORIZON_URL);

// Quien necesita trustline y cuanto XLM se vende para comprar USDC.
const PLAN = [
  { name: "MERCHANT", buyXlm: 0 },
  { name: "PAYER", buyXlm: 30 },
  { name: "OWNER", buyXlm: 60 },
];

async function usdcBalance(pub) {
  const acc = await horizon.loadAccount(pub);
  const b = acc.balances.find((x) => x.asset_code === "USDC" && x.asset_issuer === USDC_ISSUER);
  return b ? b.balance : null;
}

for (const { name, buyXlm } of PLAN) {
  const kp = Keypair.fromSecret(process.env[`${name}_SECRET`]);
  let bal = await usdcBalance(kp.publicKey());
  const acc = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
  let ops = 0;
  if (bal === null) {
    b.addOperation(Operation.changeTrust({ asset: USDC }));
    ops++;
  }
  if (buyXlm > 0 && Number(bal ?? 0) < 5) {
    b.addOperation(Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(), sendAmount: String(buyXlm),
      destination: kp.publicKey(), destAsset: USDC, destMin: "1", path: [],
    }));
    ops++;
  }
  if (ops === 0) {
    console.log(`${name} ${kp.publicKey()} ya listo, USDC=${bal}`);
    continue;
  }
  const tx = b.setTimeout(60).build();
  tx.sign(kp);
  const res = await horizon.submitTransaction(tx);
  bal = await usdcBalance(kp.publicKey());
  console.log(`${name} ${kp.publicKey()} tx=${res.hash} USDC=${bal}`);
}
