/// <reference types="vite/client" />

// Buffer lo pone src/polyfills.ts como global (paquete "buffer").
declare global {
  var Buffer: typeof import("buffer").Buffer;
  type Buffer = import("buffer").Buffer;
}

export {};
