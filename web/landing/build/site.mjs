// Landing build helpers: shared header/footer, the public evidence (site/evidence.js) wired into
// the landing HTML, a small Markdown renderer for the public docs pages (/docs, /docs/arquitectura,
// /docs/ia) and the Vite plugin that puts it all together.
// No runtime dependencies: everything here runs at build time (or in the dev server).
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const SHOTS = join(REPO, "docs/screenshots");
const EVIDENCE_FILE = join(REPO, "site/evidence.js");
const DASH = String.fromCharCode(0x2014);
const SECRET_RE = /\bS[A-Z2-7]{55}\b/;

export const DOCS = [
  { route: "/docs", out: "docs/index.html", src: "README.md", label: "Overview", title: "Docs · Passport Pay" },
  { route: "/docs/arquitectura", out: "docs/arquitectura/index.html", src: "docs/ARCHITECTURE.md", label: "Architecture", title: "Architecture · Passport Pay" },
  { route: "/docs/ia", out: "docs/ia/index.html", src: "docs/AI.md", label: "How we used AI", title: "How we used AI · Passport Pay" },
];
// Relative links between the Markdown files, mapped to their public routes.
const LINK_MAP = { "README.md": "/docs", "ARCHITECTURE.md": "/docs/arquitectura", "AI.md": "/docs/ia" };

// Mark: a plain rounded square with a shield check (lucide), in the text color of each theme.
const MARK_SVG = (size) =>
  `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="currentColor"/><path d="M17 12.6c0 3.1-2.2 4.7-4.8 5.6a.6.6 0 0 1-.4 0C9.2 17.3 7 15.7 7 12.6V8.2a.6.6 0 0 1 .6-.6c1.3 0 2.8-.8 3.9-1.7a.7.7 0 0 1 1 0c1.1.9 2.6 1.7 3.9 1.7a.6.6 0 0 1 .6.6z" fill="none" stroke="var(--bg)" stroke-width="1.4" stroke-linejoin="round"/><path d="m9.8 12.2 1.5 1.5 3-3" fill="none" stroke="var(--bg)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const FAVICON =
  `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%2309090B'/%3E%3Cpath d='M17 12.6c0 3.1-2.2 4.7-4.8 5.6a.6.6 0 0 1-.4 0C9.2 17.3 7 15.7 7 12.6V8.2a.6.6 0 0 1 .6-.6c1.3 0 2.8-.8 3.9-1.7a.7.7 0 0 1 1 0c1.1.9 2.6 1.7 3.9 1.7a.6.6 0 0 1 .6.6z' fill='none' stroke='%23fff' stroke-width='1.6' stroke-linejoin='round'/%3E%3Cpath d='m9.8 12.2 1.5 1.5 3-3' fill='none' stroke='%23fff' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" />`;

// Geist for everything, Geist Mono only for hashes and code.
export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" />`;

const MOON = `<svg class="ico moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
const SUN = `<svg class="ico sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;

export function header(current = "") {
  const cur = (href) => (href === current ? ` aria-current="page"` : "");
  return `<header class="site-header"><div class="wrap header-row">
  <a class="brand" href="/#top">${MARK_SVG(24)}<span translate="no">Passport Pay</span></a>
  <nav class="site-nav" aria-label="Main">
    <a class="nav-link" href="/#how">How it works</a>
    <a class="nav-link" href="/video"${cur("/video")}>Demo</a>
    <a class="nav-link" href="/#proof">Proof</a>
    <a class="nav-link" href="/presentacion">Deck</a>
    <a class="btn primary sm" href="/app">Try the live demo</a>
    <button class="theme" type="button" data-theme-toggle aria-label="Switch between light and dark mode">${MOON}${SUN}</button>
  </nav>
</div></header>`;
}

