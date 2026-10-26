// Servidor estático local que imita las rutas de Vercel para lo que no es la API:
//   /presentacion -> site/presentacion/index.html
//   /notas        -> site/notas/index.html
//   /media/*      -> web/public/media/*   (en Vercel: rewrite a /app/media/*)
//   /*            -> site/*
// Uso: node scripts/serve-site.mjs [puerto]   (por defecto 4180, escucha en 127.0.0.1)
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.argv[2] ?? 4180);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".json": "application/json",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function safe(base, rel) {
  const p = normalize(join(base, rel));
  return p === base || p.startsWith(base + sep) ? p : null;
}

function resolvePath(pathname) {
  if (pathname.startsWith("/media/")) return safe(join(root, "web/public/media"), pathname.slice(7));
  const site = join(root, "site");
  const p = safe(site, pathname);
  if (!p) return null;
  try {
    if (statSync(p).isDirectory()) return join(p, "index.html");
    return p;
  } catch {
    try { statSync(p + ".html"); return p + ".html"; } catch { return p; }
  }
}

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // como Vercel con trailingSlash: false
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    res.writeHead(308, { Location: url.pathname.slice(0, -1) + url.search }); return res.end();
  }
  const file = resolvePath(decodeURIComponent(url.pathname));
  let st;
  try { st = file && statSync(file); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404"); }
  const type = types[extname(file)] ?? "application/octet-stream";
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : st.size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`site en http://127.0.0.1:${port}  (/presentacion, /notas, /media)`));
