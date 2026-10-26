#![no_std]
//! PassportFactory: crea una `PassportAccount` por pasaporte ZK y lleva el registro
//! de qué cuentas son "de pasaporte".
//!
//! - `register`: en UNA tx, llama `verify_and_register` del AgentPassportValidator
//!   (quema el nullifier y guarda el pasaporte) y despliega la cuenta del agente con
//!   `agent_id = public_inputs[2]`. Así el vínculo pasaporte -> cuenta es atómico.
//! - `adopt` (solo admin): para pasaportes que ya estaban registrados antes de la
//!   factory (el agente #42 del spike).
//! - `is_account`: lo consulta el servidor x402 antes de aceptar un pago, para que
//!   solo paguen cuentas creadas acá (un `transfer` de SAC no se puede rechazar del
//!   lado del receptor, así que esa admisión no puede vivir en el token).
//!
//! Una cuenta por `agent_id`; la dirección es determinística
//! (`salt = sha256(agent_id en 32 bytes big endian)`), ver `predict_account`.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    ContractExecutable, Env, IntoVal, Val, Vec, U256,
};

/// Cliente tipado del validador desplegado (versión vieja, sin `revoke` ni allow-list
/// de raíces), generado desde el wasm bajado de testnet.
pub mod validator {
    soroban_sdk::contractimport!(file = "../osp-wasm/agent_passport_validator.deployed.wasm");
}

/// Prueba Groth16 BN254, mismo layout que el validador:
/// `a`/`c` = x||y (32 B BE cada uno); `b` = x.c1||x.c0||y.c1||y.c0.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Groth16Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum FactoryError {
    /// Ya hay una cuenta para ese agent_id.
    AgentTaken = 1,
    /// El validador rechazó la prueba (prueba inválida o error del verificador).
    ProofRejected = 2,
    /// `public_inputs` no tiene 4 elementos.
    BadPublicInputs = 3,
    /// `adopt`: el validador no tiene pasaporte para ese agent_id.
    NoPassport = 4,
    /// `cap < 0` o `period_ledgers == 0`.
    InvalidConfig = 5,
    /// El nullifier de la prueba ya se usó (la prueba ya se registró antes).
    NullifierUsed = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FactoryConfig {
    pub admin: Address,
    pub validator: Address,
    pub account_wasm_hash: BytesN<32>,
    pub token: Address,
}

/// Se emite al crear una cuenta (por `register` o `adopt`). `owner` va como topic
/// para que la web filtre "mis cuentas" con `getEvents`.
#[contractevent(topics = ["account_created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountCreated {
    #[topic]
    pub owner: Address,
    pub agent_id: U256,
    pub account: Address,
    pub adopted: bool,
}

#[contractevent(topics = ["account_wasm_set"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountWasmSet {
    pub account_wasm_hash: BytesN<32>,
}

#[contractevent(topics = ["admin_set"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminSet {
    pub admin: Address,
}

#[contracttype]
enum Key {
    Config,
    /// agent_id -> cuenta
    AccountOf(U256),
    /// cuenta -> agent_id
    AgentOf(Address),
}

pub const TTL_THRESHOLD: u32 = 17_280;
pub const TTL_BUMP: u32 = 518_400;

const IDX_AGENT_ID: u32 = 2;
const N_PUBLIC_INPUTS: u32 = 4;

#[contract]
pub struct PassportFactory;

fn load(env: &Env) -> FactoryConfig {
    env.storage().instance().get(&Key::Config).unwrap()
}

fn save(env: &Env, cfg: &FactoryConfig) {
    env.storage().instance().set(&Key::Config, cfg);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
}

fn salt_for(env: &Env, agent_id: &U256) -> BytesN<32> {
    let raw: Bytes = agent_id.to_be_bytes();
    env.crypto().sha256(&raw).into()
}

fn check_config(cap: i128, period_ledgers: u32) -> Result<(), FactoryError> {
    if cap < 0 || period_ledgers == 0 {
        return Err(FactoryError::InvalidConfig);
    }
    Ok(())
}

fn ensure_free(env: &Env, agent_id: &U256) -> Result<(), FactoryError> {
    if env.storage().persistent().has(&Key::AccountOf(agent_id.clone())) {
        return Err(FactoryError::AgentTaken);
    }
    Ok(())
}

/// Despliega la PassportAccount (su constructor vuelve a leer `get_passport` y fija
/// el nullifier) y guarda los dos índices.
fn deploy_account(
    env: &Env,
    cfg: &FactoryConfig,
    owner: Address,
    agent_key: BytesN<32>,
    agent_id: U256,
    cap: i128,
    period_ledgers: u32,
    adopted: bool,
) -> Address {
    let args: Vec<Val> = (
        owner.clone(),
        agent_key,
        cfg.validator.clone(),
        agent_id.clone(),
        cfg.token.clone(),
        cap,
        period_ledgers,
    )
        .into_val(env);
    let account = env
        .deployer()
        .with_current_contract(salt_for(env, &agent_id))
        .deploy_contract(ContractExecutable::Wasm(cfg.account_wasm_hash.clone()), args);

    let p = env.storage().persistent();
    let k1 = Key::AccountOf(agent_id.clone());
    let k2 = Key::AgentOf(account.clone());
    p.set(&k1, &account);
    p.set(&k2, &agent_id);
    p.extend_ttl(&k1, TTL_THRESHOLD, TTL_BUMP);
    p.extend_ttl(&k2, TTL_THRESHOLD, TTL_BUMP);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);

    AccountCreated { owner, agent_id, account: account.clone(), adopted }.publish(env);
    account
}

