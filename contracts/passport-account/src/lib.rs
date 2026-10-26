#![no_std]
//! PassportAccount: cuenta contrato (smart account) que paga x402 por un agente IA.
//!
//! El pago x402 `exact` en Stellar es una llamada `transfer(from, to, amount)` a la
//! SAC de USDC con `from` = esta cuenta. Al autorizar ese `transfer`, el host de
//! Soroban llama a `__check_auth` de esta cuenta, que:
//!
//!   1. rechaza si el dueño revocó la cuenta,
//!   2. verifica la firma ed25519 de la clave del agente,
//!   3. exige que el AgentPassportValidator siga teniendo un pasaporte para `agent_id`
//!      (`get_passport` distinto de None),
//!   4. solo permite `transfer` de la SAC configurada, con `from` = esta cuenta,
//!   5. exige que el destino (`to`) del `transfer` esté en la lista de destinos
//!      permitidos que administra el dueño (`set_payees` / `add_payee` /
//!      `remove_payee`). Con la lista vacía no pasa ningún pago,
//!   6. aplica el tope por período: min(tope del dueño, spend_cap del pasaporte FIJADO
//!      al crear la cuenta).
//!
//! Por qué la lista de destinos: el tope acota cuánto se pierde, no a quién se le
//! paga. Si al agente le hacen prompt injection (o se filtra su clave), el agente
//! firma igual un `transfer` al atacante; sin la lista, ese pago pasaba mientras
//! entrara en el tope. Con la lista, la red lo rechaza con `PayeeNotAllowed` (#10)
//! porque la regla vive en la cuenta, no en el agente ni en el backend.
//!
//! Por qué el spend_cap y el nullifier se fijan en el constructor y no se releen:
//! el validador guarda "el último pasaporte" por `agent_id` y cualquiera puede
//! registrar otro para el mismo `agent_id` con otro secreto (el validador desplegado
//! no tiene allow-list de raíces). Si la cuenta exigiera el mismo nullifier en cada
//! pago, un tercero la dejaría inutilizable para siempre (PoC en testnet, tx
//! a7841b5f...); si releyera el spend_cap, ese tercero podría bajarlo o subirlo.
//! Por eso `PassportChanged` (#9) ya no se devuelve; queda en el enum por compatibilidad.
//!
//! Si algo falla, el `transfer` falla ONCHAIN (en la simulación del facilitador y
//! en la tx real), sin depender del backend. El replay lo impide el host: cada
//! auth entry lleva un nonce que se quema al usarse.
//!
//! IMPORTANTE: `__check_auth` no emite eventos. El facilitador x402 de Stellar
//! rechaza cualquier evento de contrato que no sea el `transfer` de la SAC
//! (`invalid_exact_stellar_payload_event_not_transfer`).

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    crypto::Hash,
    Address, BytesN, Env, MuxedAddress, Symbol, TryFromVal, Vec, U256,
};

/// Attestation tal como la devuelve el validador desplegado de open-stellar-passport.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attestation {
    pub agent_id: U256,
    pub ledger: u32,
    pub nullifier: U256,
    pub registry_root: U256,
    pub spend_cap: U256,
}

/// Subconjunto de la interfaz del AgentPassportValidator que usamos.
#[contractclient(name = "ValidatorClient")]
pub trait Validator {
    fn get_passport(env: Env, agent_id: U256) -> Option<Attestation>;
}

/// Firma con el mismo formato que arma `authorizeEntry` de stellar-sdk
/// (`Vec<{public_key, signature}>`), así el tooling estándar la sabe serializar.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Ed25519Signature {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccError {
    Revoked = 1,
    BadSignatureCount = 2,
    UnknownSigner = 3,
    NoPassport = 4,
    ContextNotAllowed = 5,
    CapExceeded = 6,
    BadAmount = 7,
    InvalidConfig = 8,
    /// Ya no se devuelve (ver el comentario del módulo). Se deja para no correr los códigos.
    PassportChanged = 9,
    /// El destino del `transfer` no está en la lista de destinos permitidos del dueño.
    PayeeNotAllowed = 10,
}

