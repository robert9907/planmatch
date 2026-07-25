#!/usr/bin/env tsx
// CLI entry point for the Plan Match ↔ Medicare Plan Finder parity audit.
//
// Usage:
//   pnpm audit:parity --profile 01-margaret
//   pnpm audit:parity --all
//   pnpm audit:parity --state NC
//   pnpm audit:parity --profile 01-margaret --use-mpf-cache --use-pm-cache
//   pnpm audit:parity --report-only          # rebuild reports from cache
//
// Outputs:
//   _tmp/parity-audit/reports/<timestamp>/
//     ├── per-profile/<profile-id>.md
//     ├── comparisons.csv
//     └── rollup.md
//
// Env: .env.local via inline loader (same as _template-probe.ts).
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — for pm-snapshot
//   (mpf-scrape hits medicare.gov; no Supabase creds needed)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scrapeMpfSnapshot } from './lib/mpf-scrape.js';
import { pmSnapshot } from './lib/pm-snapshot.js';
import { enrichMpfSnapshotsWithCms } from './lib/formulary-compare.js';
import { buildPlanComparison } from './lib/diff-engine.js';
import { renderProfileReportMd } from './lib/report-md.js';
import { renderComparisonsCsv } from './lib/report-csv.js';
import { buildRollup, renderRollupMd } from './lib/report-rollup.js';
import { allProfiles, profileById, profilesByState } from './fixtures/index.js';
import type { BeneficiaryProfile, PlanSnapshot, ProfileReport, USState } from './types.js';

// ─── Paths ──────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(REPO_ROOT, '_tmp', 'parity-audit');
const REPORTS_ROOT = path.join(CACHE_DIR, 'reports');

function mpfCacheFile(profileId: string): string {
  return path.join(CACHE_DIR, 'mpf', profileId, 'snapshot.json');
}
function pmCacheFile(profileId: string): string {
  return path.join(CACHE_DIR, 'pm', profileId, 'snapshot.json');
}

// ─── Args ───────────────────────────────────────────────────────────

interface Args {
  profile: string | null;
  all: boolean;
  state: USState | null;
  useMpfCache: boolean;
  usePmCache: boolean;
  refreshMpf: boolean;
  refreshPm: boolean;
  reportOnly: boolean;
  verbose: boolean;
  maxMapdPlans: number;
  maxPdpPlans: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    profile: null, all: false, state: null,
    useMpfCache: false, usePmCache: false,
    refreshMpf: false, refreshPm: false,
    reportOnly: false, verbose: false,
    maxMapdPlans: 5, maxPdpPlans: 2,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    switch (a) {
      case '--profile': args.profile = next; i++; break;
      case '--all': args.all = true; break;
      case '--state': args.state = (next as USState); i++; break;
      case '--use-mpf-cache': args.useMpfCache = true; break;
      case '--use-pm-cache': args.usePmCache = true; break;
      case '--use-cache': args.useMpfCache = true; args.usePmCache = true; break;
      case '--refresh-mpf': args.refreshMpf = true; break;
      case '--refresh-pm': args.refreshPm = true; break;
      case '--report-only': args.reportOnly = true; args.useMpfCache = true; args.usePmCache = true; break;
      case '--verbose': case '-v': args.verbose = true; break;
      case '--max-mapd': args.maxMapdPlans = Number(next); i++; break;
      case '--max-pdp': args.maxPdpPlans = Number(next); i++; break;
      case '--help': case '-h': printHelp(); process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(readFileSync(path.join(__dirname, 'README.md'), 'utf8').split('## CLI')[1]?.split('##')[0] ?? '(see README.md)');
}

function resolveProfiles(args: Args): BeneficiaryProfile[] {
  if (args.profile) {
    const p = profileById(args.profile);
    if (!p) throw new Error(`profile "${args.profile}" not found`);
    return [p];
  }
  if (args.state) return profilesByState[args.state] ?? [];
  if (args.all) return allProfiles;
  throw new Error('Specify --profile <id>, --state <NC|TX|GA>, or --all');
}

// ─── Cache helpers ──────────────────────────────────────────────────

function loadCached<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; }
  catch { return null; }
}

function persist<T>(file: string, data: T): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── Per-profile pipeline ───────────────────────────────────────────

