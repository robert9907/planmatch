// Plan Match gate — shared helpers. No dependencies beyond Node 18+ and git.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function repoRoot(start = process.cwd()) {
  try { return git(['rev-parse', '--show-toplevel'], start); } catch { return null; }
}

export function gitCommonDir(root) {
  return path.resolve(root, git(['rev-parse', '--git-common-dir'], root));
}

export const CONFIG_REL = 'scripts/gate/gate.config.json';

export function loadConfig(root) {
  const p = path.join(root, CONFIG_REL);
  if (!existsSync(p)) return { cfg: null, problem: `no ${CONFIG_REL} in ${root}` };
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return { cfg: null, problem: `${CONFIG_REL} is not valid JSON: ${e.message}` }; }
  // A config that still contains install placeholders is unfinished — the gate refuses to pass on it.
  if (hasPlaceholder(cfg)) return { cfg, problem: `${CONFIG_REL} still contains TODO placeholders; finish the install` };
  return { cfg, problem: null };
}

function hasPlaceholder(v) {
  if (typeof v === 'string') return v.includes('TODO');
  if (Array.isArray(v)) return v.some(hasPlaceholder);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => !k.startsWith('$') && hasPlaceholder(x));
  return false;
}

// Runs a shell command with a hard timeout. Kills the whole process group on timeout.
// Any timeout, spawn error, non-zero exit, failPattern hit, or missing passPattern = FAIL (fail-closed).
export function runStep(step, root) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const limit = (step.timeoutSec ?? 300) * 1000;
    let out = '';
    const cap = (b) => { out += b.toString(); if (out.length > 4_000_000) out = out.slice(-2_000_000); };
    let child;
    try {
      child = spawn(step.command, { cwd: root, shell: true, detached: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
    } catch (e) {
      return resolve({ ok: false, secs: '0.0', out: '', why: `could not start: ${e.message}` });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, limit);
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, secs: secs(t0), out, why: `could not start: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const s = secs(t0);
      if (timedOut) return resolve({ ok: false, secs: s, out, why: `timed out after ${step.timeoutSec ?? 300}s — treated as a failure` });
      if (code !== 0) return resolve({ ok: false, secs: s, out, why: `exit code ${code}` });
      if (step.failPattern && new RegExp(step.failPattern, 'm').test(out)) return resolve({ ok: false, secs: s, out, why: `output matched failPattern /${step.failPattern}/` });
      if (step.passPattern && !new RegExp(step.passPattern, 'm').test(out)) return resolve({ ok: false, secs: s, out, why: `output missing passPattern /${step.passPattern}/` });
      resolve({ ok: true, secs: s, out });
    });
  });
}
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

export function tail(s, n = 40) { return String(s).trimEnd().split('\n').slice(-n).join('\n'); }

// Last line that looks like a summary (contains "pass", "RED", or a ratio) — used to report real numbers.
export function summaryLine(s) {
  const lines = String(s).trimEnd().split('\n').filter((l) => /pass|RED|fail|\d+\s*\/\s*\d+/i.test(l));
  return lines.length ? lines[lines.length - 1].trim() : '';
}

// Glob → RegExp. "**" = any depth, "*" = within one segment. A pattern ending in "/" is a directory prefix.
export function matcher(patterns = []) {
  const res = patterns.map((p) => {
    if (p.endsWith('/')) p += '**';
    const rx = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
    return new RegExp(`^${rx}$`);
  });
  return (file) => res.some((r) => r.test(file.replace(/^\.\//, '')));
}

export function isCleanTree(root) {
  return git(['status', '--porcelain', '--untracked-files=no'], root) === '';
}

// Full-audit stamp lives in the git common dir so every worktree of this repo shares it.
function stampPath(root) { return path.join(gitCommonDir(root), 'pm-gate', 'full-audit.json'); }
export function readStamp(root) {
  const p = stampPath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
export function writeStamp(root, data) {
  const p = stampPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}

export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