#[contractimpl]
impl PassportFactory {
    pub fn __constructor(
        env: Env,
        admin: Address,
        validator: Address,
        account_wasm_hash: BytesN<32>,
        token: Address,
    ) {
        save(&env, &FactoryConfig { admin, validator, account_wasm_hash, token });
    }

    /// Dueño: registra el pasaporte (prueba ZK) y crea su cuenta en la misma tx.
    /// Devuelve la dirección C de la cuenta. `cap` en unidades base del token.
    ///
    /// Ojo: la prueba no está atada a `owner` (el circuito no lo incluye), así que
    /// quien envíe primero una prueba válida se queda con la cuenta.
    pub fn register(
        env: Env,
        owner: Address,
        agent_key: BytesN<32>,
        proof: Groth16Proof,
        public_inputs: Vec<U256>,
        cap: i128,
        period_ledgers: u32,
    ) -> Result<Address, FactoryError> {
        owner.require_auth();
        check_config(cap, period_ledgers)?;
        if public_inputs.len() != N_PUBLIC_INPUTS {
            return Err(FactoryError::BadPublicInputs);
        }
        let agent_id = public_inputs.get_unchecked(IDX_AGENT_ID);
        ensure_free(&env, &agent_id)?;

        let cfg = load(&env);
        let vproof = validator::Groth16Proof { a: proof.a, b: proof.b, c: proof.c };
        let att = match validator::Client::new(&env, &cfg.validator)
            .try_verify_and_register(&vproof, &public_inputs)
        {
            Ok(Ok(att)) => att,
            Err(Ok(validator::Error::NullifierUsed)) => return Err(FactoryError::NullifierUsed),
            Err(Ok(validator::Error::BadPublicInputs)) => return Err(FactoryError::BadPublicInputs),
            _ => return Err(FactoryError::ProofRejected),
        };
        if att.agent_id != agent_id {
            return Err(FactoryError::ProofRejected);
        }
        Ok(deploy_account(&env, &cfg, owner, agent_key, agent_id, cap, period_ledgers, false))
    }

    /// Admin: crea la cuenta para un pasaporte que ya estaba registrado en el
    /// validador (sin prueba nueva). Exige `get_passport(agent_id)`.
    pub fn adopt(
        env: Env,
        owner: Address,
        agent_key: BytesN<32>,
        agent_id: U256,
        cap: i128,
        period_ledgers: u32,
    ) -> Result<Address, FactoryError> {
        let cfg = load(&env);
        cfg.admin.require_auth();
        check_config(cap, period_ledgers)?;
        ensure_free(&env, &agent_id)?;
        if validator::Client::new(&env, &cfg.validator).get_passport(&agent_id).is_none() {
            return Err(FactoryError::NoPassport);
        }
        Ok(deploy_account(&env, &cfg, owner, agent_key, agent_id, cap, period_ledgers, true))
    }

    pub fn account_of(env: Env, agent_id: U256) -> Option<Address> {
        env.storage().persistent().get(&Key::AccountOf(agent_id))
    }

    pub fn agent_of(env: Env, account: Address) -> Option<U256> {
        env.storage().persistent().get(&Key::AgentOf(account))
    }

    /// true solo para cuentas desplegadas por esta factory.
    pub fn is_account(env: Env, account: Address) -> bool {
        env.storage().persistent().has(&Key::AgentOf(account))
    }

    /// Dirección que va a tener (o tiene) la cuenta de `agent_id`.
    pub fn predict_account(env: Env, agent_id: U256) -> Address {
        env.deployer().with_current_contract(salt_for(&env, &agent_id)).deployed_address()
    }

    pub fn admin(env: Env) -> Address {
        load(&env).admin
    }

    pub fn config(env: Env) -> FactoryConfig {
        load(&env)
    }

    /// Admin: wasm de las cuentas NUEVAS (las existentes no cambian).
    pub fn set_account_wasm(env: Env, account_wasm_hash: BytesN<32>) {
        let mut cfg = load(&env);
        cfg.admin.require_auth();
        cfg.account_wasm_hash = account_wasm_hash.clone();
        save(&env, &cfg);
        AccountWasmSet { account_wasm_hash }.publish(&env);
    }

    /// Admin: transfiere la administración.
    pub fn set_admin(env: Env, admin: Address) {
        let mut cfg = load(&env);
        cfg.admin.require_auth();
        cfg.admin = admin.clone();
        save(&env, &cfg);
        AdminSet { admin }.publish(&env);
    }

    /// Cualquiera: extiende el TTL de la instancia y de los índices de `agent_id`
    /// para que `is_account` no quede archivado.
    pub fn bump(env: Env, agent_id: U256) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
        let p = env.storage().persistent();
        let k1 = Key::AccountOf(agent_id);
        if let Some(account) = p.get::<_, Address>(&k1) {
            p.extend_ttl(&k1, TTL_THRESHOLD, TTL_BUMP);
            p.extend_ttl(&Key::AgentOf(account), TTL_THRESHOLD, TTL_BUMP);
        }
    }
}

#[cfg(test)]
mod test;
