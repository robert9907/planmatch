// scripts/cms-pbp/promote.ts
//
// Promotes a loaded PBP release into the pbp_*_v2 app tables. Single
// transaction, mirrors the SPUF promote shape.
//
//   1. pbp_plan_facts_v2  ← Section A + Section D
//   2. pbp_benefits_v2     ← UNION ALL across BENEFIT_MAP entries
//   3. pbp_planarea_v2     ← PlanArea
//   4. flip release status: prior 'active' → 'superseded', new → 'active'
//
// All deletes are scoped to plan_year + (for benefits) source='cms_pbp'
// so carrier-side rows in pbp_benefits_v2 (if anyone ever writes them
// there) survive the swap.

import { withTransaction, withClient } from '../cms-spuf/pg.js';
import {
  BENEFIT_MAP,
  resolveColumns,
  RX_TIER_PHARMACIES,
  RX_TIER_NUMBERS,
  RX_TIER_SOURCE_TABLE,
  RX_TIER_ID_COLUMN,
} from './benefit_map.js';

// Pre-fetches the actual column list for every source_table referenced
// by BENEFIT_MAP, so the SQL builder can replace references to missing
// columns with NULL. CMS's column naming pattern (pbp_{sub}_copay_amt_mc_min,
// etc.) doesn't apply uniformly — many sub-letters omit auth/refer
// columns or use suffixed variants (b9a_auth_ohs_yn vs the assumed
// b9a_auth_yn). Querying the schema once per promote is cheap and
// keeps the benefit_map declarative.
// Tables referenced by interval-tiered inpatient/SNF logic in promote.
// Loaded alongside BENEFIT_MAP tables so column-existence checks work
// for the multi-row emission branches.
const INTERVAL_TABLES = ['pbp_b1a_inpat_hosp', 'pbp_b1b_inpat_hosp', 'pbp_b2_snf'];

async function loadTableColumnSets(): Promise<Map<string, Set<string>>> {
  const tables = [
    ...new Set([
      ...BENEFIT_MAP.map((b) => b.source_table),
      ...INTERVAL_TABLES,
      RX_TIER_SOURCE_TABLE,
    ]),
  ];
  const out = new Map<string, Set<string>>();
  await withClient(async (c) => {
    for (const t of tables) {
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [t],
      );
      out.set(t, new Set(r.rows.map((row) => row.column_name as string)));
    }
  });
  return out;
}

function colOrNull(col: string | null, exists: Set<string> | undefined, cast: string): string {
  if (!col || !exists?.has(col)) return `NULL::${cast}`;
  return `t.${col}::${cast}`;
}

function boolColOrNull(col: string | null, exists: Set<string> | undefined): string {
  if (!col || !exists?.has(col)) return 'NULL::boolean';
  return `(t.${col} = 'Y')`;
}

