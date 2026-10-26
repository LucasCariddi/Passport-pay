// Función de Vercel: el servidor x402 + facilitador de Passport Pay (Express) entero.
// vercel.json reescribe /api/*, /catalog y /health a esta función; Express recibe la URL
// original y rutea igual que en local. Ver docs/DEPLOY.md.
//
// Singleton por instancia: la app se arma una vez y se reusa entre pedidos (Fluid compute),
// así la cola de settles y el mutex de la demo sirven dentro de la instancia.
// En Vercel no hay .env: la config sale de las env vars del proyecto y de deploy/*.
import { buildServerApp } from "../server/src/index.mjs";

const { app } = buildServerApp();

// El rewrite `/api/:path*` le agrega `?path=...` a la URL. Ninguna ruta usa `path`, así que
// se saca para que el `resource.url` del 402 quede igual a la URL que pidió el agente.
export default function handler(req, res) {
  if (req.url.includes("path=")) {
    const u = new URL(req.url, "http://x");
    u.searchParams.delete("path");
    req.url = u.pathname + u.search;
  }
  return app(req, res);
}