/// Máximo de destinos permitidos (la lista vive en la instancia, que se carga en cada pago).
pub const MAX_PAYEES: u32 = 32;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    pub agent_key: BytesN<32>,
    pub validator: Address,
    pub agent_id: U256,
    /// Nullifier del pasaporte vigente al crear la cuenta (lo fija el constructor).
    pub nullifier: U256,
    pub token: Address,
    /// Tope del dueño por período, en unidades base del token (7 decimales).
    pub cap: i128,
    /// Largo del período en ledgers (~5 s por ledger; 17280 = ~1 día).
    pub period_ledgers: u32,
    pub revoked: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spent {
    pub period: u32,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendStatus {
    pub period: u32,
    pub spent: i128,
    pub effective_cap: i128,
    pub remaining: i128,
    pub period_ends_ledger: u32,
}

/// Eventos del dueño (nunca se emiten desde `__check_auth`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapSet {
    pub cap: i128,
    pub period_ledgers: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Revoked {}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentKeySet {
    pub agent_key: BytesN<32>,
}

/// La lista entera de destinos permitidos después de cada cambio del dueño.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayeesSet {
    pub payees: Vec<Address>,
}

#[contracttype]
enum Key {
    Config,
    Spent,
    /// spend_cap del pasaporte al crear la cuenta, ya pasado a i128.
    PassportCap,
    /// Destinos permitidos (`Vec<Address>`, sin repetidos). Instancia, mismo TTL que `Config`.
    Payees,
}

pub const TTL_THRESHOLD: u32 = 17_280;
pub const TTL_BUMP: u32 = 518_400;

#[contract]
pub struct PassportAccount;

fn load(env: &Env) -> Config {
    env.storage().instance().get(&Key::Config).unwrap()
}

fn save(env: &Env, cfg: &Config) {
    env.storage().instance().set(&Key::Config, cfg);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
}

fn u256_to_cap(v: &U256) -> i128 {
    // spend_cap es U256; si no entra en i128 se toma i128::MAX.
    v.to_u128()
        .map(|v| if v > i128::MAX as u128 { i128::MAX } else { v as i128 })
        .unwrap_or(i128::MAX)
}

/// Exige que el validador tenga un pasaporte para `agent_id` y devuelve el
/// spend_cap FIJADO al crear la cuenta. No compara el nullifier ni relee el
/// spend_cap: un tercero puede pisar el pasaporte del validador (ver arriba).
fn passport_cap(env: &Env, cfg: &Config) -> Result<i128, AccError> {
    if ValidatorClient::new(env, &cfg.validator).get_passport(&cfg.agent_id).is_none() {
        return Err(AccError::NoPassport);
    }
    Ok(env.storage().instance().get(&Key::PassportCap).unwrap_or(0))
}

fn load_payees(env: &Env) -> Vec<Address> {
    env.storage().instance().get(&Key::Payees).unwrap_or_else(|| Vec::new(env))
}

/// Guarda la lista (dueño ya autorizado), extiende el TTL de la instancia y publica
/// la lista completa. Nunca se llama desde `__check_auth`.
fn save_payees(env: &Env, payees: &Vec<Address>) -> Result<(), AccError> {
    if payees.len() > MAX_PAYEES {
        return Err(AccError::InvalidConfig);
    }
    env.storage().instance().set(&Key::Payees, payees);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
    PayeesSet { payees: payees.clone() }.publish(env);
    Ok(())
}

fn current_spent(env: &Env, cfg: &Config) -> (u32, i128) {
    let period = env.ledger().sequence() / cfg.period_ledgers;
    let spent: Option<Spent> = env.storage().instance().get(&Key::Spent);
    match spent {
        Some(s) if s.period == period => (period, s.amount),
        _ => (period, 0),
    }
}

