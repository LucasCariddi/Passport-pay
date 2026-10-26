#![cfg(test)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::{ContractContext, ContractExecutable, CreateContractHostFnContext},
    contract, contractimpl,
    testutils::{Address as _, BytesN as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{self, Limits, WriteXdr},
    Bytes, Event, IntoVal, Val,
};

// ---------------------------------------------------------------------------
// Validador falso: guarda pasaportes con spend_cap y nullifier configurables.
// ---------------------------------------------------------------------------
#[contract]
pub struct MockValidator;

#[contractimpl]
impl MockValidator {
    pub fn set(env: Env, agent_id: U256, spend_cap: U256, nullifier: U256) {
        let att = Attestation {
            agent_id: agent_id.clone(),
            ledger: 1,
            nullifier,
            registry_root: U256::from_u32(&env, 9),
            spend_cap,
        };
        env.storage().persistent().set(&agent_id, &att);
    }
    pub fn clear(env: Env, agent_id: U256) {
        env.storage().persistent().remove(&agent_id);
    }
    pub fn get_passport(env: Env, agent_id: U256) -> Option<Attestation> {
        env.storage().persistent().get(&agent_id)
    }
}

const NULLIFIER: u32 = 7;
const AGENT: u32 = 42;
const PERIOD: u32 = 100;

struct Setup {
    env: Env,
    account: Address,
    token: Address,
    validator: Address,
    key: SigningKey,
    owner: Address,
    /// Comercio en la lista de destinos permitidos (lo agrega `setup`).
    payee: Address,
}

impl Setup {
    fn client(&self) -> PassportAccountClient<'_> {
        PassportAccountClient::new(&self.env, &self.account)
    }
    fn validator(&self) -> MockValidatorClient<'_> {
        MockValidatorClient::new(&self.env, &self.validator)
    }
    fn agent_id(&self) -> U256 {
        U256::from_u32(&self.env, AGENT)
    }
}

fn pk(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &key.verifying_key().to_bytes())
}

fn setup(cap: i128, passport_cap: u32) -> Setup {
    let env = Env::default();
    let owner = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let validator = env.register(MockValidator, ());
    let agent_id = U256::from_u32(&env, AGENT);
    MockValidatorClient::new(&env, &validator).set(
        &agent_id,
        &U256::from_u32(&env, passport_cap),
        &U256::from_u32(&env, NULLIFIER),
    );
    let key = SigningKey::generate(&mut rand::thread_rng());
    let account = env.register(
        PassportAccount,
        (owner.clone(), pk(&env, &key), validator.clone(), agent_id, token.clone(), cap, PERIOD),
    );
    let payee = Address::generate(&env);
    let s = Setup { env, account, token, validator, key, owner, payee };
    // Solo la auth del dueño para esta llamada; después no queda ninguna auth mockeada.
    owner_call(&s, "set_payees", (vec![&s.env, s.payee.clone()],).into_val(&s.env));
    s.client().set_payees(&vec![&s.env, s.payee.clone()]);
    s
}

/// Mockea SOLO la auth del dueño para una llamada exacta a la cuenta.
fn owner_call(s: &Setup, fn_name: &str, args: Vec<Val>) {
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke { contract: &s.account, fn_name, args, sub_invokes: &[] },
    }]);
}

fn transfer_ctx(s: &Setup, from: &Address, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: s.token.clone(),
        fn_name: Symbol::new(&s.env, "transfer"),
        args: vec![&s.env, from.into_val(&s.env), s.payee.into_val(&s.env), amount.into_val(&s.env)],
    })
}

fn sigs_for(env: &Env, key: &SigningKey, payload: &[u8; 32]) -> Vec<Ed25519Signature> {
    let sig = key.sign(payload).to_bytes();
    vec![env, Ed25519Signature { public_key: pk(env, key), signature: BytesN::from_array(env, &sig) }]
}

/// Llama `__check_auth` directo, como lo haría el host. Error tipado del contrato.
fn check(s: &Setup, key: &SigningKey, ctxs: Vec<Context>) -> Result<(), AccError> {
    let payload = BytesN::random(&s.env);
    let sigs = sigs_for(&s.env, key, &payload.to_array());
    check_with(s, &payload, sigs, ctxs)
}

fn check_with(s: &Setup, payload: &BytesN<32>, sigs: Vec<Ed25519Signature>, ctxs: Vec<Context>) -> Result<(), AccError> {
    s.env
        .try_invoke_contract_check_auth::<AccError>(&s.account, payload, sigs.into_val(&s.env), &ctxs)
        .map_err(|e| e.expect("error tipado"))
}

// ---------------------------------------------------------------------------
// Helpers para el camino real de auth del host (auth entries firmados con nonce).
// ---------------------------------------------------------------------------
fn to_sc<T: IntoVal<Env, Val>>(env: &Env, v: T) -> xdr::ScVal {
    let val: Val = v.into_val(env);
    xdr::ScVal::try_from_val(env, &val).unwrap()
}

fn sc_addr(env: &Env, a: &Address) -> xdr::ScAddress {
    match to_sc(env, a.clone()) {
        xdr::ScVal::Address(a) => a,
        _ => unreachable!(),
    }
}

/// Auth entry firmado por la clave del agente para `token.transfer(account, to, amount)`.
fn signed_transfer_entry(
    s: &Setup,
    key: &SigningKey,
    to: &Address,
    amount: i128,
    nonce: i64,
    expiration: u32,
) -> xdr::SorobanAuthorizationEntry {
    let env = &s.env;
    let invocation = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: sc_addr(env, &s.token),
            function_name: xdr::ScSymbol("transfer".try_into().unwrap()),
            args: std::vec![to_sc(env, s.account.clone()), to_sc(env, to.clone()), to_sc(env, amount)]
                .try_into()
                .unwrap(),
        }),
        sub_invocations: xdr::VecM::default(),
    };
    let preimage = xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(env.ledger().network_id().to_array()),
        nonce,
        signature_expiration_ledger: expiration,
        invocation: invocation.clone(),
    });
    let bytes = preimage.to_xdr(Limits::none()).unwrap();
    let payload = env.crypto().sha256(&Bytes::from_slice(env, &bytes)).to_array();
    let sigs = sigs_for(env, key, &payload);
    xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: sc_addr(env, &s.account),
            nonce,
            signature_expiration_ledger: expiration,
            signature: to_sc(env, sigs),
        }),
        root_invocation: invocation,
    }
}