export function footer() {
  return `<footer class="site-footer">
  <div class="wrap footer-row">
    <div class="footer-brand"><strong translate="no">Passport Pay</strong><span>HackMeridian 2026 · MIT · Stellar testnet only, no real money</span></div>
    <nav class="footer-nav" aria-label="Footer">
      <a href="/app">Live demo</a>
      <a href="/video">Demo video</a>
      <a href="/presentacion">Deck</a>
      <a href="/docs">Docs</a>
      <a href="https://github.com/LucasCariddi/passport-pay" target="_blank" rel="noopener">Code</a>
    </nav>
  </div>
</footer>`;
}

// ---------- Evidence (site/evidence.js) ----------

export function loadEvidence() {
  const src = readFileSync(EVIDENCE_FILE, "utf8");
  const json = src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1);
  const ev = JSON.parse(json);
  for (const [k, v] of Object.entries(ev)) {
    if (v && typeof v === "object" && "tx" in v && !/^[0-9a-f]{64}$/.test(v.tx)) throw new Error(`[pp-landing] evidence.${k}.tx is not a tx hash`);
  }
  return ev;
}

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const shortHash = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`;
// Register dates: "25 Oct 2026" and "20:21" (UTC), from an ISO timestamp.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");
function utc(v, path) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`[pp-landing] evidence ${path} is not a date`);
  return d;
}
const fmtDate = (v, path) => { const d = utc(v, path); return `${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const fmtTime = (v, path) => { const d = utc(v, path); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };

/**
 * Fills the evidence into a page: {{ev:a.b}} (escaped text), {{short:a.tx}}, {{link:a.tx}},
 * {{date:a.at}} and {{time:a.at}} (UTC, for the register), and
 * <!--pp:if:key-->...<!--pp:else-->...<!--pp:fi--> blocks that pick a branch by whether
 * evidence[key] is set. A missing value is a build error, never an empty string.
 */
export function applyEvidence(html, ev = loadEvidence()) {
  html = html.replace(/<!--pp:if:([\w.]+)-->([\s\S]*?)(?:<!--pp:else-->([\s\S]*?))?<!--pp:fi-->/g, (_, key, yes, no = "") =>
    get(ev, key) ? yes : no,
  );
  return html.replace(/\{\{(ev|short|link|date|time):([\w.]+)\}\}/g, (_, kind, path) => {
    const v = get(ev, path);
    if (v == null || v === "") throw new Error(`[pp-landing] missing evidence value: ${path}`);
    if (kind === "ev") return esc(String(v));
    if (kind === "short") return shortHash(String(v));
    if (kind === "date") return fmtDate(v, path);
    if (kind === "time") return fmtTime(v, path);
    return `${ev.explorer}/tx/${v}`;
  });
}

// ---------- Markdown (subset used by README and docs/) ----------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function slugify(text, seen) {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
  const n = seen.get(plain) ?? 0;
  seen.set(plain, n + 1);
  return n ? `${plain}-${n}` : plain;
}

function mapHref(href, ctx) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, hash] = href.split("#");
  const name = basename(path);
  if (LINK_MAP[name]) return LINK_MAP[name] + (hash ? `#${hash}` : "");
  if (/screenshots\/[^/]+\.(png|jpe?g|webp)$/i.test(path) && existsSync(join(SHOTS, name))) {
    ctx.images.add(name);
    return `/docs/screenshots/${name}`;
  }
  return null; // repo file (code, LICENSE, DEPLOY.md...): not published, shown as text
}

