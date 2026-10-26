// serve-trap.mjs <port> - tiny static server for web/public, so the trap page is reachable
// at http://127.0.0.1:<port>/trampa/ while the agent runs. No dependencies, testnet demo only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] || 4190);
const PUBLIC = fileURLToPath(new URL("../web/public", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const full = normalize(join(PUBLIC, p));
    if (!full.startsWith(PUBLIC)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(full);
    res.writeHead(200, { "content-type": TYPES[extname(full)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`[serve-trap] http://127.0.0.1:${PORT}/trampa/  (serving ${PUBLIC})`));