fn fund(s: &Setup, amount: i128) {
    s.env.mock_all_auths();
    StellarAssetClient::new(&s.env, &s.token).mint(&s.account, &amount);
}

/// Paga por el camino real: el host verifica nonce/expiración y llama `__check_auth`.
fn pay(s: &Setup, entry: xdr::SorobanAuthorizationEntry, to: &Address, amount: i128) -> bool {
    s.env.set_auths(&[entry]);
    TokenClient::new(&s.env, &s.token).try_transfer(&s.account, to, &amount).is_ok()
}

// ---------------------------------------------------------------------------
// Tope por período
// ---------------------------------------------------------------------------
#[test]
fn pays_within_cap_and_blocks_over_cap() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 600)]), Ok(()));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 400)]), Ok(()));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::CapExceeded));
    let st = s.client().spend_status();
    assert_eq!(st.spent, 1_000);
    assert_eq!(st.remaining, 0);
    assert_eq!(st.effective_cap, 1_000);
}

#[test]
fn rejected_payment_does_not_accumulate() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 900)]), Ok(()));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 200)]), Err(AccError::CapExceeded));
    assert_eq!(s.client().spend_status().spent, 900);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 100)]), Ok(()));
}

#[test]
fn multiple_transfers_in_one_auth_are_summed() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    let two = vec![&s.env, transfer_ctx(&s, &me, 600), transfer_ctx(&s, &me, 600)];
    assert_eq!(check(&s, &s.key, two), Err(AccError::CapExceeded));
    let ok = vec![&s.env, transfer_ctx(&s, &me, 500), transfer_ctx(&s, &me, 500)];
    assert_eq!(check(&s, &s.key, ok), Ok(()));
    assert_eq!(s.client().spend_status().spent, 1_000);
}

#[test]
fn cap_resets_next_period() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    let st0 = s.client().spend_status();
    assert_eq!(st0.period_ends_ledger, (st0.period + 1) * PERIOD);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1_000)]), Ok(()));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::CapExceeded));
    // último ledger del período: sigue bloqueado
    s.env.ledger().with_mut(|l| l.sequence_number = st0.period_ends_ledger - 1);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::CapExceeded));
    // primer ledger del período siguiente: acumulado en 0
    s.env.ledger().with_mut(|l| l.sequence_number = st0.period_ends_ledger);
    let st1 = s.client().spend_status();
    assert_eq!(st1.period, st0.period + 1);
    assert_eq!(st1.spent, 0);
    assert_eq!(st1.remaining, 1_000);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1_000)]), Ok(()));
}

#[test]
fn passport_cap_bounds_owner_cap() {
    let s = setup(1_000_000, 500);
    let me = s.account.clone();
    assert_eq!(s.client().spend_status().effective_cap, 500);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 501)]), Err(AccError::CapExceeded));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 500)]), Ok(()));
}

#[test]
fn huge_passport_cap_saturates_to_owner_cap() {
    let s = setup(1_000, 10_000);
    // spend_cap enorme (no entra en i128): manda el tope del dueño
    let huge = U256::from_parts(&s.env, u64::MAX, u64::MAX, u64::MAX, u64::MAX);
    s.validator().set(&s.agent_id(), &huge, &U256::from_u32(&s.env, NULLIFIER));
    assert_eq!(s.client().spend_status().effective_cap, 1_000);
}

#[test]
fn owner_lowers_cap_mid_period() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 600)]), Ok(()));
    s.env.mock_all_auths();
    s.client().set_cap(&500, &PERIOD);
    assert_eq!(s.client().spend_status().remaining, 0);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::CapExceeded));
    s.client().set_cap(&0, &PERIOD);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::CapExceeded));
}

// ---------------------------------------------------------------------------
// Pasaporte: inexistente, borrado o cambiado
// ---------------------------------------------------------------------------
#[test]
#[should_panic]
fn constructor_requires_passport() {
    let s = setup(1_000, 10_000);
    let empty = s.env.register(MockValidator, ());
    s.env.register(
        PassportAccount,
        (s.owner.clone(), pk(&s.env, &s.key), empty, U256::from_u32(&s.env, 99), s.token.clone(), 1_000i128, PERIOD),
    );
}

#[test]
#[should_panic]
fn constructor_rejects_zero_period() {
    let s = setup(1_000, 10_000);
    s.env.register(
        PassportAccount,
        (s.owner.clone(), pk(&s.env, &s.key), s.validator.clone(), s.agent_id(), s.token.clone(), 1_000i128, 0u32),
    );
}

#[test]
#[should_panic]
fn constructor_rejects_negative_cap() {
    let s = setup(1_000, 10_000);
    s.env.register(
        PassportAccount,
        (s.owner.clone(), pk(&s.env, &s.key), s.validator.clone(), s.agent_id(), s.token.clone(), -1i128, PERIOD),
    );
}

#[test]
fn constructor_pins_nullifier() {
    let s = setup(1_000, 10_000);
    let cfg = s.client().config();
    assert_eq!(cfg.nullifier, U256::from_u32(&s.env, NULLIFIER));
    assert_eq!(cfg.agent_id, s.agent_id());
    assert_eq!(cfg.owner, s.owner);
    assert!(!cfg.revoked);
}

#[test]
fn passport_removed_blocks() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    s.validator().clear(&s.agent_id());
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::NoPassport));
    assert_eq!(s.client().try_spend_status(), Err(Ok(AccError::NoPassport)));
}

