#!/usr/bin/env node
// Plan Match — PostToolUse (async, wakes Claude on failure).
// After a TypeScript edit, typechecks in the background. Rapid edits are coalesced:
// one run at a time, and one more run if files changed while it was running.
import { existsSync, writeFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, loadConfig, runStep, tail, readStdin } from '../../scripts/gate/lib.mjs';

const input = JSON.parse((await readStdin()) || '{}');
const fp = input.tool_input?.file_path || '';
if (!/\.(ts|tsx|mts|cts)$/.test(fp)) process.exit(0);

const root = repoRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
if (!root) process.exit(0);
const { cfg, problem } = loadConfig(root);
if (!cfg || problem || !cfg.typecheck) process.exit(0); // the commit guard reports config problems

const dir = path.join(os.tmpdir(), 'pm-gate-' + createHash('sha1').update(root).digest('hex').slice(0, 10));
mkdirSync(dir, { recursive: true });
const lock = path.join(dir, 'lock');
const dirty = path.join(dir, 'dirty');

writeFileSync(dirty, String(Date.now()));
if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 10 * 60_000) process.exit(0); // a run is active; it will pick this up
writeFileSync(lock, String(process.pid));

let last;
try {
  while (existsSync(dirty)) {
    rmSync(dirty, { force: true });
    last = await runStep(cfg.typecheck, root);
  }
} finally {
  rmSync(lock, { force: true });
}

if (last && !last.ok) {
  process.stderr.write(`${cfg.typecheck.name} is failing after your recent edits (${last.why}). Fix before continuing:\n${tail(last.out, 30)}\n`);
  process.exit(2);
}
process.exit(0);
