// Bundles every Vercel function under api/ into build/api/<same path>.cjs
// for the Google Cloud Run host (server/server.cjs). Each handler becomes
// one self-contained CommonJS file with its dependencies bundled in. The one
// exception is the headless browser used by api/drug-costs.ts
// (playwright-core + @sparticuz/chromium): it ships a Chromium binary, so it
// stays external and Dockerfile.gcp installs just those two packages.
// Vercel never runs this.
//
// Run after `vite build`:  node scripts/gcp/build-api.cjs

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '../..');
const API = path.join(ROOT, 'api');
const OUT = path.join(ROOT, 'build', 'api');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue; // _lib, __tests__
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const entries = walk(API);
fs.rmSync(OUT, { recursive: true, force: true });
esbuild
  .build({
    entryPoints: entries,
    outdir: OUT,
    outbase: API,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'none',
    logLevel: 'warning',
    external: ['playwright-core', '@sparticuz/chromium'],
  })
  .then(() => console.log(`bundled ${entries.length} API functions into build/api`))
  .catch(() => process.exit(1));