async function runProfile(profile: BeneficiaryProfile, args: Args): Promise<ProfileReport> {
  const label = `[${profile.id}]`;

  // Step 1 — MPF snapshot
  let mpf: PlanSnapshot[];
  if (args.reportOnly || (args.useMpfCache && !args.refreshMpf)) {
    const cached = loadCached<PlanSnapshot[]>(mpfCacheFile(profile.id));
    if (cached) { mpf = cached; if (args.verbose) console.log(`${label} MPF cache hit (${cached.length} plans)`); }
    else if (args.reportOnly) throw new Error(`${label} no MPF cache — cannot --report-only`);
    else {
      if (args.verbose) console.log(`${label} MPF cache miss → scraping`);
      mpf = await scrapeMpfSnapshot(profile, { maxMapdPlans: args.maxMapdPlans, maxPdpPlans: args.maxPdpPlans });
      persist(mpfCacheFile(profile.id), mpf);
    }
  } else {
    if (args.verbose) console.log(`${label} scraping MPF (${args.maxMapdPlans} MAPD + ${args.maxPdpPlans} PDP)`);
    mpf = await scrapeMpfSnapshot(profile, {
      maxMapdPlans: args.maxMapdPlans, maxPdpPlans: args.maxPdpPlans,
      refreshCache: args.refreshMpf,
    });
    persist(mpfCacheFile(profile.id), mpf);
  }

  // Step 1b — Enrich MPF drugCoverage from CMS ground truth (pm_formulary
  // = imported CMS SPUF). Per SPEC.md Task 1 (formulary compare): MPF's
  // plan-detail UI reads from the same CMS files Plan Match imports, so
  // pm_formulary IS the MPF ground truth. Enriches in place after cache
  // load or fresh scrape.
  await enrichMpfSnapshotsWithCms(mpf, profile);
  if (args.verbose) console.log(`${label} enriched MPF drugCoverage from CMS (pm_formulary)`);

  // Step 2 — PM snapshot for the same plan set
  const planKeys = mpf.map((s) => ({
    contractId: s.ident.contractId,
    planId: s.ident.planId,
    segmentId: s.ident.segmentId,
  }));

  let pm: PlanSnapshot[];
  if (args.reportOnly || (args.usePmCache && !args.refreshPm)) {
    const cached = loadCached<PlanSnapshot[]>(pmCacheFile(profile.id));
    if (cached) { pm = cached; if (args.verbose) console.log(`${label} PM cache hit (${cached.length} plans)`); }
    else if (args.reportOnly) throw new Error(`${label} no PM cache — cannot --report-only`);
    else {
      if (args.verbose) console.log(`${label} PM cache miss → querying Supabase`);
      pm = await pmSnapshot(profile, planKeys);
      persist(pmCacheFile(profile.id), pm);
    }
  } else {
    if (args.verbose) console.log(`${label} querying PM for ${planKeys.length} plans`);
    pm = await pmSnapshot(profile, planKeys);
    persist(pmCacheFile(profile.id), pm);
  }

  // Step 3 — pair snapshots by plan key + build PlanComparison
  const pairs = planKeys.map((key) => {
    const m = mpf.find((s) => s.ident.contractId === key.contractId && s.ident.planId === key.planId && s.ident.segmentId === key.segmentId);
    const p = pm.find((s) => s.ident.contractId === key.contractId && s.ident.planId === key.planId && s.ident.segmentId === key.segmentId);
    return { key, m, p };
  });

  const planComparisons = pairs
    .filter((pair) => pair.m && pair.p)
    .map((pair) => buildPlanComparison(pair.m!, pair.p!, profile));

  // Missing plans → track separately so rollup shows F6
  const missing = pairs.filter((pair) => !pair.m || !pair.p);
  if (missing.length && args.verbose) {
    console.warn(`${label} ${missing.length} plan(s) missing from one side (F6)`);
  }

  // Step 4 — assemble ProfileReport
  const criticalFailures = planComparisons.flatMap((pc) =>
    pc.comparisons.filter((c) => c.severity === 'critical' && c.status === 'FAIL'),
  );
  const aggregatePass =
    planComparisons.reduce((sum, pc) => sum + pc.unweightedParity, 0) / Math.max(1, planComparisons.length);
  const aggregateWeighted =
    planComparisons.reduce((sum, pc) => sum + pc.weightedScore, 0) / Math.max(1, planComparisons.length);

  return {
    profileId: profile.id,
    runAt: new Date().toISOString(),
    planComparisons,
    aggregatePassRate: aggregatePass,
    aggregateWeightedRate: aggregateWeighted,
    criticalFailures,
  };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const profiles = resolveProfiles(args);
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(REPORTS_ROOT, runTimestamp);
  mkdirSync(path.join(outDir, 'per-profile'), { recursive: true });

  console.log(`Parity audit run: ${runTimestamp}`);
  console.log(`Profiles: ${profiles.length} (${profiles.map((p) => p.id).join(', ')})`);
  console.log(`Output: ${outDir}`);
  console.log('');

  const reports: Array<{ report: ProfileReport; profile: BeneficiaryProfile }> = [];
  for (const profile of profiles) {
    try {
      const report = await runProfile(profile, args);
      reports.push({ report, profile });

      const md = renderProfileReportMd(report, profile);
      writeFileSync(path.join(outDir, 'per-profile', `${profile.id}.md`), md);

      console.log(`✓ ${profile.id} — pass ${(report.aggregatePassRate * 100).toFixed(1)}% weighted ${(report.aggregateWeightedRate * 100).toFixed(1)}% critical ${report.criticalFailures.length}`);
    } catch (err) {
      console.error(`✗ ${profile.id} — ${(err as Error).message}`);
      if (args.verbose) console.error((err as Error).stack);
    }
  }

  if (!reports.length) {
    console.error('No reports generated.');
    process.exit(1);
  }

  // Rollup + CSV
  const rollup = buildRollup(reports);
  writeFileSync(path.join(outDir, 'rollup.md'), renderRollupMd(rollup));
  writeFileSync(path.join(outDir, 'comparisons.csv'), renderComparisonsCsv(reports.map((r) => r.report)));

  console.log('');
  if (!rollup.hasData) {
    console.warn('⚠ 0 field comparisons — no parity data captured');
    console.warn('  Check MPF scrape log for 4xx responses and Plan Match Supabase creds.');
    console.log(`Reports: ${outDir}`);
    process.exit(2);
  }
  console.log(`Total comparisons:  ${rollup.totalComparisons}`);
  console.log(`Overall unweighted: ${(rollup.overallPassRate * 100).toFixed(2)}%`);
  console.log(`Overall weighted:   ${(rollup.overallWeightedRate * 100).toFixed(2)}%`);
  console.log(`Meets target (≥98.9% + ≥97.5%): ${rollup.meetsTarget ? 'YES' : 'NO'}`);
  console.log('');
  console.log(`Reports: ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
