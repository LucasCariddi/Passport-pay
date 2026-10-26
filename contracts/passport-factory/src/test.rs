#![cfg(test)]
//! Tests de la factory contra los wasm REALES desplegados en testnet del validador y
//! el verificador de open-stellar-passport, con una prueba Groth16 real (agente #42).
//! El wasm de la cuenta sale de `stellar contract build` (correrlo antes de `cargo test`).
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    xdr::{self, Limits, WriteXdr},
    Event, TryFromVal,
};
use std::string::String;

mod account {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/passport_account.wasm");
}
mod verifier {
    soroban_sdk::contractimport!(file = "../osp-wasm/circom_groth16_verifier.deployed.wasm");
}

const PROOF_JSON: &str = include_str!("../../osp-wasm/fixtures/proof_agent42.json");
const PUBLIC_JSON: &str = include_str!("../../osp-wasm/fixtures/public_agent42.json");
const PERIOD: u32 = 100;

// ---------------------------------------------------------------------------
// Fixture de la prueba real
// ---------------------------------------------------------------------------
fn hex_bytes(h: &str) -> std::vec::Vec<u8> {
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()
}

fn json_field(json: &str, key: &str) -> String {
    let pat = std::format!("\"{key}\":\"");
    let start = json.find(&pat).unwrap() + pat.len();
    let end = json[start..].find('"').unwrap() + start;
    json[start..end].into()
}

/// Decimal (hasta 256 bits) a 32 bytes big endian.
fn dec_to_be32(dec: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for ch in dec.bytes() {
        let mut carry = (ch - b'0') as u32;
        for b in out.iter_mut().rev() {
            let v = (*b as u32) * 10 + carry;
            *b = (v & 0xff) as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0, "overflow");
    }
    out
}

fn u256_dec(env: &Env, dec: &str) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &dec_to_be32(dec)))
}

fn real_proof(env: &Env) -> (Groth16Proof, Vec<U256>) {
    let a: [u8; 64] = hex_bytes(&json_field(PROOF_JSON, "a")).try_into().unwrap();
    let b: [u8; 128] = hex_bytes(&json_field(PROOF_JSON, "b")).try_into().unwrap();
    let c: [u8; 64] = hex_bytes(&json_field(PROOF_JSON, "c")).try_into().unwrap();
    let proof = Groth16Proof {
        a: BytesN::from_array(env, &a),
        b: BytesN::from_array(env, &b),
        c: BytesN::from_array(env, &c),
    };
    let mut inputs = Vec::new(env);
    for part in PUBLIC_JSON.trim().trim_start_matches('[').trim_end_matches(']').split(',') {
        inputs.push_back(u256_dec(env, part.trim().trim_matches('"')));
    }
    (proof, inputs)
}

// ---------------------------------------------------------------------------
// Entorno: token + verificador real + validador real + factory
// ---------------------------------------------------------------------------
struct Setup {
    env: Env,
    admin: Address,
    owner: Address,
    token: Address,
    validator: Address,
    factory: Address,
    key: SigningKey,
}

impl Setup {
    fn f(&self) -> PassportFactoryClient<'_> {
        PassportFactoryClient::new(&self.env, &self.factory)
    }
    fn v(&self) -> validator::Client<'_> {
        validator::Client::new(&self.env, &self.validator)
    }
    fn agent_key(&self) -> BytesN<32> {
        BytesN::from_array(&self.env, &self.key.verifying_key().to_bytes())
    }
    fn agent42(&self) -> U256 {
        U256::from_u32(&self.env, 42)
    }
}

fn setup() -> Setup {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let verifier_id = env.register(verifier::WASM, ());
    let validator = env.register(validator::WASM, ());
    env.mock_all_auths();
    validator::Client::new(&env, &validator).init(&admin, &verifier_id);
    let account_wasm = env.deployer().upload_contract_wasm(account::WASM);
    let factory = env.register(
        PassportFactory,
        (admin.clone(), validator.clone(), account_wasm, token.clone()),
    );
    env.set_auths(&[]);
    let key = SigningKey::generate(&mut rand::thread_rng());
    Setup { env, admin, owner, token, validator, factory, key }
}