function inline(raw, ctx) {
  const slots = [];
  const put = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = raw;
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const url = mapHref(src, ctx);
    return url ? put(`<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`) : put(esc(alt));
  });
  s = s.replace(/\[((?:[^\]\\]|\\.)+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const url = mapHref(href, ctx);
    const inner = inline(text, ctx);
    if (!url) return put(inner);
    const ext = /^https?:/.test(url) ? ` target="_blank" rel="noopener"` : "";
    return put(`<a href="${esc(url)}"${ext}>${inner}</a>`);
  });
  // Code spans become slots first, so bold and italics can wrap them (**FAILED `#10`**).
  // A short hash like `c6b19624…5d19` never breaks inside (class "nw").
  s = s.replace(/`([^`]+)`/g, (_, c) => put(`<code${/^\S{1,16}…\S{1,8}$/.test(c) ? ` class="nw"` : ""}>${esc(c)}</code>`));
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![\w*])/g, "$1<em>$2</em>");
  // Slots can hold slots (a link whose text has code): resolve until none is left.
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
  return s;
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const HR = /^(-{3,}|\*{3,})\s*$/;
const isTableStart = (lines, i) => /^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]);
const indentOf = (l) => l.match(/^\s*/)[0].length;

function splitRow(row) {
  const t = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "", code = false;
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (c === "\\" && t[k + 1] === "|") { cur += "|"; k++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseList(lines, i, base, ctx) {
  const ordered = /\d/.test(LIST.exec(lines[i])[2]);
  const items = [];
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST.exec(line);
    if (m && m[1].length === base) { items.push({ text: [m[3]], kids: [] }); i++; continue; }
    if (m && m[1].length > base && items.length) {
      const r = parseList(lines, i, m[1].length, ctx);
      items.at(-1).kids.push(r.html);
      i = r.i;
      continue;
    }
    if (!m && items.length && /\S/.test(line) && indentOf(line) > base && !FENCE.test(line)) {
      items.at(-1).text.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? "ol" : "ul";
  const html = `<${tag}>${items.map((it) => `<li>${inline(it.text.join(" "), ctx)}${it.kids.join("")}</li>`).join("")}</${tag}>`;
  return { html, i };
}

function renderBlocks(md, ctx) {
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ""} tabindex="0"><code>${esc(buf.join("\n"))}</code></pre>`);
      if (lang === "mermaid") out.push(`<p class="diagram-note">${ctx.lang === "es" ? "Diagrama de secuencia en formato Mermaid (texto)." : "Sequence diagram in Mermaid format (text)."}</p>`);
      continue;
    }
    if (!/\S/.test(line)) { i++; continue; }
    let m;
    if ((m = HEADING.exec(line))) {
      const lvl = m[1].length;
      const text = m[2].trim();
      if (lvl === 1 && !ctx.title) ctx.title = text.replace(/[`*]/g, "");
      out.push(`<h${lvl} id="${esc(slugify(text, ctx.slugs))}">${inline(text, ctx)}</h${lvl}>`);
      i++;
      continue;
    }
    if (HR.test(line)) { out.push("<hr>"); i++; continue; }
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(
        `<div class="table" role="region" tabindex="0"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderBlocks(buf.join("\n"), ctx)}</blockquote>`);
      continue;
    }
    if ((m = LIST.exec(line))) {
      const r = parseList(lines, i, m[1].length, ctx);
      out.push(r.html);
      i = r.i;
      continue;
    }
    const buf = [];
    while (
      i < lines.length && /\S/.test(lines[i]) && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) &&
      !HR.test(lines[i]) && !LIST.test(lines[i]) && !/^\s*>/.test(lines[i]) && !isTableStart(lines, i)
    ) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(" "), ctx)}</p>`);
  }
  return out.join("\n");
}

// The docs are written in English; while one of them is still in Spanish its page says so in
// `lang`, so screen readers and translators get it right.
function guessLang(md) {
  const words = md.toLowerCase().match(/\b(el|la|los|las|que|para|una|con|del)\b/g)?.length ?? 0;
  const en = md.toLowerCase().match(/\b(the|and|that|with|for|this|from)\b/g)?.length ?? 0;
  return words > en ? "es" : "en";
}