#[contractimpl]
impl PassportAccount {
    /// Crea la cuenta. Exige que el validador ya tenga el pasaporte de `agent_id`
    /// y fija su nullifier. `cap` en unidades base del token.
    pub fn __constructor(
        env: Env,
        owner: Address,
        agent_key: BytesN<32>,
        validator: Address,
        agent_id: U256,
        token: Address,
        cap: i128,
        period_ledgers: u32,
    ) -> Result<(), AccError> {
        if cap < 0 || period_ledgers == 0 {
            return Err(AccError::InvalidConfig);
        }
        let att = ValidatorClient::new(&env, &validator)
            .get_passport(&agent_id)
            .ok_or(AccError::NoPassport)?;
        let cfg = Config {
            owner,
            agent_key,
            validator,
            agent_id,
            nullifier: att.nullifier,
            token,
            cap,
            period_ledgers,
            revoked: false,
        };
        env.storage().instance().set(&Key::PassportCap, &u256_to_cap(&att.spend_cap));
        save(&env, &cfg);
        Ok(())
    }

    pub fn config(env: Env) -> Config {
        load(&env)
    }

    /// Gasto del período actual. Falla con NoPassport / PassportChanged igual que un pago.
    pub fn spend_status(env: Env) -> Result<SpendStatus, AccError> {
        let cfg = load(&env);
        let pcap = passport_cap(&env, &cfg)?;
        let effective_cap = if pcap < cfg.cap { pcap } else { cfg.cap };
        let (period, spent) = current_spent(&env, &cfg);
        let remaining = if effective_cap > spent { effective_cap - spent } else { 0 };
        Ok(SpendStatus {
            period,
            spent,
            effective_cap,
            remaining,
            period_ends_ledger: (period + 1).saturating_mul(cfg.period_ledgers),
        })
    }

    /// Dueño: cambia tope y largo del período. Si cambia el largo, el acumulado
    /// se reinterpreta con el nuevo número de período (normalmente arranca en 0).
    pub fn set_cap(env: Env, cap: i128, period_ledgers: u32) -> Result<(), AccError> {
        let mut cfg = load(&env);
        cfg.owner.require_auth();
        if cap < 0 || period_ledgers == 0 {
            return Err(AccError::InvalidConfig);
        }
        cfg.cap = cap;
        cfg.period_ledgers = period_ledgers;
        save(&env, &cfg);
        CapSet { cap, period_ledgers }.publish(&env);
        Ok(())
    }

    /// Dueño: revoca la cuenta. Desde acá todo `transfer` del agente falla onchain.
    pub fn revoke(env: Env) {
        let mut cfg = load(&env);
        cfg.owner.require_auth();
        cfg.revoked = true;
        save(&env, &cfg);
        Revoked {}.publish(&env);
    }

    /// Dueño: rota la clave del agente (y des-revoca).
    pub fn set_agent_key(env: Env, agent_key: BytesN<32>) {
        let mut cfg = load(&env);
        cfg.owner.require_auth();
        cfg.agent_key = agent_key.clone();
        cfg.revoked = false;
        save(&env, &cfg);
        AgentKeySet { agent_key }.publish(&env);
    }

    /// Destinos a los que el agente puede pagar.
    pub fn payees(env: Env) -> Vec<Address> {
        load_payees(&env)
    }

    pub fn is_payee(env: Env, to: Address) -> bool {
        load_payees(&env).contains(&to)
    }

    /// Dueño: reemplaza la lista de destinos permitidos (los repetidos se ignoran).
    /// Lista vacía = el agente no puede pagar a nadie. Máximo `MAX_PAYEES`.
    pub fn set_payees(env: Env, payees: Vec<Address>) -> Result<(), AccError> {
        let cfg = load(&env);
        cfg.owner.require_auth();
        let mut list: Vec<Address> = Vec::new(&env);
        for p in payees.iter() {
            if !list.contains(&p) {
                list.push_back(p);
            }
        }
        save_payees(&env, &list)
    }

