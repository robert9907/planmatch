#!/usr/bin/env node
// scripts/check-partd-drift.mjs
//
// Fails with exit 1 when a locally-tracked file's contents differ
// from its counterpart in a sibling repo. Backs the CI drift check
// against the intentionally-duplicated partDTimeline.ts +
// planYearParams.ts pair that lives in both:
//
//   robert9907/planmatch (agent) /api/library/*
//   robert9907/plan-match (consumer) /packages/shared/src/*
//
// A header comment in each file warns humans, but only this script
// keeps the copies actually identical. When the shared package gets
// published to npm, both repos consume it and this check retires.
//
// Normalization (the one permitted delta): relative imports of the
// form `from './planYearParams.js'` (agent style, ESM Node with
// explicit extensions) are rewritten to `from './planYearParams'`
// (consumer style, TypeScript bundler resolution) before compare.
// Nothing else is normalized — every other byte must match.
//
// Usage:
//   node scripts/check-partd-drift.mjs \
//     --local <path> \
//     --remote-repo <owner/name> \
//     --remote-ref  <branch>          # default: main
//     --remote-path <path in repo>
//
// Multi-file mode (repeat --local + --remote-path in matching order):
//   node scripts/check-partd-drift.mjs \
//     --remote-repo robert9907/planmatch \
//     --local packages/shared/src/partDTimeline.ts \
//     --remote-path api/library/partDTimeline.ts \
//     --local packages/shared/src/planYearParams.ts \
//     --remote-path api/library/planYearParams.ts
//
// Auth: reads GITHUB_TOKEN or CROSS_REPO_READ_TOKEN from env. Required
// for private repos. Without it the fetch to raw.githubusercontent.com
// returns 404 for private targets. Fail-open on unauthorized (warns
// and exits 0) so a token misconfiguration doesn't block deploys;
// fail-closed on actual byte drift.

import { readFileSync, existsSync } from 'node:fs';

function parseArgs(argv) {
  const pairs = { local: [], remotePath: [] };
  let remoteRepo = null;
  let remoteRef = 'main';
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === '--local')            { pairs.local.push(val);        i += 1; }
    else if (flag === '--remote-repo') { remoteRepo = val;              i += 1; }
    else if (flag === '--remote-ref')  { remoteRef = val;               i += 1; }
    else if (flag === '--remote-path') { pairs.remotePath.push(val);    i += 1; }
  }
  if (!remoteRepo || pairs.local.length === 0 ||
      pairs.local.length !== pairs.remotePath.length) {
    console.error(
      'usage: --remote-repo <owner/name> [--remote-ref <ref>] ' +
      '--local <path> --remote-path <path> [--local ... --remote-path ...]',
    );
    process.exit(2);
  }
  return { remoteRepo, remoteRef, pairs };
}

function normalize(source) {
  // Strip `.js` suffix from RELATIVE imports (./ or ../ prefixes only).
  // Bare-package imports keep their extensions if any (there are none
  // today, but a future @scope/thing.js should not be rewritten).
  return source.replace(
    /(from\s+['"](?:\.\.?\/[^'"]+?))\.js(['"])/g,
    '$1$2',
  );
}

async function fetchRemote(repo, ref, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`;
  const token =
    process.env.GITHUB_TOKEN ??
    process.env.CROSS_REPO_READ_TOKEN ??
    null;
  const headers = { Accept: 'application/vnd.github.raw' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  return { status: res.status, text: res.ok ? await res.text() : null };
}

// tiny inline unified-style diff (first 12 non-matching lines) so CI
// output is greppable without a diff dependency.
function inlineDiff(a, b, aLabel, bLabel) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  const out = [];
  for (let i = 0; i < max && out.length < 24; i += 1) {
    if (aLines[i] !== bLines[i]) {
      out.push(`  ${(i + 1).toString().padStart(4)}   ${aLabel}: ${JSON.stringify(aLines[i] ?? '')}`);
      out.push(`  ${(i + 1).toString().padStart(4)}   ${bLabel}: ${JSON.stringify(bLines[i] ?? '')}`);
    }
  }
  return out.join('\n');
}

async function main() {
  const { remoteRepo, remoteRef, pairs } = parseArgs(process.argv);
  let hadDrift = false;
  let hadInfraError = false;

  for (let i = 0; i < pairs.local.length; i += 1) {
    const localPath = pairs.local[i];
    const remotePath = pairs.remotePath[i];
    console.log(`\nchecking: ${localPath}  vs  ${remoteRepo}@${remoteRef}:${remotePath}`);
    if (!existsSync(localPath)) {
      console.error(`  ERROR: local file missing: ${localPath}`);
      hadDrift = true;
      continue;
    }
    const localText = readFileSync(localPath, 'utf8');
    const remote = await fetchRemote(remoteRepo, remoteRef, remotePath);
    if (remote.status === 401 || remote.status === 403 || remote.status === 404) {
      console.warn(
        `  WARN: remote fetch returned ${remote.status}. Fail-open. ` +
        `Set CROSS_REPO_READ_TOKEN with read access to ${remoteRepo} ` +
        `to activate the check.`,
      );
      hadInfraError = true;
      continue;
    }
    if (!remote.text) {
      console.error(`  ERROR: remote fetch failed with status ${remote.status}`);
      hadDrift = true;
      continue;
    }
    const local = normalize(localText);
    const rem = normalize(remote.text);
    if (local === rem) {
      console.log(`  OK — normalized contents match`);
      continue;
    }
    hadDrift = true;
    console.error(`  DRIFT — normalized contents differ`);
    console.error(inlineDiff(local, rem, 'LOCAL ', 'REMOTE'));
  }

  if (hadDrift) {
    console.error(
      `\nFAIL — one or more shared files have drifted. Sync both copies ` +
      `before merging. See the header comment of the file for the ` +
      `cross-repo location.`,
    );
    process.exit(1);
  }
  if (hadInfraError) {
    console.warn(
      `\nWARN — drift check ran fail-open due to a missing token / 404. ` +
      `Fix the CI secret to enforce.`,
    );
  }
  console.log('\nOK — no drift detected across all checked pairs.');
}

main().catch((err) => {
  console.error('unexpected error:', err);
  process.exit(2);
});