export async function promote(opts: {
  releaseId: number;
  planYear: number;
}): Promise<{ counts: Record<string, number> }> {
  const { releaseId, planYear } = opts;
  const counts: Record<string, number> = {};

  await withTransaction(async (c) => {
    await c.query(`SET LOCAL statement_timeout = 0`);
    await c.query(`SET LOCAL work_mem = '128MB'`);

    // ─── pbp_plan_facts_v2 ────────────────────────────────────────────
    //
    // One row per plan. Premium / MOOP / deductibles from Section D,
    // carrier name + plan-type / SNP from Section A.

    await c.query(`DELETE FROM pbp_plan_facts_v2 WHERE plan_year = $1`, [planYear]);
    const fr = await c.query(
      `
      INSERT INTO pbp_plan_facts_v2 (
        contract_id, plan_id, segment_id, plan_year,
        premium_part_c, premium_b_only, part_b_giveback,
        moop_in_network, moop_combined, moop_oon, moop_non_network,
        annual_deductible, rx_deductible,
        plan_type, snp_type, ben_cov, contract_name, plan_name,
        release_id
      )
      SELECT
        d.pbp_a_hnumber          AS contract_id,
        d.pbp_a_plan_identifier  AS plan_id,
        d.segment_id,
        $1::smallint             AS plan_year,
        d.pbp_d_mplusc_premium::numeric(10,2)        AS premium_part_c,
        d.pbp_d_mplusc_bonly_premium::numeric(10,2)  AS premium_b_only,
        -- CMS Section D _yn flags use '1' (yes) / '2' (no), NOT 'Y'/'N'
        -- like the per-benefit flags in Section B. Verified across 2026
        -- distribution: pbp_d_out_pocket_amt_yn='1' for 6,964 plans,
        -- '2' for 36, null for 420.
        CASE WHEN d.pbp_d_mco_pay_reduct_yn = '1'
             THEN d.pbp_d_mco_pay_reduct_amt::numeric(10,2)
        END                                            AS part_b_giveback,
        CASE WHEN d.pbp_d_out_pocket_amt_yn = '1'
             THEN d.pbp_d_out_pocket_amt::numeric(12,2)
        END                                            AS moop_in_network,
        CASE WHEN d.pbp_d_comb_max_enr_amt_yn = '1'
             THEN d.pbp_d_comb_max_enr_amt::numeric(12,2)
        END                                            AS moop_combined,
        CASE WHEN d.pbp_d_oon_max_enr_oopc_yn = '1'
             THEN d.pbp_d_oon_max_enr_oopc_amt::numeric(12,2)
        END                                            AS moop_oon,
        CASE WHEN d.pbp_d_maxenr_oopc_yn = '1'
             THEN d.pbp_d_maxenr_oopc_amt::numeric(12,2)
        END                                            AS moop_non_network,
        CASE WHEN d.pbp_d_ann_deduct_yn = '1'
             THEN d.pbp_d_ann_deduct_amt::numeric(10,2)
        END                                            AS annual_deductible,
        NULL::numeric(10,2)                            AS rx_deductible,
        a.pbp_a_plan_type        AS plan_type,
        CASE a.pbp_a_special_need_plan_type
          WHEN '1' THEN 'C-SNP'
          WHEN '2' THEN 'D-SNP'
          WHEN '3' THEN 'I-SNP'
          ELSE NULL
        END                       AS snp_type,
        a.pbp_a_ben_cov           AS ben_cov,
        a.pbp_a_org_marketing_name AS contract_name,
        a.pbp_a_plan_name         AS plan_name,
        $2::bigint                AS release_id
      FROM pbp_section_d d
      JOIN pbp_section_a a
        ON a.release_id = d.release_id
       AND a.pbp_a_hnumber          = d.pbp_a_hnumber
       AND a.pbp_a_plan_identifier  = d.pbp_a_plan_identifier
       AND a.segment_id             = d.segment_id
      WHERE d.release_id = $2
      `,
      [planYear, releaseId],
    );
    counts.pbp_plan_facts_v2 = fr.rowCount ?? 0;

    // ─── pbp_benefits_v2 ──────────────────────────────────────────────
    //
    // Build a UNION ALL of one SELECT per BENEFIT_MAP entry. Each
    // SELECT produces rows like:
    //   (contract, plan, segment, year, benefit_type, tier_id,
    //    copay, copay_max, coins, coins_max, ...)
    //
    // CMS coinsurance is published as percent (0–100, e.g. 25 = 25%).
    // Keep that convention — pm_plan_benefits and the legacy
    // pbp_benefits both store percent.

    await c.query(
      `DELETE FROM pbp_benefits_v2 WHERE plan_year = $1 AND source = 'cms_pbp'`,
      [planYear],
    );

    if (BENEFIT_MAP.length > 0) {
      // Resolve missing columns up-front. Many sub-letters lack
      // *_auth_yn / *_refer_yn or use suffixed variants the standard
      // pattern doesn't predict.
      const liveCols = await loadTableColumnSets();
      const branches: string[] = [];
      const skippedEntries: string[] = [];

      for (const entry of BENEFIT_MAP) {
        const cols = resolveColumns(entry);
        const tableCols = liveCols.get(entry.source_table);
        if (!tableCols) {
          skippedEntries.push(`${entry.benefit_type} (table ${entry.source_table} missing)`);
          continue;
        }
        // Skip entries whose copay AND coinsurance columns both don't
        // exist — there's nothing to project.
        const copayExists = cols.copay && tableCols.has(cols.copay);
        const coinsExists = cols.coinsurance && tableCols.has(cols.coinsurance);
        if (!copayExists && !coinsExists) {
          skippedEntries.push(`${entry.benefit_type} (no copay/coins cols match)`);
          continue;
        }

        const tierIdLit = entry.tier_id == null ? `NULL::text` : `'${entry.tier_id}'::text`;
        const copayExpr = colOrNull(cols.copay, tableCols, 'numeric(10,2)');
        const copayMaxExpr = colOrNull(cols.copay_max, tableCols, 'numeric(10,2)');
        const coinsExpr = colOrNull(cols.coinsurance, tableCols, 'numeric(6,3)');
        const coinsMaxExpr = colOrNull(cols.coinsurance_max, tableCols, 'numeric(6,3)');
        const authExpr = boolColOrNull(cols.prior_auth, tableCols);
        const referExpr = boolColOrNull(cols.referral, tableCols);

        // WHERE filter — only emit rows where at least one cost-share
        // value is set. Built from whichever cols actually exist.
        const whereTerms: string[] = [];
        if (copayExists) whereTerms.push(`t.${cols.copay} IS NOT NULL`);
        if (coinsExists) whereTerms.push(`t.${cols.coinsurance} IS NOT NULL`);
        const whereExpr = whereTerms.join(' OR ');

        branches.push(`
          SELECT
            t.pbp_a_hnumber                  AS contract_id,
            t.pbp_a_plan_identifier          AS plan_id,
            t.segment_id,
            $1::smallint                      AS plan_year,
            '${entry.benefit_type}'::text     AS benefit_type,
            ${tierIdLit}                      AS tier_id,
            ${copayExpr}                      AS copay,
            ${copayMaxExpr}                   AS copay_max,
            ${coinsExpr}                      AS coinsurance,
            ${coinsMaxExpr}                   AS coinsurance_max,
            ${authExpr}                       AS prior_auth,
            ${referExpr}                      AS referral_required,
            'cms_pbp'::text                   AS source,
            $2::bigint                        AS release_id
          FROM ${entry.source_table} t
          WHERE t.release_id = $2 AND (${whereExpr})
        `);
      }

      if (skippedEntries.length > 0) {
        console.log(`[promote] benefit_map: skipped ${skippedEntries.length} entries (col mismatch): ${skippedEntries.join('; ')}`);
      }

      // ─── Interval-tiered inpatient + SNF ──────────────────────────
      //
      // CMS PBP stores inpatient (b1a acute, b1b psych) and SNF (b2)
      // cost-share by day-range: e.g. $325/day days 1-8, then $0/day
      // days 9-90. Each plan can declare up to 3 intervals × 3 tiers
      // (most plans use tier 1 only). We emit one v2 row per non-null
      // interval, with tier_id = 'days_{bgnd}-{endd}' to match the
      // legacy scrape-medicare-gov pattern (inpatient_day_stage_*).
      //
      // Three benefit_types — inpatient_acute, inpatient_psych, snf —
      // each generated from 3 interval branches (tier 1 only). Plans
      // using tier 2/3 (SNF with multiple tiers) are a follow-up.
      const intervalSpecs = [
        { benefit_type: 'inpatient_acute',  table: 'pbp_b1a_inpat_hosp', prefix: 'pbp_b1a' },
        { benefit_type: 'inpatient_psych',  table: 'pbp_b1b_inpat_hosp', prefix: 'pbp_b1b' },
        { benefit_type: 'snf',              table: 'pbp_b2_snf',         prefix: 'pbp_b2'  },
      ];
      const intervalBranches: string[] = [];
      for (const spec of intervalSpecs) {
        const tableCols = liveCols.get(spec.table) ?? new Set<string>();
        for (let i = 1; i <= 3; i++) {
          const amtCol  = `${spec.prefix}_copay_mcs_amt_int${i}_t1`;
          const bgndCol = `${spec.prefix}_copay_mcs_bgnd_int${i}_t1`;
          const enddCol = `${spec.prefix}_copay_mcs_endd_int${i}_t1`;
          const coinsCol = `${spec.prefix}_coins_mcs_pct_int${i}_t1`;
          // Skip if the copay-amt column doesn't exist for this benefit
          // (b1b in particular may have fewer interval columns).
          if (!tableCols.has(amtCol)) continue;
          const authCol = `${spec.prefix}_auth_yn`;
          const referCol = `${spec.prefix}_refer_yn`;
          const authExpr = tableCols.has(authCol) ? `(t.${authCol} = '1')` : 'NULL::boolean';
          const referExpr = tableCols.has(referCol) ? `(t.${referCol} = '1')` : 'NULL::boolean';
          const coinsExpr = tableCols.has(coinsCol) ? `t.${coinsCol}::numeric(6,3)` : 'NULL::numeric(6,3)';
          intervalBranches.push(`
            SELECT
              t.pbp_a_hnumber                                        AS contract_id,
              t.pbp_a_plan_identifier                                AS plan_id,
              t.segment_id,
              $1::smallint                                            AS plan_year,
              '${spec.benefit_type}'::text                            AS benefit_type,
              ('days_' || regexp_replace(t.${bgndCol}::text, '\\.0+$', '')
                       || '-' ||
                regexp_replace(t.${enddCol}::text, '\\.0+$', ''))::text AS tier_id,
              t.${amtCol}::numeric(10,2)                              AS copay,
              NULL::numeric(10,2)                                     AS copay_max,
              ${coinsExpr}                                            AS coinsurance,
              NULL::numeric(6,3)                                      AS coinsurance_max,
              ${authExpr}                                             AS prior_auth,
              ${referExpr}                                            AS referral_required,
              'cms_pbp'::text                                         AS source,
              $2::bigint                                              AS release_id
            FROM ${spec.table} t
            WHERE t.release_id = $2
              AND t.${amtCol} IS NOT NULL
              AND t.${bgndCol} IS NOT NULL
              AND t.${enddCol} IS NOT NULL
          `);
        }
      }

      // ─── Part D Rx tiers (pbp_mrx_tier) ───────────────────────────
      //
      // pbp_mrx_tier is long: one row per (plan, mrx_tier_id) instead of
      // one wide row per plan. We emit 6 tiers × 2 pharmacy variants =
      // up to 12 branches, each filtering by mrx_tier_id = N and
      // projecting the retail standard or retail preferred 30-day
      // columns. tier_id encodes the pharmacy variant
      // ('retail_standard' / 'retail_preferred'); the Part D tier
      // number lives in benefit_type ('rx_tier_1' .. 'rx_tier_6').
      // Each branch only fires when at least one of (copay, coins) is
      // populated for that pharmacy variant — plans that file only
      // standard cost-share won't get a phantom preferred row.
      const rxTierCols = liveCols.get(RX_TIER_SOURCE_TABLE) ?? new Set<string>();
      const rxTierBranches: string[] = [];
      const rxSkipped: string[] = [];
      if (rxTierCols.size === 0) {
        rxSkipped.push(`${RX_TIER_SOURCE_TABLE} (table missing — skipping all rx_tier branches)`);
      } else if (!rxTierCols.has(RX_TIER_ID_COLUMN)) {
        rxSkipped.push(`${RX_TIER_SOURCE_TABLE}.${RX_TIER_ID_COLUMN} (filter column missing)`);
      } else {
        for (const tier of RX_TIER_NUMBERS) {
          for (const ph of RX_TIER_PHARMACIES) {
            const copayExists = rxTierCols.has(ph.copay_col);
            const coinsExists = rxTierCols.has(ph.coinsurance_col);
            if (!copayExists && !coinsExists) {
              rxSkipped.push(`rx_tier_${tier}/${ph.tier_id} (no copay/coins col match)`);
              continue;
            }
            const copayExpr = copayExists ? `t.${ph.copay_col}::numeric(10,2)` : 'NULL::numeric(10,2)';
            const coinsExpr = coinsExists ? `t.${ph.coinsurance_col}::numeric(6,3)` : 'NULL::numeric(6,3)';
            const whereTerms: string[] = [];
            if (copayExists) whereTerms.push(`t.${ph.copay_col} IS NOT NULL`);
            if (coinsExists) whereTerms.push(`t.${ph.coinsurance_col} IS NOT NULL`);
            // mrx_tier_id is stored as numeric in the landing table (the
            // dictionary types it as NUM); cast to int for the equality
            // filter so '1' / '01' / 1 all match.
            rxTierBranches.push(`
              SELECT
                t.pbp_a_hnumber                  AS contract_id,
                t.pbp_a_plan_identifier          AS plan_id,
                t.segment_id,
                $1::smallint                      AS plan_year,
                'rx_tier_${tier}'::text           AS benefit_type,
                '${ph.tier_id}'::text             AS tier_id,
                ${copayExpr}                      AS copay,
                NULL::numeric(10,2)               AS copay_max,
                ${coinsExpr}                      AS coinsurance,
                NULL::numeric(6,3)                AS coinsurance_max,
                NULL::boolean                     AS prior_auth,
                NULL::boolean                     AS referral_required,
                'cms_pbp'::text                   AS source,
                $2::bigint                        AS release_id
              FROM ${RX_TIER_SOURCE_TABLE} t
              WHERE t.release_id = $2
                AND t.${RX_TIER_ID_COLUMN}::int = ${tier}
                AND (${whereTerms.join(' OR ')})
            `);
          }
        }
      }
      if (rxSkipped.length > 0) {
        console.log(`[promote] rx_tier: skipped ${rxSkipped.length} branch(es): ${rxSkipped.join('; ')}`);
      }

      const allBranches = [...branches, ...intervalBranches, ...rxTierBranches];
      // ON CONFLICT works against the unique INDEX, not a PRIMARY KEY,
      // so the COALESCE-on-tier_id index needs a matching ON CONFLICT
      // expression. Since the index column-list includes a function
      // (COALESCE), the constraint is referenced by its column list.
      const sql = `
        INSERT INTO pbp_benefits_v2 (
          contract_id, plan_id, segment_id, plan_year,
          benefit_type, tier_id,
          copay, copay_max, coinsurance, coinsurance_max,
          prior_auth, referral_required,
          source, release_id
        )
        ${allBranches.length === 0 ? `SELECT NULL::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::text, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::boolean, NULL::boolean, NULL::text, NULL::bigint WHERE false` : allBranches.join('\nUNION ALL\n')}
      `;
      const br = await c.query(sql, [planYear, releaseId]);
      counts.pbp_benefits_v2 = br.rowCount ?? 0;
      if (intervalBranches.length > 0) {
        console.log(`[promote] interval-tiered: ${intervalBranches.length} branches across inpatient_acute / inpatient_psych / snf`);
      }
      if (rxTierBranches.length > 0) {
        console.log(`[promote] rx_tier: ${rxTierBranches.length} branches across tiers 1..6 × {retail_standard, retail_preferred}`);
      }
    }

    // ─── pbp_planarea_v2 ──────────────────────────────────────────────

    await c.query(`DELETE FROM pbp_planarea_v2 WHERE plan_year = $1`, [planYear]);
    const par = await c.query(
      `
      INSERT INTO pbp_planarea_v2 (
        contract_id, plan_id, segment_id, plan_year,
        county_code, county_name, state, ben_cov, release_id
      )
      SELECT DISTINCT ON (pbp_a_hnumber, pbp_a_plan_identifier, segment_id, county_code)
        pbp_a_hnumber, pbp_a_plan_identifier, segment_id,
        $1::smallint, county_code, county, stcd, pbp_a_ben_cov, $2::bigint
      FROM pbp_planarea
      WHERE release_id = $2
      ORDER BY pbp_a_hnumber, pbp_a_plan_identifier, segment_id, county_code, id
      `,
      [planYear, releaseId],
    );
    counts.pbp_planarea_v2 = par.rowCount ?? 0;

    // ─── Release status flip ──────────────────────────────────────────

    await c.query(
      `UPDATE pbp_releases
          SET status = 'superseded'
        WHERE plan_year = $1
          AND status = 'active'
          AND release_id <> $2`,
      [planYear, releaseId],
    );
    await c.query(
      `UPDATE pbp_releases
          SET status = 'active', promoted_at = now()
        WHERE release_id = $1`,
      [releaseId],
    );
  });

  return { counts };
}