// HTML comments in the Markdown (for example a `<!-- INJECTION_TX -->` marker waiting for a run)
// are notes for whoever edits the file, never page text: they are dropped before rendering,
// except inside fenced code blocks and inline code, where they are shown as written.
export function stripHtmlComments(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  let prose = [];
  const flush = () => {
    if (!prose.length) return;
    const text = prose
      .join("\n")
      .split(/(`[^`\n]*`)/)
      .map((p) => (p.startsWith("`") && p.endsWith("`") && p.length > 1 ? p : p.replace(/<!--[\s\S]*?-->/g, "")))
      .join("");
    out.push(...text.split("\n").map((l) => l.replace(/[ \t]+$/, "")));
    prose = [];
  };
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!inFence) flush();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) out.push(line);
    else prose.push(line);
  }
  flush();
  return out.join("\n");
}

export function renderDoc(doc) {
  const md = stripHtmlComments(readFileSync(join(REPO, doc.src), "utf8")).split(` ${DASH} `).join(": ").split(DASH).join(", ");
  const lang = guessLang(md);
  const ctx = { slugs: new Map(), images: new Set(), title: "", lang };
  const body = renderBlocks(md, ctx);
  const crumbs = DOCS.map(
    (d) => `<a href="${d.route}"${d.route === doc.route ? ` aria-current="page"` : ""}>${d.label}</a>`,
  ).join("");
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(doc.title)}</title>
<meta name="description" content="${esc(ctx.title || doc.label)}: Passport Pay public docs (Stellar testnet)." />
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#09090B" media="(prefers-color-scheme: dark)" />
${FAVICON}
${FONTS}
<link rel="stylesheet" href="/site.css" />
<script src="/theme.js"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header()}
<main id="main" class="doc wrap">
<nav class="crumbs" aria-label="Docs"><a href="/">Home</a>${crumbs}</nav>
<article class="doc-body">
${body}
</article>
</main>
${footer()}
</body>
</html>
`;
  if (SECRET_RE.test(html)) throw new Error(`[pp-landing] ${doc.src}: something shaped like a Stellar secret key (S...), not publishing`);
  if (html.includes(DASH)) throw new Error(`[pp-landing] ${doc.src}: an em dash is left in the HTML`);
  // An HTML comment shown as text (escaped) outside <pre>/<code> means stripHtmlComments missed one.
  const shown = html.replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<code>[\s\S]*?<\/code>/g, "");
  if (shown.includes("&lt;!--")) throw new Error(`[pp-landing] ${doc.src}: an HTML comment would show as text`);
  return { html, images: ctx.images };
}

// ---------- Vite plugin ----------

export function landingSite() {
  return {
    name: "pp-landing-site",
    transformIndexHtml(html) {
      const out = applyEvidence(
        html
          .replace("<!--pp:favicon-->", FAVICON)
          .replace("<!--pp:fonts-->", FONTS)
          .replace("<!--pp:header-->", header())
          .replace("<!--pp:footer-->", footer()),
      );
      if (out.includes(DASH)) throw new Error("[pp-landing] index.html: an em dash is left in the HTML");
      if (/\[[A-Z][A-Z ]+\]/.test(out.replace(/<script[\s\S]*?<\/script>/g, ""))) throw new Error("[pp-landing] index.html: a [PLACEHOLDER] is left in the HTML");
      return out;
    },
    configureServer(server) {
      server.watcher.add(EVIDENCE_FILE);
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/\/+$/, "") || "/";
        const doc = DOCS.find((d) => d.route === path);
        if (doc) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(renderDoc(doc).html);
          return;
        }
        const shot = /^\/docs\/screenshots\/([\w.-]+\.png)$/.exec(path);
        if (shot && existsSync(join(SHOTS, shot[1]))) {
          res.setHeader("Content-Type", "image/png");
          res.end(readFileSync(join(SHOTS, shot[1])));
          return;
        }
        next();
      });
    },
    generateBundle(_opts, bundle) {
      const images = new Set();
      for (const doc of DOCS) {
        const { html, images: imgs } = renderDoc(doc);
        imgs.forEach((n) => images.add(n));
        this.emitFile({ type: "asset", fileName: doc.out, source: html });
      }
      for (const name of images) {
        this.emitFile({ type: "asset", fileName: `docs/screenshots/${name}`, source: readFileSync(join(SHOTS, name)) });
      }
      for (const [name, item] of Object.entries(bundle)) {
        const text = item.type === "chunk" ? item.code : typeof item.source === "string" ? item.source : "";
        if (SECRET_RE.test(text)) this.error(`[pp-landing] ${name}: something shaped like a Stellar secret key (S...)`);
      }
    },
  };
}