/// Ataque real (PoC en testnet, tx a7841b5fcbe57f1f945b7a3e6aebeac2a3c6d8cbf4c11a0540bf724dae704877):
/// un tercero registra en el validador otro pasaporte para el mismo agent_id, con
/// otro secreto. Antes la cuenta quedaba en PassportChanged para siempre. Ahora
/// sigue pagando con el spend_cap fijado al crearla, y el tercero no lo puede mover.
#[test]
fn passport_overwrite_by_third_party_neither_bricks_nor_moves_cap() {
    let s = setup(1_000_000, 500);
    let me = s.account.clone();
    // pisa con tope enorme: no sube el tope efectivo
    s.validator().set(&s.agent_id(), &U256::from_u32(&s.env, 1_000_000), &U256::from_u32(&s.env, 8));
    assert_eq!(s.client().spend_status().effective_cap, 500);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 501)]), Err(AccError::CapExceeded));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 300)]), Ok(()));
    // pisa con tope 1: tampoco lo baja ni bloquea la cuenta
    s.validator().set(&s.agent_id(), &U256::from_u32(&s.env, 1), &U256::from_u32(&s.env, 9));
    assert_eq!(s.client().spend_status().effective_cap, 500);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 200)]), Ok(()));
    assert_eq!(s.client().spend_status().remaining, 0);
    // el nullifier fijado no cambia
    assert_eq!(s.client().config().nullifier, U256::from_u32(&s.env, NULLIFIER));
}

#[test]
fn constructor_pins_saturated_passport_cap() {
    let env = Env::default();
    let token = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let validator = env.register(MockValidator, ());
    let agent_id = U256::from_u32(&env, AGENT);
    let huge = U256::from_parts(&env, u64::MAX, u64::MAX, u64::MAX, u64::MAX);
    MockValidatorClient::new(&env, &validator).set(&agent_id, &huge, &U256::from_u32(&env, NULLIFIER));
    let key = SigningKey::generate(&mut rand::thread_rng());
    let account = env.register(
        PassportAccount,
        (Address::generate(&env), pk(&env, &key), validator, agent_id, token, i128::MAX, PERIOD),
    );
    assert_eq!(PassportAccountClient::new(&env, &account).spend_status().effective_cap, i128::MAX);
}

// ---------------------------------------------------------------------------
// Revocación y rotación
// ---------------------------------------------------------------------------
#[test]
fn revoke_blocks_and_rotation_unrevokes() {
    let s = setup(1_000, 10_000);
    s.env.mock_all_auths();
    s.client().revoke();
    assert!(s.client().config().revoked);
    let me = s.account.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::Revoked));
    // rotar la clave des-revoca; la clave vieja ya no sirve
    let new_key = SigningKey::generate(&mut rand::thread_rng());
    s.client().set_agent_key(&pk(&s.env, &new_key));
    assert!(!s.client().config().revoked);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::UnknownSigner));
    assert_eq!(check(&s, &new_key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Ok(()));
}

#[test]
fn owner_functions_emit_events() {
    let s = setup(1_000, 10_000);
    s.env.mock_all_auths();
    s.client().set_cap(&2_000, &50);
    let ev = s.env.events().all();
    assert_eq!(ev.events().len(), 1);
    assert_eq!(ev, [CapSet { cap: 2_000, period_ledgers: 50 }.to_xdr(&s.env, &s.account)]);
    s.client().revoke();
    assert_eq!(s.env.events().all(), [Revoked {}.to_xdr(&s.env, &s.account)]);
    s.client().set_agent_key(&BytesN::from_array(&s.env, &[3u8; 32]));
    assert_eq!(
        s.env.events().all(),
        [AgentKeySet { agent_key: BytesN::from_array(&s.env, &[3u8; 32]) }.to_xdr(&s.env, &s.account)]
    );
}

#[test]
fn check_auth_emits_no_events() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Ok(()));
    assert_eq!(s.env.events().all().events().len(), 0);
}

#[test]
fn set_cap_validates() {
    let s = setup(1_000, 10_000);
    s.env.mock_all_auths();
    assert_eq!(s.client().try_set_cap(&-1, &PERIOD), Err(Ok(AccError::InvalidConfig)));
    assert_eq!(s.client().try_set_cap(&1, &0), Err(Ok(AccError::InvalidConfig)));
    s.client().set_cap(&7, &10);
    let cfg = s.client().config();
    assert_eq!((cfg.cap, cfg.period_ledgers), (7, 10));
}

// ---------------------------------------------------------------------------
// Auth del dueño: sin firma del dueño no se toca nada
// ---------------------------------------------------------------------------
#[test]
fn owner_functions_require_owner_auth() {
    let s = setup(1_000, 10_000);
    let c = s.client();
    // sin ninguna auth
    assert!(c.try_revoke().is_err());
    assert!(c.try_set_cap(&5_000, &PERIOD).is_err());
    assert!(c.try_set_agent_key(&BytesN::random(&s.env)).is_err());
    assert!(c.try_withdraw(&Address::generate(&s.env), &1).is_err());
    assert!(!c.config().revoked);
    assert_eq!(c.config().cap, 1_000);
    // y queda registrado que la auth pedida es la del dueño
    s.env.mock_all_auths();
    c.revoke();
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.owner);
}

#[test]
fn withdraw_by_owner() {
    let s = setup(1_000, 10_000);
    fund(&s, 5_000);
    // el retiro del dueño no está limitado por la lista de destinos del agente
    let to = Address::generate(&s.env);
    assert_eq!(s.client().try_withdraw(&to, &0), Err(Ok(AccError::BadAmount)));
    s.client().withdraw(&to, &2_000);
    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&to), 2_000);
    assert_eq!(t.balance(&s.account), 3_000);
    // el retiro del dueño no consume tope del agente
    assert_eq!(s.client().spend_status().spent, 0);
}

