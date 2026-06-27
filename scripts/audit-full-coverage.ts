// scripts/audit-full-coverage.ts
//
// Full read-only audit of pm_* tables for NC/TX/GA plans. Steps:
//   1. List every pm_* table and its columns (via PostgREST OpenAPI)
//   2. Audit core pm_plans fields
//   3. Audit benefit-category coverage in pm_plan_benefits
//   5. Check duplicate contract_id+plan_id+segment_id rows
//   6. Verify drug-coverage plans (plan_type ilike '%PD%') have pm_formulary rows
//
// Output: _tmp/audit-report.md  (plus _tmp/audit-data.json for tooling)

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL / KEY');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
  maxPages = 500,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let pageNum = 0; pageNum < maxPages; pageNum += 1) {
    const from = pageNum * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await pageFn(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

mkdirSync('_tmp', { recursive: true });
const sections: string[] = [];
const dataDump: Record<string, unknown> = {};
const STATES = ['NC', 'TX', 'GA'] as const;

function H(level: number, title: string) {
  sections.push(`\n${'#'.repeat(level)} ${title}\n`);
}
function P(text: string) {
  sections.push(text + '\n');
}
function tableMd(rows: Record<string, unknown>[], cols?: string[]): string {
  if (rows.length === 0) return '_no rows_\n';
  const keys = cols ?? Object.keys(rows[0]);
  const head = `| ${keys.join(' | ')} |`;
  const sep = `| ${keys.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((r) =>
      `| ${keys
        .map((k) => String(r[k] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '))
        .join(' | ')} |`,
    )
    .join('\n');
  return `${head}\n${sep}\n${body}\n`;
}

interface PlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  plan_name: string | null;
  plan_type: string | null;
  state: string | null;
  carrier: string | null;
  parent_organization: string | null;
  monthly_premium: number | null;
  annual_deductible: number | null;
  drug_deductible: number | null;
  moop: number | null;
  star_rating: number | null;
  snp: boolean | null;
  snp_type: string | null;
  county_name: string | null;
}

// ── Step 1 ────────────────────────────────────────────────────────
async function step1Schema() {
  H(1, 'Step 1 — pm_* schema dump');
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const swagger = (await res.json()) as {
    definitions?: Record<string, { properties?: Record<string, { type?: string; format?: string }> }>;
  };
  const defs = swagger.definitions ?? {};
  const pmTables = Object.keys(defs).filter((n) => n.startsWith('pm_')).sort();
  dataDump.pmTables = pmTables;
  P(`Found **${pmTables.length}** tables/views starting with \`pm_\`.\n`);

  const summary = pmTables.map((t) => ({
    table: t,
    columns: Object.keys(defs[t].properties ?? {}).length,
  }));
  sections.push(tableMd(summary as unknown as Record<string, unknown>[]));

  for (const t of pmTables) {
    const props = defs[t].properties ?? {};
    const cols = Object.entries(props).map(([name, spec]) => ({
      column: name,
      type: spec.format ?? spec.type ?? '?',
    }));
    H(3, `\`${t}\` — ${cols.length} columns`);
    sections.push(tableMd(cols, ['column', 'type']));
  }
  return pmTables;
}

// ── Step 2 ────────────────────────────────────────────────────────
const CORE_FIELDS = [
  'plan_name',
  'contract_id',
  'plan_id',
  'plan_type',
  'state',
  'organization_name', // ← user asked; mapped to carrier|parent_organization
  'premium',           // ← maps to monthly_premium
  'moop',
  'deductible',        // ← maps to annual_deductible|drug_deductible
  'star_rating',
] as const;

const FIELD_ALIASES: Record<string, (keyof PlanRow)[]> = {
  plan_name: ['plan_name'],
  contract_id: ['contract_id'],
  plan_id: ['plan_id'],
  plan_type: ['plan_type'],
  state: ['state'],
  organization_name: ['carrier', 'parent_organization'],
  premium: ['monthly_premium'],
  moop: ['moop'],
  deductible: ['annual_deductible', 'drug_deductible'],
  star_rating: ['star_rating'],
};

function filled(p: PlanRow, aliases: (keyof PlanRow)[]): boolean {
  return aliases.some((a) => {
    const v = p[a];
    if (v === null || v === undefined) return false;
    if (typeof v === 'string' && v.trim() === '') return false;
    return true;
  });
}

async function step2Core() {
  H(1, 'Step 2 — core field gaps in pm_plans (NC/TX/GA)');

  const plans = await paginate<PlanRow>((from, to) =>
    sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, plan_type, state, carrier, parent_organization, monthly_premium, annual_deductible, drug_deductible, moop, star_rating, snp, snp_type, county_name',
      )
      .in('state', STATES as unknown as string[])
      .range(from, to),
  );
  P(`Fetched **${plans.length}** rows from \`pm_plans\` for NC/TX/GA.\n`);
  P(`Note: pm_plans has one row per contract+plan+segment+county — duplicates across counties are expected.`);
  dataDump.planRowCount = plans.length;

  // Audit at contract+plan+segment level (county dup is expected for service area)
  const byKey = new Map<string, PlanRow>();
  for (const p of plans) {
    const seg = p.segment_id ?? '0';
    const k = `${p.contract_id}-${p.plan_id}-${seg}`;
    if (!byKey.has(k)) byKey.set(k, p);
  }
  const unique = [...byKey.values()];
  P(`Unique contract+plan+segment combinations: **${unique.length}**\n`);
  dataDump.uniquePlanCount = unique.length;

  H(2, 'Null counts per field (across all NC/TX/GA unique plans)');
  const summary = CORE_FIELDS.map((f) => {
    const aliases = FIELD_ALIASES[f];
    let missing = 0;
    for (const p of unique) if (!filled(p, aliases)) missing += 1;
    return {
      field: f,
      mapped_to: aliases.join(' | '),
      total: unique.length,
      missing,
      pct: `${((missing / Math.max(1, unique.length)) * 100).toFixed(1)}%`,
    };
  });
  sections.push(tableMd(summary as unknown as Record<string, unknown>[]));
  dataDump.coreFieldSummary = summary;

  H(2, 'Per-state breakdown');
  const perState: Record<string, unknown[]> = {};
  for (const st of STATES) {
    const pool = unique.filter((p) => p.state === st);
    perState[st] = CORE_FIELDS.map((f) => {
      const aliases = FIELD_ALIASES[f];
      let missing = 0;
      for (const p of pool) if (!filled(p, aliases)) missing += 1;
      return { field: f, total: pool.length, missing };
    });
    H(3, `${st} — ${pool.length} unique plans`);
    sections.push(tableMd(perState[st] as unknown as Record<string, unknown>[]));
  }
  dataDump.perStateCore = perState;

  H(2, 'Plans missing one or more core fields');
  const incomplete: { key: string; carrier: string; state: string; type: string; missing: string }[] = [];
  for (const p of unique) {
    const miss: string[] = [];
    for (const f of CORE_FIELDS) {
      if (!filled(p, FIELD_ALIASES[f])) miss.push(f);
    }
    if (miss.length > 0) {
      incomplete.push({
        key: `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`,
        carrier: p.carrier ?? p.parent_organization ?? '?',
        state: p.state ?? '?',
        type: p.plan_type ?? '?',
        missing: miss.join(', '),
      });
    }
  }
  P(`**${incomplete.length}** unique plans are missing at least 1 core field. First 50:\n`);
  sections.push(tableMd(incomplete.slice(0, 50) as unknown as Record<string, unknown>[]));
  dataDump.incompletePlans = incomplete;

  return unique;
}

// ── Step 3 ────────────────────────────────────────────────────────
async function step3Benefits(plans: PlanRow[]) {
  H(1, 'Step 3 — benefit category coverage (pm_plan_benefits)');

  const contractIds = [...new Set(plans.map((p) => p.contract_id))];
  const planIds = [...new Set(plans.map((p) => p.plan_id))];

  const benefits = await paginate<{
    contract_id: string;
    plan_id: string;
    segment_id: string | null;
    benefit_category: string | null;
    copay: number | null;
    coinsurance: number | null;
  }>((from, to) =>
    sb
      .from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id, benefit_category, copay, coinsurance')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .range(from, to),
  );
  P(`Fetched **${benefits.length}** rows from \`pm_plan_benefits\`.\n`);
  dataDump.benefitRowCount = benefits.length;

  const categorySet = new Set<string>();
  const benefitByPlan = new Map<string, Set<string>>();
  for (const b of benefits) {
    if (!b.benefit_category) continue;
    categorySet.add(b.benefit_category);
    const k = `${b.contract_id}-${b.plan_id}`;
    if (!benefitByPlan.has(k)) benefitByPlan.set(k, new Set());
    benefitByPlan.get(k)!.add(b.benefit_category);
  }

  H(2, 'All distinct benefit categories present');
  P([...categorySet].sort().map((c) => `- \`${c}\``).join('\n') + '\n');
  dataDump.benefitCategories = [...categorySet].sort();

  const ASKED: { label: string; matches: RegExp[] }[] = [
    { label: 'Primary care copay', matches: [/primary[_ ]?care/i, /^pcp/i] },
    { label: 'Specialist copay', matches: [/specialist/i] },
    { label: 'Dental', matches: [/dental/i] },
    { label: 'Vision', matches: [/vision/i, /\beye/i] },
    { label: 'Hearing', matches: [/hearing/i] },
    { label: 'OTC', matches: [/\botc\b/i, /over[-_ ]?the[-_ ]?counter/i] },
    { label: 'Fitness', matches: [/fitness/i, /silver/i, /gym/i] },
    { label: 'Telehealth', matches: [/telehealth/i, /telemed/i, /virtual/i] },
    { label: 'Inpatient hospital', matches: [/inpatient/i] },
    { label: 'Outpatient', matches: [/outpatient/i] },
    { label: 'Emergency', matches: [/emergency/i, /\ber\b/i] },
    { label: 'Ambulance', matches: [/ambulance/i] },
    { label: 'Mental health', matches: [/mental/i, /behavior/i, /psych/i] },
    { label: 'Lab', matches: [/\blab\b/i, /laborator/i] },
    { label: 'Imaging / radiology', matches: [/imaging/i, /radiolog/i, /x[-_ ]?ray/i, /diagnostic/i] },
    { label: 'Skilled nursing (SNF)', matches: [/snf/i, /skilled/i] },
    { label: 'Drug coverage (Part D)', matches: [/drug/i, /part[_ ]?d/i, /formulary/i, /\brx\b/i] },
    { label: 'Transportation', matches: [/transport/i] },
    { label: 'Meals', matches: [/meal/i] },
    { label: 'MOOP / out-of-pocket', matches: [/moop/i, /out[-_ ]?of[-_ ]?pocket/i] },
  ];

  H(2, 'Plans missing each asked-about category');
  const rows = ASKED.map((a) => {
    const matchedCats = [...categorySet].filter((c) => a.matches.some((m) => m.test(c)));
    let missing = 0;
    for (const p of plans) {
      const k = `${p.contract_id}-${p.plan_id}`;
      const planCats = benefitByPlan.get(k);
      const has = planCats && matchedCats.some((c) => planCats.has(c));
      if (!has) missing += 1;
    }
    return {
      category: a.label,
      matched_keys: matchedCats.join(', ') || '_no matching key_',
      plansMissing: missing,
      pct: `${((missing / Math.max(1, plans.length)) * 100).toFixed(1)}%`,
    };
  });
  sections.push(tableMd(rows as unknown as Record<string, unknown>[]));
  dataDump.benefitGapByCategory = rows;

  H(2, 'SNP type / indicator presence');
  const snpRows = plans.filter((p) => p.snp === true || (p.snp_type && p.snp_type !== ''));
  P(`Plans flagged SNP: **${snpRows.length}** of ${plans.length}`);
  const snpTypeCount = new Map<string, number>();
  for (const p of snpRows) {
    const key = p.snp_type ?? '(snp=true, no type)';
    snpTypeCount.set(key, (snpTypeCount.get(key) ?? 0) + 1);
  }
  sections.push(
    tableMd([...snpTypeCount.entries()].map(([snp_type, n]) => ({ snp_type, plans: n }))),
  );

  H(2, 'Plans with ZERO benefit rows in pm_plan_benefits');
  const noBenefitsPlans: { key: string; carrier: string; state: string; type: string }[] = [];
  for (const p of plans) {
    const k = `${p.contract_id}-${p.plan_id}`;
    if (!benefitByPlan.has(k)) {
      noBenefitsPlans.push({
        key: `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`,
        carrier: p.carrier ?? '?',
        state: p.state ?? '?',
        type: p.plan_type ?? '?',
      });
    }
  }
  P(`**${noBenefitsPlans.length}** plans have NO rows in pm_plan_benefits. First 50:`);
  sections.push(tableMd(noBenefitsPlans.slice(0, 50) as unknown as Record<string, unknown>[]));
  dataDump.noBenefitsPlans = noBenefitsPlans;
}

// ── Step 5 ────────────────────────────────────────────────────────
async function step5Dups(plansAllRows: PlanRow[]) {
  H(1, 'Step 5 — duplicate contract_id + plan_id');

  // Pull every state too (not just NC/TX/GA) to check global dup health
  P('Within NC/TX/GA: pm_plans naturally has one row per service-area county, so duplicate contract+plan rows are expected. We dedupe by contract+plan+segment+county for the "true" dup test.\n');
  const cps = new Map<string, number>(); // contract+plan+segment
  const cpsc = new Map<string, number>(); // contract+plan+segment+county
  for (const p of plansAllRows) {
    const k1 = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`;
    cps.set(k1, (cps.get(k1) ?? 0) + 1);
    const k2 = `${k1}::${p.county_name ?? '?'}`;
    cpsc.set(k2, (cpsc.get(k2) ?? 0) + 1);
  }

  const top = [...cps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => ({ contract_plan_segment: k, county_rows: n }));
  P('Top contract+plan+segment row counts (each row is one county — these should match the plan service area):');
  sections.push(tableMd(top as unknown as Record<string, unknown>[]));

  const trueDups = [...cpsc.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  P(`\ncontract+plan+segment+county TRUE duplicates (should be 0): **${trueDups.length}**`);
  sections.push(
    tableMd(
      trueDups.slice(0, 30).map(([k, n]) => ({ key: k, rows: n })) as unknown as Record<string, unknown>[],
    ),
  );
  dataDump.trueDupCount = trueDups.length;
}

// ── Step 6 ────────────────────────────────────────────────────────
async function step6Formulary(uniquePlans: PlanRow[]) {
  H(1, 'Step 6 — drug-coverage plans missing pm_formulary rows');

  // No has_part_d column — infer from plan_type. CMS plan_type strings include
  // " w/ Rx" or "MA-PD" or "PDP" for plans with drug coverage. We treat anything
  // that explicitly says "no drug coverage" (or is missing /Rx/ and /PD/) as MA-only.
  const drugPlans = uniquePlans.filter((p) => {
    const t = (p.plan_type ?? '').toLowerCase();
    if (!t) return false;
    if (/no.{0,5}(rx|drug|part.?d)/.test(t)) return false;
    return /rx|part.?d|mapd|pdp/.test(t);
  });
  P(`Plans inferred as drug-coverage (plan_type matches /rx|part.?d|mapd|pdp/): **${drugPlans.length}**`);

  H(2, 'plan_type value breakdown (NC/TX/GA unique plans)');
  const typeCount = new Map<string, number>();
  for (const p of uniquePlans) {
    const k = p.plan_type ?? '(null)';
    typeCount.set(k, (typeCount.get(k) ?? 0) + 1);
  }
  sections.push(
    tableMd(
      [...typeCount.entries()].sort((a, b) => b[1] - a[1]).map(([plan_type, n]) => ({ plan_type, plans: n })) as unknown as Record<string, unknown>[],
    ),
  );

  const drugContractIds = [...new Set(drugPlans.map((p) => p.contract_id))];
  if (drugContractIds.length === 0) {
    P('No drug-coverage plans inferred — skipping formulary check.');
    return;
  }
  const formularyRows = await paginate<{ contract_id: string; plan_id: string }>((from, to) =>
    sb
      .from('pm_formulary')
      .select('contract_id, plan_id')
      .in('contract_id', drugContractIds)
      .range(from, to),
  );
  const formCount = new Map<string, number>();
  for (const f of formularyRows) {
    const k = `${f.contract_id}-${f.plan_id}`;
    formCount.set(k, (formCount.get(k) ?? 0) + 1);
  }
  P(`Fetched **${formularyRows.length}** formulary key rows.`);

  const missing: { key: string; carrier: string; state: string; type: string }[] = [];
  const partial: { key: string; carrier: string; state: string; type: string; rows: number }[] = [];
  for (const p of drugPlans) {
    const k = `${p.contract_id}-${p.plan_id}`;
    const n = formCount.get(k) ?? 0;
    if (n === 0) {
      missing.push({
        key: `${k}-${p.segment_id ?? '0'}`,
        carrier: p.carrier ?? '?',
        state: p.state ?? '?',
        type: p.plan_type ?? '?',
      });
    } else if (n < 50) {
      partial.push({
        key: `${k}-${p.segment_id ?? '0'}`,
        carrier: p.carrier ?? '?',
        state: p.state ?? '?',
        type: p.plan_type ?? '?',
        rows: n,
      });
    }
  }
  P(`\n**${missing.length}** drug-coverage plans have ZERO formulary rows. First 50:`);
  sections.push(tableMd(missing.slice(0, 50) as unknown as Record<string, unknown>[]));
  P(`\n**${partial.length}** drug-coverage plans have <50 formulary rows (suspicious). First 50:`);
  sections.push(tableMd(partial.slice(0, 50) as unknown as Record<string, unknown>[]));
  dataDump.formularyMissing = missing;
  dataDump.formularyPartial = partial;
}

// ── main ──────────────────────────────────────────────────────────
async function main() {
  H(1, 'Plan Match Full Coverage Audit');
  P(`Generated ${new Date().toISOString()}`);
  P(`Supabase: \`${url}\``);
  await step1Schema();

  // Pull all NC/TX/GA plans once (used by 2/3/5/6)
  const allRows = await paginate<PlanRow>((from, to) =>
    sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, plan_type, state, carrier, parent_organization, monthly_premium, annual_deductible, drug_deductible, moop, star_rating, snp, snp_type, county_name',
      )
      .in('state', STATES as unknown as string[])
      .range(from, to),
  );

  // Step 2 (unique by contract+plan+segment)
  const byKey = new Map<string, PlanRow>();
  for (const p of allRows) {
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`;
    if (!byKey.has(k)) byKey.set(k, p);
  }
  const unique = [...byKey.values()];

  // Re-run step 2 reporting (we have plans already so use a streamlined version)
  await step2CoreReport(allRows, unique);
  await step3Benefits(unique);
  await step5Dups(allRows);
  await step6Formulary(unique);

  writeFileSync('_tmp/audit-report.md', sections.join('\n'));
  writeFileSync('_tmp/audit-data.json', JSON.stringify(dataDump, null, 2));
  console.log('\nReport written → _tmp/audit-report.md');
  console.log('Raw data    → _tmp/audit-data.json');
}

async function step2CoreReport(allRows: PlanRow[], unique: PlanRow[]) {
  H(1, 'Step 2 — core field gaps in pm_plans (NC/TX/GA)');
  P(`Total rows in pm_plans for NC/TX/GA: **${allRows.length}** (one row per service-area county).`);
  P(`Unique contract+plan+segment combinations: **${unique.length}**\n`);
  dataDump.planRowCount = allRows.length;
  dataDump.uniquePlanCount = unique.length;

  H(2, 'Null counts per field (all NC/TX/GA unique plans)');
  const summary = CORE_FIELDS.map((f) => {
    const aliases = FIELD_ALIASES[f];
    let missing = 0;
    for (const p of unique) if (!filled(p, aliases)) missing += 1;
    return {
      field: f,
      mapped_to: aliases.join(' | '),
      total: unique.length,
      missing,
      pct: `${((missing / Math.max(1, unique.length)) * 100).toFixed(1)}%`,
    };
  });
  sections.push(tableMd(summary as unknown as Record<string, unknown>[]));
  dataDump.coreFieldSummary = summary;

  H(2, 'Per-state breakdown');
  const perState: Record<string, unknown[]> = {};
  for (const st of STATES) {
    const pool = unique.filter((p) => p.state === st);
    perState[st] = CORE_FIELDS.map((f) => {
      const aliases = FIELD_ALIASES[f];
      let missing = 0;
      for (const p of pool) if (!filled(p, aliases)) missing += 1;
      return { field: f, total: pool.length, missing };
    });
    H(3, `${st} — ${pool.length} unique plans`);
    sections.push(tableMd(perState[st] as unknown as Record<string, unknown>[]));
  }
  dataDump.perStateCore = perState;

  H(2, 'Plans missing one or more core fields');
  const incomplete: { key: string; carrier: string; state: string; type: string; missing: string }[] = [];
  for (const p of unique) {
    const miss: string[] = [];
    for (const f of CORE_FIELDS) {
      if (!filled(p, FIELD_ALIASES[f])) miss.push(f);
    }
    if (miss.length > 0) {
      incomplete.push({
        key: `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`,
        carrier: p.carrier ?? p.parent_organization ?? '?',
        state: p.state ?? '?',
        type: p.plan_type ?? '?',
        missing: miss.join(', '),
      });
    }
  }
  P(`**${incomplete.length}** unique plans missing at least one core field. First 50:\n`);
  sections.push(tableMd(incomplete.slice(0, 50) as unknown as Record<string, unknown>[]));
  dataDump.incompletePlans = incomplete;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
