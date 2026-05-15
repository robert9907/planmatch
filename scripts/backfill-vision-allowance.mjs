// scripts/backfill-vision-allowance.mjs
//
// pm_plan_benefits.benefit_category='vision' rows have the eyewear
// allowance in the description ("· $300 eyewear allowance") but
// coverage_amount is null on most rows, which makes the brain score
// every plan's vision benefit as $0. Parse the dollar amount out and
// write it into coverage_amount so extractCategoryAnnualValue picks
// it up. Leave coverage_amount alone when the description has no
// allowance dollar value ("$0 exam copay" alone, or "Vision covered").
//
// Idempotent: only touches rows where coverage_amount IS NULL.
//
// Run: DATABASE_URL='...' node scripts/backfill-vision-allowance.mjs

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

// Match "$N eyewear allowance" or "$N allowance". Won't match "$N exam
// copay" — that's the visit cost-share, not the eyewear cap.
const ALLOWANCE_RE = /\$(\d+(?:\.\d+)?)\s+(?:eyewear\s+)?allowance/i;

function parseAllowance(description) {
  if (!description) return null;
  const m = description.match(ALLOWANCE_RE);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

async function main() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();

  const { rows } = await c.query(
    `select id, benefit_description
       from pm_plan_benefits
      where benefit_category='vision' and coverage_amount is null;`,
  );
  console.log(`Found ${rows.length} vision rows with null coverage_amount.`);

  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const dollar = parseAllowance(r.benefit_description);
    if (dollar == null) {
      skipped++;
      continue;
    }
    await c.query(
      `update pm_plan_benefits
          set coverage_amount=$2
        where id=$1;`,
      [r.id, dollar],
    );
    updated++;
  }

  console.log(`Updated:  ${updated}`);
  console.log(`Skipped:  ${skipped}  (no allowance in description)`);

  // Sanity audit.
  const audit = await c.query(`
    select
      count(*)::int as total,
      count(*) filter (where coverage_amount is null)::int as still_null,
      count(*) filter (where coverage_amount > 0)::int as has_value,
      avg(coverage_amount)::numeric(10,2) as avg_amount,
      min(coverage_amount) filter (where coverage_amount > 0) as min_amount,
      max(coverage_amount) as max_amount
    from pm_plan_benefits where benefit_category='vision';
  `);
  console.log('\nFinal vision-row state:', audit.rows[0]);

  await c.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