    /// Dueño: agrega un destino permitido (si ya estaba, no cambia nada).
    pub fn add_payee(env: Env, payee: Address) -> Result<(), AccError> {
        let cfg = load(&env);
        cfg.owner.require_auth();
        let mut list = load_payees(&env);
        if !list.contains(&payee) {
            list.push_back(payee);
        }
        save_payees(&env, &list)
    }

    /// Dueño: saca un destino de la lista (si no estaba, no cambia nada).
    pub fn remove_payee(env: Env, payee: Address) -> Result<(), AccError> {
        let cfg = load(&env);
        cfg.owner.require_auth();
        let mut list = load_payees(&env);
        if let Some(i) = list.first_index_of(&payee) {
            list.remove(i);
        }
        save_payees(&env, &list)
    }

    /// Dueño: retira fondos de la cuenta. La cuenta se autoriza a sí misma
    /// porque es el contrato invocador del `transfer` (no pasa por `__check_auth`).
    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), AccError> {
        let cfg = load(&env);
        cfg.owner.require_auth();
        if amount <= 0 {
            return Err(AccError::BadAmount);
        }
        soroban_sdk::token::TokenClient::new(&env, &cfg.token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        Ok(())
    }
}

#[contractimpl]
impl CustomAccountInterface for PassportAccount {
    type Signature = Vec<Ed25519Signature>;
    type Error = AccError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: Vec<Ed25519Signature>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccError> {
        let cfg = load(&env);
        if cfg.revoked {
            return Err(AccError::Revoked);
        }
        if signatures.len() != 1 {
            return Err(AccError::BadSignatureCount);
        }
        let sig = signatures.get_unchecked(0);
        if sig.public_key != cfg.agent_key {
            return Err(AccError::UnknownSigner);
        }
        // Si la firma no corresponde, el host aborta (trap): no hay forma de autorizar.
        env.crypto()
            .ed25519_verify(&sig.public_key, &signature_payload.into(), &sig.signature);

        let me = env.current_contract_address();
        let transfer = Symbol::new(&env, "transfer");
        let payees = load_payees(&env);
        let mut total: i128 = 0;
        for ctx in auth_contexts.iter() {
            match ctx {
                Context::Contract(c) => {
                    if c.contract != cfg.token || c.fn_name != transfer || c.args.len() != 3 {
                        return Err(AccError::ContextNotAllowed);
                    }
                    let from = Address::try_from_val(&env, &c.args.get_unchecked(0))
                        .map_err(|_| AccError::ContextNotAllowed)?;
                    if from != me {
                        return Err(AccError::ContextNotAllowed);
                    }
                    // `to` de la SAC es MuxedAddress: una G muxeada (M...) cuenta como su G base.
                    let to = MuxedAddress::try_from_val(&env, &c.args.get_unchecked(1))
                        .map_err(|_| AccError::PayeeNotAllowed)?
                        .address();
                    if !payees.contains(&to) {
                        return Err(AccError::PayeeNotAllowed);
                    }
                    let amount = i128::try_from_val(&env, &c.args.get_unchecked(2))
                        .map_err(|_| AccError::BadAmount)?;
                    if amount <= 0 {
                        return Err(AccError::BadAmount);
                    }
                    total = total.checked_add(amount).ok_or(AccError::BadAmount)?;
                }
                _ => return Err(AccError::ContextNotAllowed),
            }
        }
        if total == 0 {
            return Err(AccError::ContextNotAllowed);
        }

        let pcap = passport_cap(&env, &cfg)?;
        let effective_cap = if pcap < cfg.cap { pcap } else { cfg.cap };

        let (period, spent) = current_spent(&env, &cfg);
        let new_spent = spent.checked_add(total).ok_or(AccError::BadAmount)?;
        if new_spent > effective_cap {
            return Err(AccError::CapExceeded);
        }
        env.storage().instance().set(&Key::Spent, &Spent { period, amount: new_spent });
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
        Ok(())
    }
}

#[cfg(test)]
mod test;
