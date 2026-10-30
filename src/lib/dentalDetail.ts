// Routine dental DETAIL — pure formatting for the per-category drill-down.
//
// The one-line routine-dental SUMMARY ("Comprehensive dental · $1,500 yearly
// max · …", benefits.dental.description) still leads; this module is the
// drill-down BEHIND it: per-category covered Y/N, in-/out-of-network cost,
// frequency, prior auth, plus the dental deductible + annual max.
//
// Source: benefits.dental.detail (pm_plan_benefits.detail jsonb, decoded from
// CMS PBP B16b preventive + B16c comprehensive at ingest). This NEVER touches
// the Medicare-covered dental (B16a) medical cost-share row — that lives at
// benefits.medical.dental_medicare_covered and has its own OON logic.
//
// Missing-data rule (CMS data is ground truth; missing stays missing): any
// absent cell → "Not filed — call to verify". A covered service with both
// copay and coinsurance null renders $0 ONLY when the filing genuinely says
// $0 (copay === 0); an all-null cost is "Not filed — call to verify", never a
// fabricated $0. The whole detail absent → a single "Not filed — call to
// verify" line, not an empty table.

import type { DentalDetail, DentalServiceDetail } from '@/types/plans';

export const DENTAL_NOT_FILED = 'Not filed — call to verify';

// Row order + labels for the detail table. "Preventive" is an aggregate of
// the B16b preventive_services; the rest are single B16c comprehensive
// categories. Mirrors the consumer b16-dental key→label mapping.
export interface DentalDetailRowSpec {
  /** Stable key for React. */
  key: string;
  label: string;
  /** 'preventive' = aggregate preventive_services; else a comprehensive key. */
  kind: 'preventive' | 'comprehensive';
  /** For comprehensive rows: the detail jsonb key (rs/end/peri/…). */
  compKey?: string;
}

export const DENTAL_DETAIL_ROWS: readonly DentalDetailRowSpec[] = [
  { key: 'preventive', label: 'Preventive', kind: 'preventive' },
  { key: 'rs', label: 'Fillings', kind: 'comprehensive', compKey: 'rs' },
  { key: 'end', label: 'Root canals', kind: 'comprehensive', compKey: 'end' },
  { key: 'peri', label: 'Gum care', kind: 'comprehensive', compKey: 'peri' },
  { key: 'omsg', label: 'Extractions', kind: 'comprehensive', compKey: 'omsg' },
  { key: 'prf', label: 'Crowns & bridges', kind: 'comprehensive', compKey: 'prf' },
  { key: 'prm', label: 'Dentures', kind: 'comprehensive', compKey: 'prm' },
  { key: 'impl', label: 'Implants', kind: 'comprehensive', compKey: 'impl' },
] as const;

export interface DentalDetailCell {
  covered: 'Yes' | 'No' | 'Not filed';
  inNetwork: string;
  outNetwork: string;
  frequency: string;
  priorAuth: string;
}

export interface DentalDetailRow extends DentalDetailCell {
  key: string;
  label: string;
}