// ---------------------------------------------------------------------------
// Firma y contexto
// ---------------------------------------------------------------------------
#[test]
fn wrong_key_and_wrong_context_blocked() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    let other = SigningKey::generate(&mut rand::thread_rng());
    assert_eq!(check(&s, &other, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::UnknownSigner));
    // otro contrato con la misma función
    let bad = Context::Contract(ContractContext {
        contract: s.validator.clone(),
        fn_name: Symbol::new(&s.env, "transfer"),
        args: vec![&s.env, me.into_val(&s.env), me.into_val(&s.env), 1i128.into_val(&s.env)],
    });
    assert_eq!(check(&s, &s.key, vec![&s.env, bad]), Err(AccError::ContextNotAllowed));
    // otra función del token
    let approve = Context::Contract(ContractContext {
        contract: s.token.clone(),
        fn_name: Symbol::new(&s.env, "approve"),
        args: vec![&s.env, me.into_val(&s.env), me.into_val(&s.env), 1i128.into_val(&s.env)],
    });
    assert_eq!(check(&s, &s.key, vec![&s.env, approve]), Err(AccError::ContextNotAllowed));
    // transfer desde otra dirección
    let stranger = Address::generate(&s.env);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &stranger, 1)]), Err(AccError::ContextNotAllowed));
    // un transfer válido mezclado con uno prohibido: se rechaza todo
    let mixed = vec![&s.env, transfer_ctx(&s, &me, 1), transfer_ctx(&s, &stranger, 1)];
    assert_eq!(check(&s, &s.key, mixed), Err(AccError::ContextNotAllowed));
    // desplegar contratos en nombre de la cuenta
    let create = Context::CreateContractHostFn(CreateContractHostFnContext {
        executable: ContractExecutable::Wasm(BytesN::random(&s.env)),
        salt: BytesN::random(&s.env),
    });
    assert_eq!(check(&s, &s.key, vec![&s.env, create]), Err(AccError::ContextNotAllowed));
    // sin contextos
    assert_eq!(check(&s, &s.key, Vec::new(&s.env)), Err(AccError::ContextNotAllowed));
    assert_eq!(s.client().spend_status().spent, 0);
}

#[test]
fn bad_amounts_blocked() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 0)]), Err(AccError::BadAmount));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, -5)]), Err(AccError::BadAmount));
    let overflow = vec![&s.env, transfer_ctx(&s, &me, i128::MAX), transfer_ctx(&s, &me, 1)];
    assert_eq!(check(&s, &s.key, overflow), Err(AccError::BadAmount));
}

#[test]
fn signature_count_must_be_one() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    let payload = BytesN::random(&s.env);
    let one = sigs_for(&s.env, &s.key, &payload.to_array());
    let mut two = one.clone();
    two.append(&one);
    let ctx = || vec![&s.env, transfer_ctx(&s, &me, 1)];
    assert_eq!(check_with(&s, &payload, Vec::new(&s.env), ctx()), Err(AccError::BadSignatureCount));
    assert_eq!(check_with(&s, &payload, two, ctx()), Err(AccError::BadSignatureCount));
    assert_eq!(check_with(&s, &payload, one, ctx()), Ok(()));
}

#[test]
fn forged_signature_traps() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    let payload = BytesN::random(&s.env);
    // firma de la clave correcta pero sobre otro payload
    let other_payload: BytesN<32> = BytesN::random(&s.env);
    let sigs = sigs_for(&s.env, &s.key, &other_payload.to_array());
    let r = s.env.try_invoke_contract_check_auth::<AccError>(
        &s.account,
        &payload,
        sigs.into_val(&s.env),
        &vec![&s.env, transfer_ctx(&s, &me, 1)],
    );
    assert!(r.is_err());
    assert_ne!(r, Err(Ok(AccError::CapExceeded)));
    assert_eq!(s.client().spend_status().spent, 0);
}

// ---------------------------------------------------------------------------
// Camino real del host: auth entries con nonce (replay, faltante, vencida)
// ---------------------------------------------------------------------------
#[test]
fn real_auth_path_pays_and_enforces_cap() {
    let s = setup(1_000, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    assert!(pay(&s, signed_transfer_entry(&s, &s.key, &to, 600, 1, exp), &to, 600));
    assert!(pay(&s, signed_transfer_entry(&s, &s.key, &to, 400, 2, exp), &to, 400));
    // excede el tope: el transfer falla en el host
    assert!(!pay(&s, signed_transfer_entry(&s, &s.key, &to, 1, 3, exp), &to, 1));
    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&to), 1_000);
    assert_eq!(t.balance(&s.account), 9_000);
    assert_eq!(s.client().spend_status().spent, 1_000);
}

#[test]
fn replay_of_signed_entry_is_rejected() {
    let s = setup(10_000, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    let entry = signed_transfer_entry(&s, &s.key, &to, 100, 77, exp);
    assert!(pay(&s, entry.clone(), &to, 100));
    // mismo auth entry (mismo nonce): el host lo rechaza aunque haya tope
    assert!(!pay(&s, entry, &to, 100));
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 100);
    assert_eq!(s.client().spend_status().spent, 100);
}

#[test]
fn missing_auth_is_rejected() {
    let s = setup(10_000, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    s.env.set_auths(&[]);
    assert!(TokenClient::new(&s.env, &s.token).try_transfer(&s.account, &to, &100).is_err());
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 0);
}

#[test]
fn entry_for_other_amount_or_key_is_rejected() {
    let s = setup(10_000, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    // firmó 100 pero se intenta cobrar 5000
    assert!(!pay(&s, signed_transfer_entry(&s, &s.key, &to, 100, 1, exp), &to, 5_000));
    // firmado por una clave que no es la del agente
    let other = SigningKey::generate(&mut rand::thread_rng());
    assert!(!pay(&s, signed_transfer_entry(&s, &other, &to, 100, 2, exp), &to, 100));
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 0);
}

