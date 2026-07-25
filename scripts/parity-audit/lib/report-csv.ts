// Flat CSV export — one row per FieldComparison across all profiles/plans.

import type { ProfileReport } from '../types.js';

const HEADER = [
  'profile_id',
  'plan_key',
  'category',
  'field_path',
  'mpf_value',
  'pm_value',
  'status',
  'fail_code',
  'severity',
  'note',
];

function csvEscape(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) {
    s = '';
  } else if (typeof v === 'string') {
    s = v;
  } else if (typeof v === 'number' || typeof v === 'boolean') {
    s = String(v);
  } else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  if (s === '') return '';
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function renderComparisonsCsv(reports: ProfileReport[]): string {
  const rows: string[] = [];
  rows.push(HEADER.join(','));
  for (const report of reports) {
    for (const pc of report.planComparisons) {
      for (const c of pc.comparisons) {
        rows.push(
          [
            csvEscape(report.profileId),
            csvEscape(pc.planKey),
            csvEscape(c.category),
            csvEscape(c.fieldPath),
            csvEscape(c.mpfValue),
            csvEscape(c.pmValue),
            csvEscape(c.status),
            csvEscape(c.failCode ?? ''),
            csvEscape(c.severity),
            csvEscape(c.note ?? ''),
          ].join(','),
        );
      }
    }
  }
  return rows.join('\n') + '\n';
}
