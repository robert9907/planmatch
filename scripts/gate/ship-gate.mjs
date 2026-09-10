#!/usr/bin/env node
// Plan Match ship gate.
//   git pre-push hook:  node scripts/gate/ship-gate.mjs pre-push   (refs on stdin)
//   manual dry run:     node scripts/gate/ship-gate.mjs manual     (checks HEAD)
// Exit 0 = ship. Exit 1 = blocked. Every uncertainty blocks.
import { repoRoot, loadConfig, runStep, tail, summaryLine, matcher, isCleanTree, readStamp, git, readStdin } from './lib.mjs';

const mode = process.argv[2] === 'pre-push' ? 'pre-push' : 'manual';
const say = (m) => process.stderr.write(m + '\n');
const block = (m) => { say(`\n✗ PLAN MATCH GATE — BLOCKED\n${m}\n`); process.exit(1); };

const root = repoRoot();
if (!root) block('Not inside a git repository.');
const { cfg, problem } = loadConfig(root);
if (problem) block(problem);

// Which commits are being shipped?
let shas = [];
if (mode === 'pre-push') {
  const input = await readStdin();
  for (const line of input.split('\n').filter(Boolean)) {
    const [, localSha] = line.trim().split(/\s+/);
    if (localSha && !/^0+$/.test(localSha)) shas.push(localSha); // all-zero = branch deletion, nothing to test
  }
  if (!shas.length) process.exit(0);
} else {
  shas = [git(['rev-parse', 'HEAD'], root)];
}

// The checks run against the working tree, so it must be exactly the code being shipped.
const head = git(['rev-parse', 'HEAD'], root);
const foreign = shas.filter((s) => s !== head);
if (foreign.length) block(`Pushing ${foreign.map((s) => s.slice(0, 8)).join(', ')} but HEAD is ${head.slice(0, 8)}.\nCheck out the branch you are pushing so the gate tests what ships.`);
if (cfg.requireCleanTree !== false && !isCleanTree(root)) block('Uncommitted changes to tracked files. The gate would be testing code that is not in the push.\nCommit or stash them first.');

say(`\nPlan Match gate — ${mode === 'pre-push' ? 'pre-push' : 'manual run'} @ ${head.slice(0, 8)}`);

// Brain changes need a passing full audit on this exact code.
if (cfg.fullAudit?.enabled && cfg.brainPaths?.length) {
  const isBrain = matcher(cfg.brainPaths);
  const stamp = readStamp(root);
  let changed = [];
  if (!stamp) {
    changed = ['(no full-audit stamp on record)'];
  } else if (stamp.sha !== head) {
    try { changed = git(['diff', '--name-only', stamp.sha, head], root).split('\n').filter(Boolean).filter(isBrain); }
    catch { changed = [`(last audited commit ${stamp.sha.slice(0, 8)} not found)`]; }
  }
  if (changed.length) {
    block(`Brain code changed since the last passing full audit${stamp ? ` (${stamp.sha.slice(0, 8)}, ${stamp.at})` : ''}:\n  ${changed.slice(0, 15).join('\n  ')}\nRun the full audit on this commit first: node scripts/gate/full-audit.mjs`);
  }
  say(`  ✓ Brain audit stamp  ${stamp ? `${stamp.sha.slice(0, 8)} — ${stamp.summary || 'passed'}` : ''}`);
}

for (const step of cfg.pushChecks ?? []) {
  const r = await runStep(step, root);
  if (!r.ok) block(`${step.name} failed (${r.why}, ${r.secs}s).\n--- last lines ---\n${tail(r.out)}`);
  const s = summaryLine(r.out);
  say(`  ✓ ${step.name}  ${r.secs}s${s ? `  — ${s}` : ''}`);
}

say('✓ Gate passed.\n');
process.exit(0);