export interface DentalDetailView {
  /** True when the plan filed NO structured detail — render one line only. */
  empty: boolean;
  rows: DentalDetailRow[];
  /** Summary lines rendered above/beside the table. */
  deductible: {
    preventive: string;
    comprehensive: string;
  };
  annualMax: string;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** A covered service's cost from its {copay, coinsurance} block. */
function formatCost(cost: { copay: number | null; coinsurance: number | null } | null | undefined): string {
  if (!cost) return DENTAL_NOT_FILED;
  const { copay, coinsurance } = cost;
  // Coinsurance wins its own display when filed (> 0 or genuinely 0%).
  if (coinsurance != null) return `${coinsurance}%`;
  if (copay != null) return money(copay);
  return DENTAL_NOT_FILED;
}

/** Frequency {num, per} where `per` is a month count (string). 12 → "year". */
export function formatDentalFrequency(freq: { num: number | null; per: string | null } | null | undefined): string {
  if (!freq || freq.num == null || freq.per == null || String(freq.per).trim() === '') return DENTAL_NOT_FILED;
  const num = freq.num;
  const months = Number(freq.per);
  if (!Number.isFinite(months) || months <= 0) return DENTAL_NOT_FILED;
  const unit = months === 12 ? 'year' : months === 1 ? 'month' : `${months} months`;
  return `${num} per ${unit}`;
}

/** One service object → a display cell. */
function cellFromService(svc: DentalServiceDetail | null | undefined): DentalDetailCell {
  if (!svc) {
    return { covered: 'Not filed', inNetwork: DENTAL_NOT_FILED, outNetwork: DENTAL_NOT_FILED, frequency: DENTAL_NOT_FILED, priorAuth: DENTAL_NOT_FILED };
  }
  if (svc.covered === false) {
    return { covered: 'No', inNetwork: 'Not covered', outNetwork: 'Not covered', frequency: '—', priorAuth: '—' };
  }
  return {
    covered: 'Yes',
    inNetwork: formatCost(svc.in_network),
    // out_of_network null → not filed (NOT "same as in-network").
    outNetwork: svc.out_of_network === undefined || svc.out_of_network === null ? DENTAL_NOT_FILED : formatCost(svc.out_of_network),
    frequency: formatDentalFrequency(svc.frequency),
    priorAuth: svc.prior_auth === true ? 'Yes' : svc.prior_auth === false ? 'No' : DENTAL_NOT_FILED,
  };
}

/** Aggregate the preventive_services block into one readable row. When the
 *  services disagree on a field we surface the worst/"varies" form so the
 *  row never overstates coverage. */
function preventiveCell(services: Record<string, DentalServiceDetail | null> | null | undefined): DentalDetailCell {
  const list = services
    ? Object.values(services).filter((s): s is DentalServiceDetail => s != null)
    : [];
  if (list.length === 0) {
    return { covered: 'Not filed', inNetwork: DENTAL_NOT_FILED, outNetwork: DENTAL_NOT_FILED, frequency: DENTAL_NOT_FILED, priorAuth: DENTAL_NOT_FILED };
  }
  const covered = list.filter((s) => s.covered !== false);
  if (covered.length === 0) {
    return { covered: 'No', inNetwork: 'Not covered', outNetwork: 'Not covered', frequency: '—', priorAuth: '—' };
  }
  const cells = covered.map(cellFromService);
  const agree = (pick: (c: DentalDetailCell) => string): string => {
    const vals = Array.from(new Set(cells.map(pick)));
    return vals.length === 1 ? vals[0] : 'Varies by service';
  };
  return {
    covered: 'Yes',
    inNetwork: agree((c) => c.inNetwork),
    outNetwork: agree((c) => c.outNetwork),
    frequency: agree((c) => c.frequency),
    priorAuth: agree((c) => c.priorAuth),
  };
}

function deductibleText(v: number | null | undefined): string {
  if (v == null) return DENTAL_NOT_FILED;
  return v === 0 ? '$0' : money(v);
}

function annualMaxText(detail: DentalDetail): string {
  const am = detail.annual_max;
  if (!am || am.amount == null) return DENTAL_NOT_FILED;
  if (am.amount === 0) return 'No annual maximum';
  return `${money(am.amount)}/yr`;
}

/** Build the full detail view for one plan. `detail` is benefits.dental.detail. */
export function buildDentalDetailView(detail: DentalDetail | null | undefined): DentalDetailView {
  if (!detail) {
    return {
      empty: true,
      rows: [],
      deductible: { preventive: DENTAL_NOT_FILED, comprehensive: DENTAL_NOT_FILED },
      annualMax: DENTAL_NOT_FILED,
    };
  }
  const prev = (detail.preventive_services ?? null) as Record<string, DentalServiceDetail | null> | null;
  const comp = (detail.comprehensive_categories ?? null) as Record<string, DentalServiceDetail | null> | null;

  const rows: DentalDetailRow[] = DENTAL_DETAIL_ROWS.map((spec) => {
    const cell =
      spec.kind === 'preventive'
        ? preventiveCell(prev)
        : cellFromService(comp?.[spec.compKey as string] ?? null);
    return { key: spec.key, label: spec.label, ...cell };
  });

  return {
    empty: false,
    rows,
    deductible: {
      preventive: deductibleText(detail.deductible?.preventive),
      comprehensive: deductibleText(detail.deductible?.comprehensive),
    },
    annualMax: annualMaxText(detail),
  };
}
