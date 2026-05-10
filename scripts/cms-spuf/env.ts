// scripts/cms-spuf/env.ts
//
// Minimal .env.local loader matching the pattern used by
// scripts/backfill-drug-ndcs.ts. Loaded once at import time so any
// module pulling pg / supabase has the env it needs.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotenv(): void {
  // Look for .env.local relative to cwd. The npm script runs from the
  // repo root, so this lands on /Users/.../planmatch/.env.local.
  const path = resolve(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

loadDotenv();

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set (.env.local or shell)`);
  return v;
}