#[test]
fn expired_entry_is_rejected() {
    let s = setup(10_000, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 5;
    let entry = signed_transfer_entry(&s, &s.key, &to, 100, 1, exp);
    s.env.ledger().with_mut(|l| l.sequence_number += 10);
    assert!(!pay(&s, entry, &to, 100));
}

// ---------------------------------------------------------------------------
// Intentos de saltear el tope por caminos indirectos
// ---------------------------------------------------------------------------

/// Contrato intermediario que mueve fondos de la cuenta llamando al token.
#[contract]
pub struct Wrapper;

#[contractimpl]
impl Wrapper {
    pub fn pay(env: Env, token: Address, from: Address, to: Address, amount: i128) {
        TokenClient::new(&env, &token).transfer(&from, &to, &amount);
    }
}

/// Auth entry con raíz en `Wrapper.pay` y el `transfer` como sub-invocación.
fn signed_wrapped_entry(
    s: &Setup,
    wrapper: &Address,
    to: &Address,
    amount: i128,
    nonce: i64,
    expiration: u32,
) -> xdr::SorobanAuthorizationEntry {
    let env = &s.env;
    let transfer = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: sc_addr(env, &s.token),
            function_name: xdr::ScSymbol("transfer".try_into().unwrap()),
            args: std::vec![to_sc(env, s.account.clone()), to_sc(env, to.clone()), to_sc(env, amount)]
                .try_into()
                .unwrap(),
        }),
        sub_invocations: xdr::VecM::default(),
    };
    let invocation = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: sc_addr(env, wrapper),
            function_name: xdr::ScSymbol("pay".try_into().unwrap()),
            args: std::vec![
                to_sc(env, s.token.clone()),
                to_sc(env, s.account.clone()),
                to_sc(env, to.clone()),
                to_sc(env, amount)
            ]
            .try_into()
            .unwrap(),
        }),
        sub_invocations: std::vec![transfer].try_into().unwrap(),
    };
    let preimage = xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(env.ledger().network_id().to_array()),
        nonce,
        signature_expiration_ledger: expiration,
        invocation: invocation.clone(),
    });
    let bytes = preimage.to_xdr(Limits::none()).unwrap();
    let payload = env.crypto().sha256(&Bytes::from_slice(env, &bytes)).to_array();
    xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: sc_addr(env, &s.account),
            nonce,
            signature_expiration_ledger: expiration,
            signature: to_sc(env, sigs_for(env, &s.key, &payload)),
        }),
        root_invocation: invocation,
    }
}

#[test]
fn transfer_wrapped_in_foreign_contract_is_rejected() {
    let s = setup(10_000, 10_000);
    fund(&s, 10_000);
    let wrapper = s.env.register(Wrapper, ());
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    // el agente firmó "Wrapper.pay -> transfer": el contexto Wrapper.pay no está permitido
    s.env.set_auths(&[signed_wrapped_entry(&s, &wrapper, &to, 100, 1, exp)]);
    let r = WrapperClient::new(&s.env, &wrapper).try_pay(&s.token, &s.account, &to, &100);
    assert!(r.is_err());
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 0);
    assert_eq!(s.client().spend_status().spent, 0);
}

#[test]
fn non_root_transfer_auth_via_wrapper_still_counts_against_cap() {
    // El host acepta un auth entry con raíz en el `transfer` aunque lo llame otro
    // contrato. No es un bypass: pasa por __check_auth y suma al tope igual.
    let s = setup(1_000, 10_000);
    fund(&s, 10_000);
    let wrapper = s.env.register(Wrapper, ());
    let w = WrapperClient::new(&s.env, &wrapper);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    s.env.set_auths(&[signed_transfer_entry(&s, &s.key, &to, 800, 1, exp)]);
    assert!(w.try_pay(&s.token, &s.account, &to, &800).is_ok());
    assert_eq!(s.client().spend_status().spent, 800);
    s.env.set_auths(&[signed_transfer_entry(&s, &s.key, &to, 300, 2, exp)]);
    assert!(w.try_pay(&s.token, &s.account, &to, &300).is_err());
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 800);
}

#[test]
fn many_entries_in_same_ledger_cannot_exceed_cap() {
    // varias auth entries distintas (nonces distintos) en el mismo ledger: el
    // acumulado se comparte, no hay carrera dentro del mismo período.
    let s = setup(1_000, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    let mut paid = 0i128;
    for n in 0..15 {
        if pay(&s, signed_transfer_entry(&s, &s.key, &to, 100, 100 + n, exp), &to, 100) {
            paid += 100;
        }
    }
    assert_eq!(paid, 1_000);
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 1_000);
}

/// Comportamiento conocido (ventana fija, no deslizante): justo antes y justo
/// después del borde del período se puede gastar 2x el tope en 2 ledgers.
#[test]
fn fixed_window_allows_two_caps_across_boundary() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    let end = s.client().spend_status().period_ends_ledger;
    s.env.ledger().with_mut(|l| l.sequence_number = end - 1);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1_000)]), Ok(()));
    s.env.ledger().with_mut(|l| l.sequence_number = end);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1_000)]), Ok(()));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_ctx(&s, &me, 1)]), Err(AccError::CapExceeded));
}

/// Revocar invalida en el acto auth entries ya firmadas y no vencidas.
#[test]
fn revoke_kills_presigned_entries() {
    let s = setup(10_000, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    let entry = signed_transfer_entry(&s, &s.key, &to, 100, 5, exp);
    s.env.mock_all_auths();
    s.client().revoke();
    assert!(!pay(&s, entry.clone(), &to, 100));
    // Ojo (comportamiento conocido): si el dueño "des-revoca" con la MISMA clave,
    // esa entry firmada antes vuelve a servir mientras no venza.
    s.env.mock_all_auths();
    s.client().set_agent_key(&pk(&s.env, &s.key));
    assert!(pay(&s, entry, &to, 100));
}

/// Con la cuenta revocada o sin pasaporte, el dueño igual puede rescatar los fondos.
#[test]
fn owner_can_withdraw_when_revoked_or_passport_gone() {
    let s = setup(1_000, 10_000);
    fund(&s, 5_000);
    let to = Address::generate(&s.env);
    s.client().revoke();
    s.validator().clear(&s.agent_id());
    s.client().withdraw(&to, &5_000);
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 5_000);
}

