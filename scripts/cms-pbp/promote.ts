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
import { BENEFIT_MAP, resolveColumns } from './benefit_map.js';

// Pre-fetches the actual column list for every source_table referenced
// by BENEFIT_MAP, so the SQL builder can replace references to missing
// columns with NULL. CMS's column naming pattern (pbp_{sub}_copay_amt_mc_min,
// etc.) doesn't apply uniformly — many sub-letters omit auth/refer
// columns or use suffixed variants (b9a_auth_ohs_yn vs the assumed
// b9a_auth_yn). Querying the schema once per promote is cheap and
// keeps the benefit_map declarative.
async function loadTableColumnSets(): Promise<Map<string, Set<string>>> {
  const tables = [...new Set(BENEFIT_MAP.map((b) => b.source_table))];
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
        CASE WHEN d.pbp_d_mco_pay_reduct_yn = 'Y'
             THEN d.pbp_d_mco_pay_reduct_amt::numeric(10,2)
        END                                            AS part_b_giveback,
        CASE WHEN d.pbp_d_out_pocket_amt_yn = 'Y'
             THEN d.pbp_d_out_pocket_amt::numeric(12,2)
        END                                            AS moop_in_network,
        CASE WHEN d.pbp_d_comb_max_enr_amt_yn = 'Y'
             THEN d.pbp_d_comb_max_enr_amt::numeric(12,2)
        END                                            AS moop_combined,
        CASE WHEN d.pbp_d_oon_max_enr_oopc_yn = 'Y'
             THEN d.pbp_d_oon_max_enr_oopc_amt::numeric(12,2)
        END                                            AS moop_oon,
        CASE WHEN d.pbp_d_maxenr_oopc_yn = 'Y'
             THEN d.pbp_d_maxenr_oopc_amt::numeric(12,2)
        END                                            AS moop_non_network,
        CASE WHEN d.pbp_d_ann_deduct_yn = 'Y'
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
        ${branches.length === 0 ? `SELECT NULL::text, NULL::text, NULL::text, NULL::smallint, NULL::text, NULL::text, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::boolean, NULL::boolean, NULL::text, NULL::bigint WHERE false` : branches.join('\nUNION ALL\n')}
      `;
      const br = await c.query(sql, [planYear, releaseId]);
      counts.pbp_benefits_v2 = br.rowCount ?? 0;
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
