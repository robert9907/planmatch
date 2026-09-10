#!/usr/bin/env node
// Plan Match — PreToolUse guard.
//   Bash `git commit`        → runs typecheck; blocks the commit on failure
//   Bash `git push`          → blocks unless the pre-push gate is actually installed for this checkout
//   Gate bypass attempts     → approval prompt for Rob (--no-verify, hooksPath changes, Vercel CLI deploys, force push)
//   Edits to gate/validators → approval prompt for Rob
// Exit 2 = hard block (reason goes to Claude). JSON "ask" = Rob decides.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, loadConfig, runStep, tail, matcher, git, readStdin } from '../../scripts/gate/lib.mjs';

const input = JSON.parse((await readStdin()) || '{}');
const tool = input.tool_name || '';
const ti = input.tool_input || {};
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const projectRoot = repoRoot(projectDir) || projectDir;

const deny = (why) => { process.stderr.write(`Plan Match gate: ${why}\n`); process.exit(2); };
const ask = (why) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Plan Match gate: ${why}` } }));
  process.exit(0);
};

const { cfg: projectCfg } = loadConfig(projectRoot);
const protectedPaths = projectCfg?.protectedPaths ?? ['.claude/', '.githooks/', 'scripts/gate/', 'CLAUDE.md'];
const isProtected = matcher(protectedPaths);

// ---- File edits -------------------------------------------------------------
if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
  const fp = ti.file_path || ti.notebook_path || '';
  if (!fp) process.exit(0);
  const rel = path.relative(repoRoot(path.dirname(path.resolve(projectDir, fp))) || projectRoot, path.resolve(projectDir, fp));
  if (!rel.startsWith('..') && isProtected(rel)) {
    ask(`${rel} is a protected gate/validator file. Changing it changes what "passing" means. Approve only if you asked for this change.`);
  }
  process.exit(0);
}

if (tool !== 'Bash') process.exit(0);
const cmd = String(ti.command || '');
const cwdRoot = repoRoot(input.cwd || projectDir) || projectRoot;

// ---- Bypass attempts → Rob approves or denies ------------------------------
const bypasses = [
  [/--no-verify\b/, 'uses --no-verify, which skips the ship gate'],
  [/\bgit\b[^\n;&|]*\bcommit\b[^\n;&|]*\s-[a-zA-Z]*n[a-zA-Z]*\b/, 'uses `git commit -n`, which skips hooks'],
  [/core\.hooksPath(?!\s*=?\s*\.githooks\b)/, 'changes core.hooksPath, which can disable the ship gate'],
  [/\bvercel\b[^\n;&|]*(\bdeploy\b|--prod\b|\bpromote\b|\brollback\b)/, 'deploys through the Vercel CLI, bypassing the push gate'],
  [/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(\s--force\b|\s-f\b|--force-with-lease)/, 'force-pushes'],
  [/disableAllHooks/, 'tries to disable hooks'],
];
for (const [rx, why] of bypasses) if (rx.test(cmd)) ask(`This command ${why}. Approve only if you intend to override the gate.`);

// Shell writes to protected files (sed -i, redirects, rm, mv, cp, checkout/restore).
const writeish = /(\bsed\s+-[a-zA-Z]*i|\bperl\s+-[a-zA-Z]*i|(^|[^0-9&>])>>?\s*[^&\s]|\btee\b|\brm\b|\bmv\b|\bcp\b|\bchmod\b|\btruncate\b|\bgit\s+(checkout|restore)\b)/;
const mentioned = protectedPaths.filter((p) => cmd.includes(p.replace(/\/$/, '')));
if (mentioned.length && writeish.test(cmd)) ask(`This shell command may modify protected gate/validator files (${mentioned.join(', ')}).`);

// ---- git push → the pre-push gate must really be installed -----------------
if (/\bgit\b(?:\s+-[cC]\s+\S+)*\s+push\b/.test(cmd)) {
  let hooksPath = '';
  try { hooksPath = git(['config', '--get', 'core.hooksPath'], cwdRoot); } catch {}
  if (hooksPath !== '.githooks' || !existsSync(path.join(cwdRoot, '.githooks', 'pre-push'))) {
    deny(`the pre-push ship gate is not active in ${cwdRoot} (core.hooksPath="${hooksPath}"). Pushing now would skip it. Restart the session so the session-start hook installs it, or merge the gate kit into this branch.`);
  }
  process.exit(0); // the pre-push hook runs the full ship gate
}

// ---- git commit → typecheck first ------------------------------------------
if (/\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b/.test(cmd)) {
  const { cfg, problem } = loadConfig(cwdRoot);
  if (!cfg) process.exit(0);          // not a gated repo (e.g. an unrelated checkout)
  if (problem) deny(problem);         // gated repo with an unfinished config → fail closed
  const r = await runStep(cfg.typecheck, cwdRoot);
  if (!r.ok) deny(`commit blocked — ${cfg.typecheck.name} failed (${r.why}). Fix the errors, then commit.\n${tail(r.out, 30)}`);
}
process.exit(0);
