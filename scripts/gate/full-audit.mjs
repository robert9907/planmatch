#!/usr/bin/env node
// Plan Match full audit — the slow suite (six-persona secret shopper, etc.).
// Run on a clean, committed tree. On pass, stamps the commit so brain changes can ship.
//   node scripts/gate/full-audit.mjs
import { repoRoot, loadConfig, runStep, tail, summaryLine, isCleanTree, writeStamp, git } from './lib.mjs';

const say = (m) => process.stderr.write(m + '\n');
const fail = (m) => { say(`\n✗ FULL AUDIT — NOT STAMPED\n${m}\n`); process.exit(1); };

const root = repoRoot();
if (!root) fail('Not inside a git repository.');
const { cfg, problem } = loadConfig(root);
if (problem) fail(problem);
if (!cfg.fullAudit?.enabled) fail('fullAudit is disabled in gate.config.json.');
if (!isCleanTree(root)) fail('Uncommitted changes. The stamp must describe a real commit — commit first.');

const sha = git(['rev-parse', 'HEAD'], root);
say(`\nPlan Match full audit @ ${sha.slice(0, 8)}`);

const results = [];
for (const step of cfg.fullAudit.steps ?? []) {
  say(`  … ${step.name}`);
  const r = await runStep(step, root);
  if (!r.ok) fail(`${step.name} failed (${r.why}, ${r.secs}s). Previous stamp left unchanged.\n--- last lines ---\n${tail(r.out, 60)}`);
  const s = summaryLine(r.out);
  results.push(`${step.name}: ${s || 'passed'}`);
  say(`  ✓ ${step.name}  ${r.secs}s${s ? `  — ${s}` : ''}`);
}

if (git(['rev-parse', 'HEAD'], root) !== sha || !isCleanTree(root)) fail('The tree changed while the audit ran (another session?). Re-run on a stable commit.');

writeStamp(root, { sha, at: new Date().toISOString(), summary: results.join(' | ') });
say(`✓ Stamped ${sha.slice(0, 8)} — brain changes up to this commit can ship.\n`);
