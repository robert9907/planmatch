import type { PlanType } from '@/types/session';

export interface DisclaimerDef {
  id: string;
  title: string;
  when: string;
  /** Verbatim — must be read aloud without paraphrase. Substitution tokens wrapped in [brackets]. */
  body: string;
  /** If the body includes substitution tokens, the UI should expose them via replacements. */
  tokens?: string[];
}

export interface ComplianceItemDef {
  id: string;
  label: string;
  detail?: string;
  new2026?: boolean;
}

export interface ComplianceSection {
  key: string;
  title: string;
  items: ComplianceItemDef[];
}

// 3 verbatim CMS-required disclaimers. Never paraphrase.
export const DISCLAIMERS: DisclaimerDef[] = [
  {
    id: 'tpmo',
    title: 'TPMO disclaimer',
    when: 'Required within the first minute of the call.',
    body:
      'We do not offer every plan available in your area. Currently we represent ' +
      '[ORG_COUNT] organizations and [PLAN_COUNT] plans in your area. Please contact ' +
      'Medicare.gov, 1-800-MEDICARE (TTY: 1-877-486-2048) 24 hours a day, 7 days a ' +
      'week, or your local State Health Insurance Program (SHIP) to get information ' +
      'on all of your options.',
    tokens: ['ORG_COUNT', 'PLAN_COUNT'],
  },
  {
    id: 'call_recording',
    title: 'Call recording notice',
    when: 'Required at call start, before any plan discussion.',
    body:
      'This call may be recorded for quality assurance and compliance purposes. By ' +
      'continuing this call, you acknowledge that it may be recorded.',
  },
  {
    id: 'soa',
    title: 'Scope of Appointment confirmation',
    when: 'Required before discussing specific plans. SOA form must already be on file.',
    body:
      'Before we begin, I want to confirm the types of products we agreed to discuss ' +
      'today. You\u2019ve agreed to discuss Medicare Advantage plans, specifically ' +
      '[PLAN_TYPE_LONG]. Is that correct?',
    tokens: ['PLAN_TYPE_LONG'],
  },
];

// 13 discussion topic checkboxes across 6 sections. 2 flagged new for 2026
// (LIS/MSP eligibility and Medigap GI rights per CMS 2026 marketing rules).
export const SECTIONS: ComplianceSection[] = [
  {
    key: 'current',
    title: 'Current situation',
    items: [
      {
        id: 'curr_plan',
        label: 'Current plan coverage reviewed',
        detail: 'Confirmed what Dorothy has today — carrier, plan name, effective dates.',
      },
      {
        id: 'curr_meds',
        label: 'Current medication list confirmed',
        detail: 'Every Rx is on the sheet; any OTC / supplements noted for interactions.',
      },
      {
        id: 'curr_providers',
        label: 'Current providers and pharmacy confirmed',
        detail: 'Primary care, specialists, and preferred pharmacy captured.',
      },
    ],
  },
  {
    key: 'benefits',
    title: 'Plan benefits & costs',
    items: [
      {
        id: 'plan_benefits',
        label: 'Plan benefits explained',
        detail: 'Dental, vision, hearing, OTC, transportation, food card — walked through in plain language.',
      },
      {
        id: 'plan_costs',
        label: 'Premium, MOOP, and deductibles reviewed',
        detail: 'Monthly premium, in-network MOOP, Part D deductible (if any) — every number spoken aloud.',
      },
      {
        id: 'plan_network',
        label: 'In-network providers and facilities verified',
        detail: 'Ran each finalist plan against Dorothy\u2019s providers; exceptions or out-of-network providers flagged.',
      },
    ],
  },
  {
    key: 'rx',
    title: 'Prescription drug coverage',
    items: [
      {
        id: 'formulary_tiers',
        label: 'Formulary tiers and copays reviewed',
        detail: 'Each med looked up; tier + expected copay communicated for each finalist.',
      },
      {
        id: 'pharmacy_network',
        label: 'Preferred pharmacy network confirmed',
        detail: 'Dorothy\u2019s pharmacy is in-network (or a preferred alternative was identified).',
      },
    ],
  },
  {
    key: 'assistance',
    title: 'Low-income assistance',
    items: [
      {
        id: 'lis_msp',
        label: 'LIS / MSP eligibility discussed',
        detail:
          'Explained Extra Help (LIS) and Medicare Savings Program (MSP) — covered 2026 income limits ($22,590/yr LIS, $1,816/mo MSP) and referral path.',
        new2026: true,
      },
    ],
  },
  {
    key: 'medigap',
    title: 'Supplement / Medigap options',
    items: [
      {
        id: 'medigap_gi',
        label: 'Medigap Guaranteed Issue rights explained',
        detail:
          'Walked through 2026 GI triggers, trial rights, and the limited window to switch out of MA back to Medigap without underwriting.',
        new2026: true,
      },
    ],
  },
  {
    key: 'enrollment',
    title: 'Enrollment logistics',
    items: [
      {
        id: 'enrollment_period',
        label: 'Appropriate enrollment period confirmed',
        detail: 'AEP / OEP / SEP / IEP — the period Dorothy is using is named and documented.',
      },
      {
        id: 'effective_date',
        label: 'Effective date explained',
        detail: 'First day new coverage starts; overlap / gap risks with current plan addressed.',
      },
      {
        id: 'client_rights',
        label: 'Right to contact Medicare directly emphasized',
        detail: 'Dorothy knows she can call 1-800-MEDICARE (TTY 1-877-486-2048) or visit Medicare.gov at any time.',
      },
    ],
  },
];

export function allComplianceItemIds(): string[] {
  return SECTIONS.flatMap((s) => s.items.map((i) => i.id));
}

export function totalComplianceItems(): number {
  return allComplianceItemIds().length + DISCLAIMERS.length;
}

export function renderDisclaimerBody(
  def: DisclaimerDef,
  ctx: { orgCount: number; planCount: number; planType: PlanType | null },
): string {
  return def.body
    .replace('[ORG_COUNT]', String(ctx.orgCount))
    .replace('[PLAN_COUNT]', String(ctx.planCount))
    .replace('[PLAN_TYPE_LONG]', planTypeLong(ctx.planType));
}

function planTypeLong(planType: PlanType | null): string {
  switch (planType) {
    case 'DSNP':
      return 'Dual Special Needs Plans (D-SNP)';
    case 'MAPD':
      return 'Medicare Advantage with Prescription Drug coverage (MA-PD)';
    case 'MA':
      return 'Medicare Advantage plans (MA)';
    case 'PDP':
      return 'Standalone Part D prescription drug plans (PDP)';
    case 'MEDSUPP':
      return 'Medicare Supplement plans (Medigap)';
    default:
      return 'Medicare Advantage plans';
  }
}