/// Registro con auth del dueño (solo la del dueño, nada de mock_all_auths).
fn register_as_owner(
    s: &Setup,
    proof: &Groth16Proof,
    inputs: &Vec<U256>,
    cap: i128,
) -> Result<Result<Address, soroban_sdk::ConversionError>, Result<FactoryError, soroban_sdk::InvokeError>> {
    let key = s.agent_key();
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke {
            contract: &s.factory,
            fn_name: "register",
            args: (s.owner.clone(), key.clone(), proof.clone(), inputs.clone(), cap, PERIOD).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.f().try_register(&s.owner, &key, proof, inputs, &cap, &PERIOD)
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------
#[test]
fn register_with_real_proof_deploys_account() {
    let s = setup();
    let (proof, inputs) = real_proof(&s.env);
    let predicted = s.f().predict_account(&s.agent42());
    let acc = register_as_owner(&s, &proof, &inputs, 1_000).unwrap().unwrap();
    assert_eq!(acc, predicted);

    // el validador real quemó el nullifier y guardó el pasaporte
    assert!(s.v().is_registered(&s.agent42()));
    assert!(s.v().is_nullifier_used(&inputs.get_unchecked(1)));
    let att = s.v().get_passport(&s.agent42()).unwrap();
    assert_eq!(att.spend_cap, U256::from_u32(&s.env, 500_000_000));

    // índices de la factory
    assert_eq!(s.f().account_of(&s.agent42()), Some(acc.clone()));
    assert_eq!(s.f().agent_of(&acc), Some(s.agent42()));
    assert!(s.f().is_account(&acc));
    assert!(!s.f().is_account(&Address::generate(&s.env)));
    assert!(!s.f().is_account(&s.owner));

    // la cuenta quedó bien configurada y lee el pasaporte real (tipos compatibles)
    let a = account::Client::new(&s.env, &acc);
    let cfg = a.config();
    assert_eq!(cfg.owner, s.owner);
    assert_eq!(cfg.agent_key, s.agent_key());
    assert_eq!(cfg.validator, s.validator);
    assert_eq!(cfg.token, s.token);
    assert_eq!(cfg.agent_id, s.agent42());
    assert_eq!(cfg.nullifier, inputs.get_unchecked(1));
    assert_eq!((cfg.cap, cfg.period_ledgers, cfg.revoked), (1_000, PERIOD, false));
    let st = a.spend_status();
    assert_eq!((st.spent, st.effective_cap, st.remaining), (0, 1_000, 1_000));
}

#[test]
fn register_emits_account_created() {
    let s = setup();
    let (proof, inputs) = real_proof(&s.env);
    let acc = register_as_owner(&s, &proof, &inputs, 1_000).unwrap().unwrap();
    let mine = s.env.events().all().filter_by_contract(&s.factory);
    assert_eq!(
        mine,
        [AccountCreated { owner: s.owner.clone(), agent_id: s.agent42(), account: acc, adopted: false }
            .to_xdr(&s.env, &s.factory)]
    );
}

#[test]
fn register_requires_owner_auth() {
    let s = setup();
    let (proof, inputs) = real_proof(&s.env);
    // sin ninguna auth
    let r = s.f().try_register(&s.owner, &s.agent_key(), &proof, &inputs, &1_000, &PERIOD);
    assert!(r.is_err());
    // firmado por otro que no es el owner declarado
    let mallory = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &mallory,
        invoke: &MockAuthInvoke {
            contract: &s.factory,
            fn_name: "register",
            args: (s.owner.clone(), s.agent_key(), proof.clone(), inputs.clone(), 1_000i128, PERIOD).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.f().try_register(&s.owner, &s.agent_key(), &proof, &inputs, &1_000, &PERIOD).is_err());
    // nada quedó registrado
    assert!(!s.v().is_registered(&s.agent42()));
    assert_eq!(s.f().account_of(&s.agent42()), None);
}

#[test]
fn register_same_agent_twice_is_taken() {
    let s = setup();
    let (proof, inputs) = real_proof(&s.env);
    register_as_owner(&s, &proof, &inputs, 1_000).unwrap().unwrap();
    assert_eq!(register_as_owner(&s, &proof, &inputs, 1_000), Err(Ok(FactoryError::AgentTaken)));
}

#[test]
fn register_spent_nullifier_is_rejected() {
    let s = setup();
    let (proof, inputs) = real_proof(&s.env);
    // alguien manda la prueba directo al validador (front-run) sin pasar por la factory
    s.v().verify_and_register(&validator::Groth16Proof { a: proof.a.clone(), b: proof.b.clone(), c: proof.c.clone() }, &inputs);
    assert_eq!(register_as_owner(&s, &proof, &inputs, 1_000), Err(Ok(FactoryError::NullifierUsed)));
    // el admin todavía puede rescatarlo con adopt
    s.env.mock_all_auths();
    let acc = s.f().adopt(&s.owner, &s.agent_key(), &s.agent42(), &1_000, &PERIOD);
    assert!(s.f().is_account(&acc));
}

#[test]
fn register_tampered_proof_is_rejected() {
    let s = setup();
    let (proof, inputs) = real_proof(&s.env);
    // spend_cap inflado: la prueba deja de cerrar
    let mut bigger = inputs.clone();
    bigger.set(3, U256::from_u128(&s.env, 1_000_000_000_000));
    assert_eq!(register_as_owner(&s, &proof, &bigger, 1_000), Err(Ok(FactoryError::ProofRejected)));
    // otro agent_id con la misma prueba
    let mut other = inputs.clone();
    other.set(2, U256::from_u32(&s.env, 43));
    assert_eq!(register_as_owner(&s, &proof, &other, 1_000), Err(Ok(FactoryError::ProofRejected)));
    // un byte de la prueba cambiado
    let mut c = proof.c.to_array();
    c[63] ^= 1;
    let bad = Groth16Proof { c: BytesN::from_array(&s.env, &c), ..proof.clone() };
    assert!(matches!(
        register_as_owner(&s, &bad, &inputs, 1_000),
        Err(Ok(FactoryError::ProofRejected))
    ));
    assert!(!s.v().is_registered(&s.agent42()));
    assert!(!s.v().is_registered(&U256::from_u32(&s.env, 43)));
    // después de todo eso la prueba buena sigue sirviendo
    register_as_owner(&s, &proof, &inputs, 1_000).unwrap().unwrap();
}

#[test]
fn register_validates_inputs_and_config() {
    let s = setup();
    let (proof, inputs) = real_proof(&s.env);
    let mut three = inputs.clone();
    three.pop_back();
    assert_eq!(register_as_owner(&s, &proof, &three, 1_000), Err(Ok(FactoryError::BadPublicInputs)));
    assert_eq!(register_as_owner(&s, &proof, &inputs, -1), Err(Ok(FactoryError::InvalidConfig)));
    let key = s.agent_key();
    s.env.mock_all_auths();
    assert_eq!(
        s.f().try_register(&s.owner, &key, &proof, &inputs, &1_000, &0),
        Err(Ok(FactoryError::InvalidConfig))
    );
    assert!(!s.v().is_registered(&s.agent42()));
}

// ---------------------------------------------------------------------------
// adopt
// ---------------------------------------------------------------------------
fn preregister(s: &Setup) {
    let (proof, inputs) = real_proof(&s.env);
    s.v().verify_and_register(&validator::Groth16Proof { a: proof.a, b: proof.b, c: proof.c }, &inputs);
}

#[test]
fn adopt_by_admin_only() {
    let s = setup();
    preregister(&s);
    // sin auth
    assert!(s.f().try_adopt(&s.owner, &s.agent_key(), &s.agent42(), &1_000, &PERIOD).is_err());
    // con auth del owner (no del admin)
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke {
            contract: &s.factory,
            fn_name: "adopt",
            args: (s.owner.clone(), s.agent_key(), s.agent42(), 1_000i128, PERIOD).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.f().try_adopt(&s.owner, &s.agent_key(), &s.agent42(), &1_000, &PERIOD).is_err());
    // con auth del admin
    s.env.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.factory,
            fn_name: "adopt",
            args: (s.owner.clone(), s.agent_key(), s.agent42(), 1_000i128, PERIOD).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    let acc = s.f().adopt(&s.owner, &s.agent_key(), &s.agent42(), &1_000, &PERIOD);
    let mine = s.env.events().all().filter_by_contract(&s.factory);
    assert_eq!(
        mine,
        [AccountCreated { owner: s.owner.clone(), agent_id: s.agent42(), account: acc.clone(), adopted: true }
            .to_xdr(&s.env, &s.factory)]
    );
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert!(s.f().is_account(&acc));
    assert_eq!(account::Client::new(&s.env, &acc).config().owner, s.owner);
}

#[test]
fn adopt_requires_passport_and_free_agent() {
    let s = setup();
    s.env.mock_all_auths();
    assert_eq!(
        s.f().try_adopt(&s.owner, &s.agent_key(), &s.agent42(), &1_000, &PERIOD),
        Err(Ok(FactoryError::NoPassport))
    );
    preregister(&s);
    assert_eq!(
        s.f().try_adopt(&s.owner, &s.agent_key(), &s.agent42(), &-5, &PERIOD),
        Err(Ok(FactoryError::InvalidConfig))
    );
    s.f().adopt(&s.owner, &s.agent_key(), &s.agent42(), &1_000, &PERIOD);
    assert_eq!(
        s.f().try_adopt(&s.owner, &s.agent_key(), &s.agent42(), &1_000, &PERIOD),
        Err(Ok(FactoryError::AgentTaken))
    );
}

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------
#[test]
fn admin_functions() {
    let s = setup();
    assert_eq!(s.f().admin(), s.admin);
    let new_hash = BytesN::from_array(&s.env, &[7u8; 32]);
    assert!(s.f().try_set_account_wasm(&new_hash).is_err());
    let new_admin = Address::generate(&s.env);
    assert!(s.f().try_set_admin(&new_admin).is_err());
    s.env.mock_all_auths();
    s.f().set_account_wasm(&new_hash);
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert_eq!(s.f().config().account_wasm_hash, new_hash);
    s.f().set_admin(&new_admin);
    assert_eq!(s.f().admin(), new_admin);
    s.f().bump(&s.agent42()); // no falla aunque no haya cuenta
}

// ---------------------------------------------------------------------------
// Punta a punta: cuenta creada por la factory paga por el camino real del host
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

fn signed_transfer(s: &Setup, acc: &Address, to: &Address, amount: i128, nonce: i64) -> xdr::SorobanAuthorizationEntry {
    let env = &s.env;
    let exp = env.ledger().sequence() + 50;
    let invocation = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: sc_addr(env, &s.token),
            function_name: xdr::ScSymbol("transfer".try_into().unwrap()),
            args: std::vec![to_sc(env, acc.clone()), to_sc(env, to.clone()), to_sc(env, amount)]
                .try_into()
                .unwrap(),
        }),
        sub_invocations: xdr::VecM::default(),
    };
    let preimage = xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(env.ledger().network_id().to_array()),
        nonce,
        signature_expiration_ledger: exp,
        invocation: invocation.clone(),
    });
    let payload = env.crypto().sha256(&Bytes::from_slice(env, &preimage.to_xdr(Limits::none()).unwrap())).to_array();
    let sig = s.key.sign(&payload).to_bytes();
    let sigs = soroban_sdk::vec![
        env,
        account::Ed25519Signature { public_key: s.agent_key(), signature: BytesN::from_array(env, &sig) }
    ];
    xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: sc_addr(env, acc),
            nonce,
            signature_expiration_ledger: exp,
            signature: to_sc(env, sigs),
        }),
        root_invocation: invocation,
    }
}