/// La clave del agente no puede autorizar funciones del dueño sobre la propia cuenta.
#[test]
fn agent_key_cannot_authorize_owner_functions() {
    let s = setup(1_000, 10_000);
    let me = s.account.clone();
    for f in ["set_cap", "revoke", "set_agent_key", "withdraw", "set_payees", "add_payee", "remove_payee"] {
        let ctx = Context::Contract(ContractContext {
            contract: me.clone(),
            fn_name: Symbol::new(&s.env, f),
            args: Vec::new(&s.env),
        });
        assert_eq!(check(&s, &s.key, vec![&s.env, ctx]), Err(AccError::ContextNotAllowed));
    }
}

#[test]
fn revoked_account_cannot_pay_on_real_path() {
    let s = setup(10_000, 10_000);
    fund(&s, 10_000);
    s.client().revoke(); // mock_all_auths sigue activo desde fund()
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    assert!(!pay(&s, signed_transfer_entry(&s, &s.key, &to, 100, 1, exp), &to, 100));
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 0);
}

// ---------------------------------------------------------------------------
// Lista de destinos permitidos (allowlist de `to`)
// ---------------------------------------------------------------------------

/// `transfer_ctx` pero con un destino elegido.
fn transfer_to_ctx(s: &Setup, to: &Address, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: s.token.clone(),
        fn_name: Symbol::new(&s.env, "transfer"),
        args: vec![&s.env, s.account.into_val(&s.env), to.into_val(&s.env), amount.into_val(&s.env)],
    })
}

/// Paga por el camino real del host. Si el `transfer` falla, devuelve el error que
/// `__check_auth` de ESTA cuenta le dio al host. El host lo envuelve en
/// `Error(Auth, InvalidAction)` y deja el código original en el evento de diagnóstico
/// `"failed account authentication with error", <cuenta>, Error(Contract, #n)`, igual
/// que en testnet (sección 7.4 de ARCHITECTURE.md). Exige que ese evento exista.
fn pay_err(
    s: &Setup,
    entry: xdr::SorobanAuthorizationEntry,
    to: &Address,
    amount: i128,
) -> Result<(), soroban_sdk::Error> {
    s.env.set_auths(&[entry]);
    let r = TokenClient::new(&s.env, &s.token).try_transfer(&s.account, to, &amount);
    if r.is_ok() {
        return Ok(());
    }
    let me = sc_addr(&s.env, &s.account);
    // los eventos de diagnóstico que devuelve el host de test son los de la última invocación
    let diags = s.env.host().get_diagnostic_events().unwrap().0;
    for e in diags.iter() {
        let xdr::ContractEventBody::V0(body) = &e.event.body;
        let Some(xdr::ScVal::Error(xdr::ScError::Auth(xdr::ScErrorCode::InvalidAction))) = body.topics.get(1) else {
            continue;
        };
        if let xdr::ScVal::Vec(Some(v)) = &body.data {
            if let [xdr::ScVal::String(msg), xdr::ScVal::Address(a), xdr::ScVal::Error(xdr::ScError::Contract(n))] =
                v.as_slice()
            {
                if msg.as_slice() == b"failed account authentication with error" && *a == me {
                    return Err(soroban_sdk::Error::from_contract_error(*n));
                }
            }
        }
    }
    panic!("el transfer falló sin error de __check_auth de la cuenta: {:?}", r);
}

fn contract_err(e: AccError) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(e as u32)
}

/// HISTORIA A: al agente le hacen prompt injection y firma un pago al atacante.
/// La firma es válida, el monto entra en el tope, y aun así la red lo rechaza.
#[test]
fn hijacked_agent_cannot_pay_attacker_on_real_path() {
    let s = setup(1_000_000, 10_000_000);
    fund(&s, 10_000_000);
    let attacker = Address::generate(&s.env);
    let exp = s.env.ledger().sequence() + 50;
    // el comercio permitido cobra
    assert_eq!(pay_err(&s, signed_transfer_entry(&s, &s.key, &s.payee, 100_000, 1, exp), &s.payee, 100_000), Ok(()));
    // el agente secuestrado firma con SU clave un transfer al atacante, dentro del tope
    let r = pay_err(&s, signed_transfer_entry(&s, &s.key, &attacker, 100_000, 2, exp), &attacker, 100_000);
    std::println!("transfer al atacante por el camino real: {:?}", r);
    assert_eq!(r, Err(contract_err(AccError::PayeeNotAllowed)));
    let t = TokenClient::new(&s.env, &s.token);
    assert_eq!(t.balance(&attacker), 0);
    assert_eq!(t.balance(&s.payee), 100_000);
    // el intento rechazado no consume tope
    assert_eq!(s.client().spend_status().spent, 100_000);
}

#[test]
fn check_auth_rejects_non_payee_with_typed_error() {
    let s = setup(1_000, 10_000);
    let attacker = Address::generate(&s.env);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &attacker, 1)]), Err(AccError::PayeeNotAllowed));
    // el dueño tampoco es destino si no lo agregó
    let owner = s.owner.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &owner, 1)]), Err(AccError::PayeeNotAllowed));
    // la propia cuenta tampoco
    let me = s.account.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &me, 1)]), Err(AccError::PayeeNotAllowed));
    let payee = s.payee.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &payee, 1)]), Ok(()));
    assert_eq!(s.client().spend_status().spent, 1);
}

