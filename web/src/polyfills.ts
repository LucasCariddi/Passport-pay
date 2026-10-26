// stellar-sdk y el prover de OSP usan Buffer como global. Este módulo se
// importa primero en main.tsx para que exista antes de cargar el resto.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
