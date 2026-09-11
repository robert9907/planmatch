#!/usr/bin/env node
// Plan Match — SessionStart. Keeps the git pre-push gate installed and reports gate state as context.
import { existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, loadConfig, readStamp, git, readStdin } from '../../scripts/gate/lib.mjs';

const input = JSON.parse((await readStdin()) || '{}');
const root = repoRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
if (!root) process.exit(0);

const lines = [];
const hook = path.join(root, '.githooks', 'pre-push');
if (existsSync(hook)) {
  try { chmodSync(hook, 0o755); } catch {}
  let current = '';
  try { current = git(['config', '--get', 'core.hooksPath'], root); } catch {}
  if (current !== '.githooks') {
    try { git(['config', 'core.hooksPath', '.githooks'], root); lines.push('Plan Match pre-push gate was not active; core.hooksPath is now set to .githooks.'); }
    catch (e) { lines.push(`WARNING: could not set core.hooksPath (${e.message}). Pushes from Claude are blocked until this is fixed.`); }
  }
} else {
  lines.push('WARNING: .githooks/pre-push is missing on this branch. The Plan Match ship gate is not installed here.');
}

const { cfg, problem } = loadConfig(root);
if (problem) lines.push(`WARNING: Plan Match gate config problem: ${problem}. Commits and pushes will be blocked until it is fixed.`);
if (cfg && !problem) {
  lines.push(`Plan Match gate is active. Commits require: ${cfg.typecheck?.name}. Pushes require: ${(cfg.pushChecks ?? []).map((s) => s.name).join(', ')}${cfg.requireCleanTree !== false ? ', clean tree' : ''}.`);
  if (cfg.fullAudit?.enabled) {
    const s = readStamp(root);
    lines.push(s
      ? `Last passing full audit: ${s.sha.slice(0, 8)} at ${s.at} (${s.summary}). Brain changes after that commit need a new full audit before push (node scripts/gate/full-audit.mjs).`
      : 'No passing full audit is on record. Any push touching brain paths is blocked until node scripts/gate/full-audit.mjs passes.');
  }
}
process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