#[test]
fn mixed_allowed_and_forbidden_payees_reject_whole_auth() {
    let s = setup(1_000, 10_000);
    let attacker = Address::generate(&s.env);
    let payee = s.payee.clone();
    let mixed = vec![&s.env, transfer_to_ctx(&s, &payee, 1), transfer_to_ctx(&s, &attacker, 1)];
    assert_eq!(check(&s, &s.key, mixed), Err(AccError::PayeeNotAllowed));
    assert_eq!(s.client().spend_status().spent, 0);
}

#[test]
fn empty_payee_list_blocks_every_payment() {
    let s = setup(1_000, 10_000);
    owner_call(&s, "set_payees", (Vec::<Address>::new(&s.env),).into_val(&s.env));
    s.client().set_payees(&Vec::new(&s.env));
    assert_eq!(s.client().payees().len(), 0);
    let payee = s.payee.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &payee, 1)]), Err(AccError::PayeeNotAllowed));
}

#[test]
fn fresh_account_has_no_payees() {
    // la cuenta recién creada (como la crea la factory) no paga hasta que el dueño agregue destinos
    let s = setup(1_000, 10_000);
    let fresh = s.env.register(
        PassportAccount,
        (s.owner.clone(), pk(&s.env, &s.key), s.validator.clone(), s.agent_id(), s.token.clone(), 1_000i128, PERIOD),
    );
    let c = PassportAccountClient::new(&s.env, &fresh);
    assert_eq!(c.payees().len(), 0);
    assert!(!c.is_payee(&s.payee));
}

#[test]
fn payee_admin_is_owner_only() {
    let s = setup(1_000, 10_000);
    let c = s.client();
    let attacker = Address::generate(&s.env);
    // sin ninguna auth
    assert!(c.try_add_payee(&attacker).is_err());
    assert!(c.try_set_payees(&vec![&s.env, attacker.clone()]).is_err());
    assert!(c.try_remove_payee(&s.payee).is_err());
    // con la auth de otra dirección (el atacante firmando por sí mismo)
    s.env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &s.account,
            fn_name: "add_payee",
            args: (attacker.clone(),).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(c.try_add_payee(&attacker).is_err());
    assert_eq!(c.payees(), vec![&s.env, s.payee.clone()]);
    // con la auth del dueño sí, y la auth pedida es exactamente la del dueño
    owner_call(&s, "add_payee", (attacker.clone(),).into_val(&s.env));
    c.add_payee(&attacker);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.owner);
    assert!(c.is_payee(&attacker));
}

#[test]
fn add_remove_set_semantics_and_events() {
    let s = setup(1_000, 10_000);
    s.env.mock_all_auths();
    let c = s.client();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);
    c.add_payee(&a);
    assert_eq!(
        s.env.events().all(),
        [PayeesSet { payees: vec![&s.env, s.payee.clone(), a.clone()] }.to_xdr(&s.env, &s.account)]
    );
    c.add_payee(&a); // idempotente
    assert_eq!(c.payees(), vec![&s.env, s.payee.clone(), a.clone()]);
    c.remove_payee(&s.payee);
    assert_eq!(c.payees(), vec![&s.env, a.clone()]);
    c.remove_payee(&s.payee); // no estaba: no cambia
    assert_eq!(c.payees(), vec![&s.env, a.clone()]);
    c.set_payees(&vec![&s.env, b.clone(), b.clone(), a.clone()]); // repetidos se ignoran
    assert_eq!(c.payees(), vec![&s.env, b.clone(), a.clone()]);
    // tope de tamaño de la lista
    let mut many = Vec::new(&s.env);
    for _ in 0..(MAX_PAYEES + 1) {
        many.push_back(Address::generate(&s.env));
    }
    assert_eq!(c.try_set_payees(&many), Err(Ok(AccError::InvalidConfig)));
    assert_eq!(c.payees(), vec![&s.env, b.clone(), a.clone()]);
    many.pop_back();
    c.set_payees(&many);
    assert_eq!(c.payees().len(), MAX_PAYEES);
    assert_eq!(c.try_add_payee(&Address::generate(&s.env)), Err(Ok(AccError::InvalidConfig)));
}

#[test]
fn payee_check_combines_with_cap() {
    let s = setup(1_000, 10_000);
    let attacker = Address::generate(&s.env);
    let payee = s.payee.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &payee, 900)]), Ok(()));
    // permitido pero por encima del tope: CapExceeded
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &payee, 200)]), Err(AccError::CapExceeded));
    // no permitido y por encima del tope: lo para la lista antes que el tope
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &attacker, 200)]), Err(AccError::PayeeNotAllowed));
    // no permitido y dentro del tope: igual se rechaza
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &attacker, 100)]), Err(AccError::PayeeNotAllowed));
    assert_eq!(s.client().spend_status().spent, 900);
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &payee, 100)]), Ok(()));
}

#[test]
fn payee_check_combines_with_revocation() {
    let s = setup(1_000, 10_000);
    s.env.mock_all_auths();
    s.client().revoke();
    let payee = s.payee.clone();
    let attacker = Address::generate(&s.env);
    // revocada: la revocación manda, aun para el comercio permitido
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &payee, 1)]), Err(AccError::Revoked));
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &attacker, 1)]), Err(AccError::Revoked));
    // rotar la clave des-revoca pero no abre destinos nuevos
    let new_key = SigningKey::generate(&mut rand::thread_rng());
    s.client().set_agent_key(&pk(&s.env, &new_key));
    assert_eq!(check(&s, &new_key, vec![&s.env, transfer_to_ctx(&s, &attacker, 1)]), Err(AccError::PayeeNotAllowed));
    assert_eq!(check(&s, &new_key, vec![&s.env, transfer_to_ctx(&s, &payee, 1)]), Ok(()));
}

