// Google Cloud Run host for agent Plan Match (agent.generationhealth.me).
//
// Vercel serves this app as static files (dist) plus serverless functions
// (api/**/*.ts). Cloud Run has no such split, so this one small Node server
// does both jobs, mirroring vercel.json:
//   - the redirects, SPA fallback and security headers
//   - /api/<path> → the bundled handler build/api/<path>.cjs (including the
//     [id] dynamic routes), called with the Vercel helpers the handlers use
//     (req.query, req.body, res.status().json/send/end, res.redirect)
// Settings come from the pm-agent-env secret, mounted as a JSON file.
//
// Vercel keeps deploying from main untouched — it never sees this file.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const API_DIR = path.join(ROOT, 'build', 'api');
const PORT = Number(process.env.PORT || 8080);

// ── Settings ────────────────────────────────────────────────────────────
const ENV_FILE = process.env.PM_ENV_FILE || '/secrets/env.json';
if (fs.existsSync(ENV_FILE)) {
  const env = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = String(v);
}

// ── vercel.json ─────────────────────────────────────────────────────────
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const GLOBAL_HEADERS = vercel.headers.find((h) => h.source === '/(.*)')?.headers ?? [];

// Path redirects from vercel.json (exact paths and /prefix/:path*). The
// host-based planmatch.vercel.app redirect does not apply on Google.
function findRedirect(p) {
  for (const r of vercel.redirects) {
    if (r.has) continue;
    if (r.source.endsWith('/:path*')) {
      const prefix = r.source.slice(0, -'/:path*'.length);
      if (p === prefix || p.startsWith(prefix + '/')) {
        const rest = p.slice(prefix.length).replace(/^\//, '');
        return { url: r.destination.replace(':path*', rest), code: r.statusCode };
      }
    } else if (r.source === p) {
      return { url: r.destination, code: r.statusCode };
    }
  }
  return null;
}

// ── API routing (same file layout Vercel uses) ──────────────────────────
function resolveApi(segments) {
  let dir = API_DIR;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg === '..' || seg === '.' || seg.startsWith('_')) return null;
    const last = i === segments.length - 1;
    if (last) {
      const file = path.join(dir, `${seg}.cjs`);
      if (fs.existsSync(file)) return { file, params };
      const index = path.join(dir, seg, 'index.cjs');
      if (fs.existsSync(index)) return { file: index, params };
    } else if (fs.existsSync(path.join(dir, seg)) && fs.statSync(path.join(dir, seg)).isDirectory()) {
      dir = path.join(dir, seg);
      continue;
    }
    // Dynamic segment: [name].js (file) or [name]/ (directory).
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const dyn = entries.find((e) => (last ? /^\[[^\]]+\]\.cjs$/ : /^\[[^\]]+\]$/).test(e));
    if (!dyn) return null;
    params[dyn.replace(/^\[|\](\.cjs)?$/g, '')] = decodeURIComponent(seg);
    if (last) return { file: path.join(dir, dyn), params };
    dir = path.join(dir, dyn);
  }
  return null;
}

const modules = new Map();
function loadHandler(file) {
  if (!modules.has(file)) {
    const mod = require(file);
    const fn = typeof mod === 'function' ? mod : mod.default;
    const limit = (mod.config && mod.config.api && mod.config.api.bodyParser && mod.config.api.bodyParser.sizeLimit) || null;
    modules.set(file, { fn, maxBody: parseSize(limit) ?? Math.floor(4.5 * 1024 * 1024) });
  }
  return modules.get(file);
}

function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(kb|mb)$/i.exec(String(s ?? ''));
  if (!m) return null;
  return Math.floor(Number(m[1]) * (m[2].toLowerCase() === 'mb' ? 1024 * 1024 : 1024));
}

function toQuery(searchParams, params) {
  const q = {};
  for (const [k, v] of searchParams) {
    if (k in q) q[k] = Array.isArray(q[k]) ? [...q[k], v] : [q[k], v];
    else q[k] = v;
  }
  return Object.assign(q, params);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('Body exceeded size limit'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(buf, contentType) {
  if (!buf.length) return undefined;
  const ct = String(contentType || '').toLowerCase();
  const text = buf.toString('utf8');
  if (ct.includes('application/json')) return JSON.parse(text);
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  if (ct.startsWith('text/')) return text;
  return buf;
}

function withHelpers(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (body === undefined || body === null) { res.end(); return res; }
    if (Buffer.isBuffer(body)) { res.end(body); return res; }
    if (typeof body === 'string') {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(body);
      return res;
    }
    return res.json(body);
  };
  res.redirect = (a, b) => {
    const [code, url] = typeof a === 'number' ? [a, b] : [307, a];
    res.statusCode = code;
    res.setHeader('Location', url);
    res.end();
    return res;
  };
  return res;
}

async function handleApi(target, req, res, url) {
  const { fn, maxBody } = loadHandler(target.file);
  req.query = toQuery(url.searchParams, target.params);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    try {
      req.body = parseBody(await readBody(req, maxBody), req.headers['content-type']);
    } catch (e) {
      res.statusCode = e.status || 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.status === 413 ? 'Request too large' : 'Invalid request body' }));
      return;
    }
  }
  await fn(req, withHelpers(res));
}

// ── Static files ────────────────────────────────────────────────────────
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml',
};

function serveFile(res, file, method) {
  const data = fs.readFileSync(file);
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.end(method === 'HEAD' ? undefined : data);
}

// ── Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    for (const h of GLOBAL_HEADERS) res.setHeader(h.key, h.value);

    if (p === '/healthz') { res.statusCode = 200; res.end('ok'); return; }

    const redirect = findRedirect(p);
    if (redirect) {
      res.statusCode = redirect.code;
      res.setHeader('Location', redirect.url + url.search);
      res.end();
      return;
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const target = resolveApi(url.pathname.slice(5).replace(/\/+$/, '').split('/'));
      if (!target) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Not found' })); return; }
      await handleApi(target, req, res, url);
      return;
    }

    const rel = path.normalize(decodeURIComponent(p)).replace(/^([/\\])+/, '');
    const file = path.join(DIST, rel);
    if (file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      if (p.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      serveFile(res, file, req.method);
      return;
    }
    if (p.startsWith('/assets/')) { res.statusCode = 404; res.end('Not found'); return; }
    res.removeHeader('Cache-Control');
    serveFile(res, path.join(DIST, 'index.html'), req.method);
  } catch (err) {
    console.error('[server]', req.method, req.url, err);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); }
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(PORT, () => console.log(`planmatch (agent) listening on ${PORT}`));
