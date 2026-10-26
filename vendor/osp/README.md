# vendor/osp: open-stellar-passport (libreria previa)

Copia sin modificar de archivos de
[Bitcoindefi/open-stellar-passport](https://github.com/Bitcoindefi/open-stellar-passport),
commit `9cb82e4464958d801ff065ff119f6e9f2324efc8` (26 ago 2026).
Licencia de origen: Apache-2.0 (ver `LICENSE` y `NOTICE` de esta carpeta).
El resto de Passport Pay es MIT; estos archivos siguen bajo Apache-2.0.

| Archivo | Origen |
|---|---|
| `sdk/src/prover.ts`, `sdk/src/PassportClient.ts`, `sdk/src/snarkjs.d.ts` | `sdk/src/` |
| `sdk/bindings/src/index.ts` | `sdk/bindings/src/` |
| `zk/*` (circuito, zkey, vkey, prueba de ejemplo) | `frontend/public/zk/` |

Ojo: los bindings se generaron contra la version NUEVA del validador (con
`verify_batch`, allow-list de raices, auditoria). El validador desplegado en testnet
(`CDNSZUNE...VRFYBA`) es una version anterior: solo expone `init`, `verifier`,
`set_verifier`, `get_passport`, `is_registered`, `is_nullifier_used` y
`verify_and_register`, y sus errores van del 1 al 5. No tiene `revoke`.
