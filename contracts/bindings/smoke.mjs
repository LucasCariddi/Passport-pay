// Prueba de humo de los bindings: lecturas reales en testnet (solo simulación).
// Uso (desde la raíz): node contracts/bindings/smoke.mjs
import { Client as Factory, networks } from "./passport-factory/dist/index.js";
import { Client as Account } from "./passport-account/dist/index.js";

const rpcUrl = "https://soroban-testnet.stellar.org";
const base = { networkPassphrase: networks.testnet.networkPassphrase, rpcUrl };
const factory = new Factory({ ...base, contractId: networks.testnet.contractId });

const acc42 = (await factory.account_of({ agent_id: 42n })).result;
console.log("factory", networks.testnet.contractId);
console.log("account_of(42)", acc42);
console.log("is_account(acc42)", (await factory.is_account({ account: acc42 })).result);
console.log("is_account(spike)", (await factory.is_account({ account: "CBIRF3XX45F2I356XLDDALKSKQWRXMUNFVBF7A65TRSEWXVXHRYP56VS" })).result);
console.log("predict_account(42)", (await factory.predict_account({ agent_id: 42n })).result);

const account = new Account({ ...base, contractId: acc42 });
const st = (await account.spend_status()).result; // Result<SpendStatus>
console.log("spend_status", st.isOk() ? st.unwrap() : st.unwrapErr());
const cfg = (await account.config()).result;
console.log("config.cap", cfg.cap, "period", cfg.period_ledgers, "revoked", cfg.revoked);
