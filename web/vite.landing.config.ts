import { defineConfig } from "vite";
import { resolve } from "node:path";
// @ts-expect-error plain ESM helper without type declarations
import { landingSite } from "./landing/build/site.mjs";

// Landing pública (/) y docs (/docs/*): sitio estático aparte de la web app.
// La app sigue con vite.config.ts y se compila con WEB_BASE=/app/; este build sale a
// web/dist-landing y build-vercel.sh lo copia a la raíz de public/ (ver docs/DEPLOY.md).
export default defineConfig({
  root: resolve(import.meta.dirname, "landing"),
  base: "/",
  publicDir: resolve(import.meta.dirname, "landing/public"),
  plugins: [landingSite()],
  build: {
    outDir: resolve(import.meta.dirname, "dist-landing"),
    emptyOutDir: true,
    target: "es2022",
  },
  server: { host: "0.0.0.0", port: 5174, strictPort: false },
  preview: { host: "0.0.0.0", port: 4174 },
});
