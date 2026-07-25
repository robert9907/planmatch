// State/overall parity dashboard rollup.

import type {
  BeneficiaryProfile,
  FailCode,
  FieldComparison,
  ProfileReport,
  RollupReport,
  USState,
} from '../types.js';

const SEVERITY_WEIGHT = {
  critical: 3,
  major: 2,
  minor: 1,
  display: 0.5,
} as const;

interface RollupInput {
  report: ProfileReport;
  profile: BeneficiaryProfile;
}

interface Accum {
  denom: number;
  passOrCond: number;
  weightedTotal: number;
  weightedFail: number;
}

const emptyAccum = (): Accum => ({
  denom: 0,
  passOrCond: 0,
  weightedTotal: 0,
  weightedFail: 0,
});

function accumulate(acc: Accum, c: FieldComparison): void {
  if (c.status === 'N/A') return;
  acc.denom += 1;
  if (c.status === 'PASS' || c.status === 'CONDITIONAL') acc.passOrCond += 1;
  const w = SEVERITY_WEIGHT[c.severity];
  acc.weightedTotal += w;
  if (c.status === 'FAIL') acc.weightedFail += w;
}

function rates(acc: Accum): { passRate: number; weightedRate: number } {
  return {
    passRate: acc.denom === 0 ? 1 : acc.passOrCond / acc.denom,
    weightedRate:
      acc.weightedTotal === 0 ? 1 : 1 - acc.weightedFail / acc.weightedTotal,
  };
}

export function buildRollup(input: RollupInput[]): RollupReport {
  const overall = emptyAccum();
  const byStateAcc: Record<USState, Accum> = {
    NC: emptyAccum(),
    TX: emptyAccum(),
    GA: emptyAccum(),
  };
  const byCategoryAcc: Record<string, Accum> = {};
  const failByCode: Record<string, number> = {};

  for (const { report, profile } of input) {
    for (const pc of report.planComparisons) {
      for (const c of pc.comparisons) {
        accumulate(overall, c);
        accumulate(byStateAcc[profile.state], c);
        const catAcc =
          byCategoryAcc[c.category] ?? (byCategoryAcc[c.category] = emptyAccum());
        accumulate(catAcc, c);
        if (c.status === 'FAIL' && c.failCode) {
          failByCode[c.failCode] = (failByCode[c.failCode] ?? 0) + 1;
        }
      }
    }
  }

  const hasData = overall.denom > 0;
  const overallRates = hasData ? rates(overall) : { passRate: 0, weightedRate: 0 };
  const byState = (Object.keys(byStateAcc) as USState[]).reduce(
    (out, k) => {
      const acc = byStateAcc[k];
      out[k] = acc.denom > 0 ? rates(acc) : { passRate: 0, weightedRate: 0 };
      return out;
    },
    {} as Record<USState, { passRate: number; weightedRate: number }>,
  );

  const byCategory: Record<string, { passRate: number; failCount: number }> = {};
  for (const cat of Object.keys(byCategoryAcc)) {
    const a = byCategoryAcc[cat];
    byCategory[cat] = {
      passRate: a.denom === 0 ? 0 : a.passOrCond / a.denom,
      failCount: a.denom - a.passOrCond,
    };
  }

  const rootCausePareto = (Object.keys(failByCode) as FailCode[])
    .map((code) => ({ code, count: failByCode[code] }))
    .sort((a, b) => b.count - a.count);

  return {
    runAt: new Date().toISOString(),
    profiles: input.map((i) => i.report),
    byState,
    byCategory,
    rootCausePareto,
    overallPassRate: overallRates.passRate,
    overallWeightedRate: overallRates.weightedRate,
    meetsTarget:
      hasData &&
      overallRates.passRate >= 0.989 &&
      overallRates.weightedRate >= 0.975,
    hasData,
    totalComparisons: overall.denom,
  };
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function renderRollupMd(rollup: RollupReport): string {
  const lines: string[] = [];
  lines.push('# Parity Audit — Rollup Dashboard');
  lines.push('');
  lines.push(`**Run at:** ${rollup.runAt}`);
  lines.push(`**Profiles evaluated:** ${rollup.profiles.length}`);
  lines.push(`**Field comparisons recorded:** ${rollup.totalComparisons}`);
  lines.push('');

  if (!rollup.hasData) {
    lines.push('## ⚠ NO DATA');
    lines.push('');
    lines.push(
      'Zero field comparisons were recorded across all profiles and plans. This run cannot assess parity — most likely causes: MPF returned no plans (search POST 4xx or empty result), Plan Match Supabase query returned no matching rows, or every comparison was flagged N/A.',
    );
    lines.push('');
    lines.push('## Verdict');
    lines.push('');
    lines.push('**NO DATA — cannot assess parity.** Investigate the audit log before drawing conclusions.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Overall');
  lines.push('');
  lines.push(`- Unweighted pass rate: **${fmtPct(rollup.overallPassRate)}**`);
  lines.push(`- Weighted rate: **${fmtPct(rollup.overallWeightedRate)}**`);
  lines.push(
    `- Target (≥ 98.9% unweighted, ≥ 97.5% weighted): **${rollup.meetsTarget ? 'MET' : 'NOT MET'}**`,
  );
  lines.push('');

  lines.push('## Per-State');
  lines.push('');
  lines.push('| State | Pass Rate | Weighted Rate |');
  lines.push('| --- | --- | --- |');
  const stateKeys: USState[] = ['NC', 'TX', 'GA'];
  for (const s of stateKeys) {
    const r = rollup.byState[s];
    lines.push(`| ${s} | ${fmtPct(r.passRate)} | ${fmtPct(r.weightedRate)} |`);
  }
  lines.push('');

  lines.push('## Per-Category');
  lines.push('');
  lines.push('| Category | Pass Rate | Fail Count |');
  lines.push('| --- | --- | --- |');
  const cats = Object.keys(rollup.byCategory).sort();
  for (const cat of cats) {
    const r = rollup.byCategory[cat];
    lines.push(`| ${cat} | ${fmtPct(r.passRate)} | ${r.failCount} |`);
  }
  lines.push('');

  lines.push('## Root-Cause Pareto');
  lines.push('');
  if (rollup.rootCausePareto.length === 0) {
    lines.push('_No failures recorded._');
  } else {
    lines.push('| Fail Code | Count |');
    lines.push('| --- | --- |');
    for (const row of rollup.rootCausePareto) {
      lines.push(`| ${row.code} | ${row.count} |`);
    }
  }
  lines.push('');

  lines.push('## Verdict');
  lines.push('');
  if (rollup.meetsTarget) {
    lines.push('**Target MET.** Plan Match parity meets or exceeds thresholds.');
  } else {
    lines.push(
      '**Target NOT MET.** Address root-cause Pareto entries in priority order.',
    );
  }
  lines.push('');

  return lines.join('\n');
}
