// Diagnose the remaining vision mismatches. Read-only.
// For every plan that's NOT A (match) or NONE (both silent):
//   - dump pm_plan_benefits.vision (max_coverage, coverage_amount, copay, desc)
//   - dump pbp_benefits_v2.vision_allowance (copay, description, source)
//   - dump CMS detail JSON's BENEFIT_VISION plan_limits_details
//   - classify into a root cause and group

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

function findDetail(contract: string, plan: string): { card: any; segment: string } | null {
  for (const dir of ['_tmp/medicare-gov-snp/detail', '_tmp/medicare-gov-mapd/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${contract}-${plan}-`)) continue;
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (j.response?.plan_card) return { card: j.response.plan_card, segment: String(j.response.plan_card.segment_id ?? '0') };
    }
  }
  return null;
}

interface Rec {
  contract_id: string; plan_id: string; carrier: string; plan_name: string;
  slice: string; cat: string; cms: any; pm: any;
}

async function main() {
  const audit = JSON.parse(readFileSync('_tmp/parity-data/_vision-audit.json', 'utf8')) as { records: Rec[] };
  const remaining = audit.records.filter((r) => r.cat !== 'A' && r.cat !== 'NONE');
  console.log(`Remaining non-A, non-NONE plans: ${remaining.length}`);
  console.log('─'.repeat(70));

  const grouped: Record<string, any[]> = {
    STALE_PM: [], DATA_GAP_UNFILLED: [], NO_DATA: [], EXTRACTOR_MISS: [],
    CMS_AMBIGUOUS: [], MERGE_STILL_BROKEN: [], UNCLASSIFIED: [],
  };

  for (const r of remaining) {
    const contract = r.contract_id, plan = r.plan_id;
    // pm_plan_benefits
    const { data: pmData } = await sb.from('pm_plan_benefits')
      .select('segment_id, copay, coinsurance, coverage_amount, max_coverage, benefit_description')
      .eq('benefit_category', 'vision').eq('contract_id', contract).eq('plan_id', plan);
    // pbp_benefits_v2 all vision-related
    const { data: pbpData } = await sb.from('pbp_benefits_v2')
      .select('segment_id, benefit_type, copay, coverage_amount, max_coverage, description, source')
      .eq('contract_id', contract).eq('plan_id', plan)
      .like('benefit_type', 'vision%');
    // CMS detail
    const det = findDetail(contract, plan);
    let cmsLimits: any[] = [];
    if (det) {
      for (const b of (det.card.ma_benefits ?? []).filter((x: any) => x.category === 'BENEFIT_VISION')) {
        for (const d of (b.plan_limits_details ?? [])) {
          cmsLimits.push({ svc: b.service, ...d });
        }
      }
    }

    const pmRow = pmData && pmData.length > 0 ? pmData[0] : null;
    const pbpVA = (pbpData ?? []).find((p: any) => p.benefit_type === 'vision_allowance');
    const cmsMax = (() => {
      let m: number | null = null;
      for (const d of cmsLimits) {
        if ((d.limit_type === 'BENEFIT_LIMIT_TYPE_COVERAGE' || d.limit_type === 'BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE') &&
            d.limit_period === 'BENEFIT_LIMIT_PERIOD_EVERY_YEAR' &&
            typeof d.limit_value === 'number') {
          if (m == null || d.limit_value > m) m = d.limit_value;
        }
      }
      return m;
    })();
    const cmsSees = r.cms?.eyewear_allowance_year ?? null;
    const pmSees = r.pm?.eyewear_allowance_year ?? 0;

    // Classify
    let rootCause: string;
    let note = '';
    if (cmsMax == null && cmsSees == null && pmSees > 0) {
      // CMS truly silent, PM has data from elsewhere (landscape or older PBP)
      // Check if cmsLimits has ANY numeric limit at all (maybe wrong limit_type?)
      const hasAnyNumeric = cmsLimits.some((d) => typeof d.limit_value === 'number' && d.limit_value > 0);
      if (hasAnyNumeric) {
        rootCause = 'EXTRACTOR_MISS';
        note = `CMS has numeric limits (types=${[...new Set(cmsLimits.map((d) => d.limit_type))].join(',')}) but not COVERAGE/COMBINED_COVERAGE/EVERY_YEAR`;
      } else {
        rootCause = 'NO_DATA';
        note = 'CMS ma_benefits[BENEFIT_VISION].plan_limits_details has no numeric limits';
      }
    } else if (cmsMax != null && pmSees === 0) {
      // CMS has value but PM shows $0. Split by pbp availability.
      if (pbpVA && typeof pbpVA.copay === 'number' && pbpVA.copay > 0) {
        rootCause = 'MERGE_STILL_BROKEN';
        note = `pbp copay=$${pbpVA.copay} but merge output shows $0`;
      } else {
        rootCause = 'DATA_GAP_UNFILLED';
        note = 'CMS has value; pm+pbp both missing';
      }
    } else if (cmsMax != null && pmSees !== cmsMax) {
      // Both have data, values differ
      if (pmRow && (pmRow.max_coverage != null || pmRow.coverage_amount != null)) {
        rootCause = 'STALE_PM';
        note = `pm_max=$${pmRow.max_coverage ?? pmRow.coverage_amount}  cms_max=$${cmsMax}`;
      } else if (pbpVA && typeof pbpVA.copay === 'number' && pbpVA.copay !== cmsMax) {
        rootCause = 'STALE_PBP';
        note = `pbp copay=$${pbpVA.copay}  cms_max=$${cmsMax}`;
      } else {
        rootCause = 'UNCLASSIFIED';
        note = `pm=${pmSees} cms=${cmsMax} pbp=${pbpVA?.copay ?? 'null'}`;
      }
    } else {
      rootCause = 'UNCLASSIFIED';
      note = `cat=${r.cat} pm=${pmSees} cms=${cmsMax} cmsSees=${cmsSees}`;
    }

    const bucket = grouped[rootCause] ?? (grouped[rootCause] = []);
    bucket.push({
      key: `${contract}-${plan}`, carrier: r.carrier, plan_name: r.plan_name, slice: r.slice, cat: r.cat,
      pm_max: pmRow?.max_coverage ?? null,
      pm_cov: pmRow?.coverage_amount ?? null,
      pm_desc: pmRow?.benefit_description ?? null,
      pbp_copay: pbpVA?.copay ?? null,
      pbp_source: pbpVA?.source ?? null,
      cms_max: cmsMax,
      cms_sees: cmsSees,
      cms_limit_types: [...new Set(cmsLimits.map((d) => `${d.limit_type}|${d.limit_period}`))],
      pm_sees: pmSees,
      note,
    });
  }

  for (const [cause, list] of Object.entries(grouped)) {
    if (list.length === 0) continue;
    console.log(`\n=== ${cause}  (${list.length}) ===`);
    for (const p of list) {
      console.log(`  ${p.key.padEnd(11)} ${p.slice.padEnd(14)} ${p.carrier.slice(0, 30).padEnd(30)}`);
      console.log(`    pm_sees=$${p.pm_sees}  cms_max=$${p.cms_max}  pbp_copay=${p.pbp_copay == null ? 'null' : '$' + p.pbp_copay}`);
      console.log(`    ${p.plan_name.slice(0, 70)}`);
      console.log(`    ${p.note}`);
      if (cause === 'EXTRACTOR_MISS') console.log(`    limit_types: ${p.cms_limit_types.join(', ')}`);
    }
  }
  const totals = Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length]));
  console.log('\nSummary:', totals);
}
main().catch((e) => { console.error(e); process.exit(1); });
