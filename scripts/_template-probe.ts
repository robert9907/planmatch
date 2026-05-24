// scripts/_template-probe.ts — starter for new diagnostic / probe scripts.
//
// Copy this file, rename, fill in main(). DO NOT use VITE_SUPABASE_URL
// or VITE_SUPABASE_ANON_KEY — this repo's .env.local uses unprefixed
// names for server-side scripts. (VITE_-prefixed envs are for client-
// side Vite injection at build time and never reach a node process.)
//
// Pattern is intentionally minimal:
//   • Inline .env.local reader (no dotenv dep — this repo doesn't
//     install it)
//   • SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (fall back to
//     SUPABASE_ANON_KEY for read-only probes)
//   • auth: persistSession/autoRefreshToken disabled — scripts run
//     once and exit
//   • PostgREST hard-caps queries at 1000 rows on this project. When
//     a query might exceed that (multi-plan fetches across pm_*
//     tables), use the paginate() helper below — it loops with
//     .range(from, to) until a page returns < 1000 rows. See
//     api/plans.ts:fetchAllRows for the production version.
//
// Run with: npx tsx scripts/your-probe.ts
//
// Existing reference probes that follow this pattern:
//   • scripts/audit-plan-benefits.ts
//   • scripts/probe-ozempic-formulary.ts
//   • scripts/diagnose-supabase-row-limit.ts

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

// ─── .env.local loader (no dotenv dep) ────────────────────────────
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Paginated fetch helper (defeats PostgREST's 1000-row cap) ────
// Pass a function that takes (from, to) and returns the Supabase
// query result. Loops until a page returns fewer than 1000 rows.
// Use for any pm_* table fetch where the result set could exceed
// 1000 rows (e.g., pm_plan_benefits / pbp_benefits / pm_formulary
// across a multi-plan pool, pm_drug_cost_cache across many drugs).
async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  const MAX_PAGES = 20;
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum += 1) {
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

// ─── Probe body ───────────────────────────────────────────────────
async function main() {
  // Example: dump first 5 Durham plans + their benefit_category set
  const { data: plans, error } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .limit(5);
  if (error) {
    console.error('Query failed:', error);
    process.exit(1);
  }
  console.table(plans ?? []);

  // Example of using paginate() when the row count could exceed 1000:
  //
  //   const contractIds = [...new Set(plans!.map(p => p.contract_id))];
  //   const planIds     = [...new Set(plans!.map(p => p.plan_id))];
  //   const benefits = await paginate<{ benefit_category: string }>((from, to) =>
  //     sb.from('pm_plan_benefits')
  //       .select('benefit_category')
  //       .in('contract_id', contractIds)
  //       .in('plan_id', planIds)
  //       .range(from, to)
  //   );
  //   console.log(`benefit rows: ${benefits.length}`);

  void paginate; // marker so the unused-import doesn't lint-fail
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