/// Sacar un destino invalida en el acto auth entries ya firmadas hacia él.
#[test]
fn removing_payee_kills_presigned_entries() {
    let s = setup(10_000, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    let entry = signed_transfer_entry(&s, &s.key, &to, 100, 5, exp);
    owner_call(&s, "remove_payee", (to.clone(),).into_val(&s.env));
    s.client().remove_payee(&to);
    assert_eq!(pay_err(&s, entry, &to, 100), Err(contract_err(AccError::PayeeNotAllowed)));
    assert_eq!(TokenClient::new(&s.env, &s.token).balance(&to), 0);
}

#[test]
fn allowed_payee_still_capped_on_real_path() {
    // tope y lista por el camino real: el comercio cobra hasta el tope, después CapExceeded
    let s = setup(300, 10_000);
    fund(&s, 10_000);
    let to = s.payee.clone();
    let exp = s.env.ledger().sequence() + 50;
    for n in 0..3 {
        assert_eq!(pay_err(&s, signed_transfer_entry(&s, &s.key, &to, 100, n, exp), &to, 100), Ok(()));
    }
    assert_eq!(
        pay_err(&s, signed_transfer_entry(&s, &s.key, &to, 100, 9, exp), &to, 100),
        Err(contract_err(AccError::CapExceeded))
    );
}

fn muxed_val(env: &Env, g: &str, id: u64) -> Val {
    let a = Address::from_str(env, g);
    let ed = match sc_addr(env, &a) {
        xdr::ScAddress::Account(xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(k))) => k,
        _ => unreachable!(),
    };
    let sc = xdr::ScVal::Address(xdr::ScAddress::MuxedAccount(xdr::MuxedEd25519Account { id, ed25519: ed }));
    Val::try_from_val(env, &sc).unwrap()
}

#[test]
fn muxed_destination_counts_as_its_base_account() {
    let s = setup(1_000, 10_000);
    let merchant_g = "GCLNNJKDE7YK5BYOCIW3SOZW7NBPBCKPKXONLRYVUQRO5VZCGLVCVPPJ";
    let other_g = "GCTAWGDLELL4VWAV7L57GVIL472CX6NMLFDRQ67EZ4LTSJFDN7UCSJYT";
    owner_call(&s, "add_payee", (Address::from_str(&s.env, merchant_g),).into_val(&s.env));
    s.client().add_payee(&Address::from_str(&s.env, merchant_g));
    let ctx = |to: Val| {
        Context::Contract(ContractContext {
            contract: s.token.clone(),
            fn_name: Symbol::new(&s.env, "transfer"),
            args: vec![&s.env, s.account.into_val(&s.env), to, 1i128.into_val(&s.env)],
        })
    };
    assert_eq!(check(&s, &s.key, vec![&s.env, ctx(muxed_val(&s.env, merchant_g, 7))]), Ok(()));
    assert_eq!(check(&s, &s.key, vec![&s.env, ctx(muxed_val(&s.env, other_g, 7))]), Err(AccError::PayeeNotAllowed));
    // `to` que no es una dirección
    assert_eq!(check(&s, &s.key, vec![&s.env, ctx(5u32.into_val(&s.env))]), Err(AccError::PayeeNotAllowed));
}

#[test]
fn payee_admin_does_not_touch_spent_or_config() {
    let s = setup(1_000, 10_000);
    let payee = s.payee.clone();
    assert_eq!(check(&s, &s.key, vec![&s.env, transfer_to_ctx(&s, &payee, 400)]), Ok(()));
    let before = s.client().config();
    s.env.mock_all_auths();
    s.client().add_payee(&Address::generate(&s.env));
    s.client().remove_payee(&payee);
    s.client().add_payee(&payee);
    assert_eq!(s.client().config(), before);
    assert_eq!(s.client().spend_status().spent, 400);
}

/// Código que devolvió `__check_auth` de ESTA cuenta en la última invocación, si lo hubo
/// (evento de diagnóstico `"failed account authentication with error", <cuenta>, Error(Contract, #n)`).
fn account_auth_error(s: &Setup) -> Option<u32> {
    let me = sc_addr(&s.env, &s.account);
    let diags = s.env.host().get_diagnostic_events().unwrap().0;
    for e in diags.iter() {
        let xdr::ContractEventBody::V0(body) = &e.event.body;
        if let xdr::ScVal::Vec(Some(v)) = &body.data {
            if let [xdr::ScVal::String(msg), xdr::ScVal::Address(a), xdr::ScVal::Error(xdr::ScError::Contract(n))] =
                v.as_slice()
            {
                if msg.as_slice() == b"failed account authentication with error" && *a == me {
                    return Some(*n);
                }
            }
        }
    }
    None
}

/// Ojo al leer códigos: `PayeeNotAllowed` (#10) tiene el mismo número que `BalanceError`
/// de la SAC. Los dos le llegan al cliente como `Error(Contract, #10)`. Lo que los distingue
/// es el evento "failed account authentication", que solo aparece si el código lo devolvió
/// `__check_auth` de la cuenta (mismo criterio que `--force-onchain`, sección 7.4).
#[test]
fn code_10_from_sac_balance_is_not_attributed_to_account() {
    let s = setup(1_000_000, 10_000_000); // la cuenta no tiene saldo
    let to = s.payee.clone();
    let attacker = Address::generate(&s.env);
    let exp = s.env.ledger().sequence() + 50;
    // destino permitido y sin saldo: lo rechaza la SAC (BalanceError = 10), no la cuenta
    s.env.set_auths(&[signed_transfer_entry(&s, &s.key, &to, 100, 1, exp)]);
    let r = TokenClient::new(&s.env, &s.token).try_transfer(&s.account, &to, &100);
    assert_eq!(r, Err(Ok(soroban_sdk::Error::from_contract_error(10))));
    assert_eq!(account_auth_error(&s), None);
    assert_eq!(s.client().spend_status().spent, 0);
    // destino no permitido: mismo número, pero atribuido a la cuenta
    assert_eq!(
        pay_err(&s, signed_transfer_entry(&s, &s.key, &attacker, 100, 2, exp), &attacker, 100),
        Err(contract_err(AccError::PayeeNotAllowed))
    );
}