/// Código que `__check_auth` de `acc` le devolvió al host en la última invocación
/// (evento de diagnóstico "failed account authentication with error", igual que en testnet).
fn account_auth_error(env: &Env, acc: &Address) -> Option<u32> {
    let me = sc_addr(env, acc);
    for e in env.host().get_diagnostic_events().unwrap().0.iter() {
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

#[test]
fn factory_account_pays_until_cap_then_fails() {
    let s = setup();
    let (proof, inputs) = real_proof(&s.env);
    let acc = register_as_owner(&s, &proof, &inputs, 300_000).unwrap().unwrap(); // 0.03 USDC
    s.env.mock_all_auths();
    StellarAssetClient::new(&s.env, &s.token).mint(&acc, &10_000_000);
    let merchant = Address::generate(&s.env);
    let t = TokenClient::new(&s.env, &s.token);
    // la cuenta nueva no tiene destinos: hasta que el dueño agregue el comercio, no paga
    s.env.set_auths(&[signed_transfer(&s, &acc, &merchant, 100_000, 100)]);
    assert!(t.try_transfer(&acc, &merchant, &100_000).is_err());
    assert_eq!(account_auth_error(&s.env, &acc), Some(10)); // PayeeNotAllowed
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke {
            contract: &acc,
            fn_name: "add_payee",
            args: (merchant.clone(),).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    account::Client::new(&s.env, &acc).add_payee(&merchant);
    // a un destino no permitido, firmado por la clave del agente y dentro del tope: PayeeNotAllowed (#10)
    let attacker = Address::generate(&s.env);
    s.env.set_auths(&[signed_transfer(&s, &acc, &attacker, 100_000, 101)]);
    assert!(t.try_transfer(&acc, &attacker, &100_000).is_err());
    assert_eq!(account_auth_error(&s.env, &acc), Some(10)); // PayeeNotAllowed
    assert_eq!(t.balance(&attacker), 0);
    for n in 0..3 {
        s.env.set_auths(&[signed_transfer(&s, &acc, &merchant, 100_000, n)]);
        t.transfer(&acc, &merchant, &100_000);
    }
    s.env.set_auths(&[signed_transfer(&s, &acc, &merchant, 100_000, 9)]);
    assert!(t.try_transfer(&acc, &merchant, &100_000).is_err());
    assert_eq!(account_auth_error(&s.env, &acc), Some(6)); // CapExceeded
    assert_eq!(t.balance(&merchant), 300_000);
    let st = account::Client::new(&s.env, &acc).spend_status();
    assert_eq!((st.spent, st.remaining), (300_000, 0));
}
