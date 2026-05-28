// scripts/cms-spuf/promote.ts
//
// Promotes a loaded release into the pm_*_v2 app tables. Runs in a
// single transaction so readers never see partial state — they either
// see the prior release or the new one.
//
// Pattern per table:
//   1. DELETE FROM pm_*_v2 WHERE plan_year = $year
//   2. INSERT INTO pm_*_v2 SELECT … FROM cms_spuf_* WHERE release_id = $new
//
// Wide-to-long pivots: pm_beneficiary_cost_v2 and pm_insulin_cost_v2
// emit four rows per CMS row (one per pharmacy_type) via UNION ALL.
//
// Final step flips cms_spuf_releases status: prior 'active' →
// 'superseded', new 'loaded' → 'active'. The partial unique index
// uq_cms_spuf_releases_one_active enforces exactly-one-active per year.

import { withTransaction } from './pg.js';

export async function promote(opts: {
  releaseId: number;
  planYear: number;
}): Promise<{ counts: Record<string, number> }> {
  const { releaseId, planYear } = opts;
  const counts: Record<string, number> = {};

  await withTransaction(async (c) => {
    // Statement timeout disabled inside this transaction — multi-million-
    // row INSERTs take longer than the default 30s.
    await c.query(`SET LOCAL statement_timeout = 0`);
    // Bigger work_mem reduces external sort/hash spill to pgsql_tmp.
    // Supabase Pro ships ~4 MB default; bump to 256 MB for promote.
    await c.query(`SET LOCAL work_mem = '256MB'`);
    await c.query(`SET LOCAL maintenance_work_mem = '512MB'`);

    // ─── pm_formulary_v2 ──────────────────────────────────────────────
    //
    // Two-step strategy to keep intermediates small:
    //   1. drug_agg: aggregate basic_drugs to (formulary_id, rxcui)
    //      grain — ~250k rows from 1.12M source rows.
    //   2. plans: dedupe plan_information from (plan × county) to plan
    //      grain — ~5.5k unique plans from 112k source rows.
    //   3. main INSERT: plans × drug_agg = a few million rows, joined
    //      to beneficiary_cost for default cost-share, with EXISTS
    //      subqueries for the supplemental flags (cheaper than the
    //      previous LATERAL JOINs which fanned out before GROUP BY).
    //
    // Cost-share defaults come from beneficiary_cost at coverage_level=1
    // (initial), days_supply=1 (30-day), pharmacy_type=pref (preferred retail).

    await c.query(`DELETE FROM pm_formulary_v2 WHERE plan_year = $1`, [planYear]);
    const fr = await c.query(
      `
      WITH plans AS (
        SELECT DISTINCT contract_id, plan_id, segment_id, formulary_id
        FROM cms_spuf_plan_information
        WHERE release_id = $2
          AND plan_suppressed_yn = 'N'
      ),
      drug_agg AS (
        SELECT
          formulary_id,
          rxcui,
          MIN(tier_level_value)::smallint AS tier,
          bool_or(prior_authorization_yn = 'Y') AS prior_auth,
          bool_or(step_therapy_yn = 'Y') AS step_therapy,
          bool_or(quantity_limit_yn = 'Y') AS quantity_limit,
          MIN(NULLIF(regexp_replace(quantity_limit_amount, '[^0-9.]', '', 'g'), ''))::numeric(10,2)
            AS quantity_limit_amount,
          MIN(NULLIF(regexp_replace(quantity_limit_days, '[^0-9]', '', 'g'), ''))::smallint
            AS quantity_limit_days
        FROM cms_spuf_basic_drugs
        WHERE release_id = $2
        GROUP BY formulary_id, rxcui
      )
      INSERT INTO pm_formulary_v2 (
        contract_id, plan_id, segment_id, plan_year, formulary_id, rxcui,
        tier, prior_auth, step_therapy, quantity_limit,
        quantity_limit_amount, quantity_limit_days,
        copay_default, coinsurance_default,
        excluded_drug_supplemental, indication_restricted, release_id
      )
      SELECT
        p.contract_id, p.plan_id, p.segment_id, $1::smallint, p.formulary_id, d.rxcui,
        d.tier, d.prior_auth, d.step_therapy, d.quantity_limit,
        d.quantity_limit_amount, d.quantity_limit_days,
        CASE WHEN bc.cost_type_pref = 1 THEN bc.cost_amt_pref END AS copay_default,
        CASE WHEN bc.cost_type_pref = 2 THEN bc.cost_amt_pref END AS coinsurance_default,
        EXISTS (
          SELECT 1 FROM cms_spuf_excluded_drugs e
          WHERE e.release_id = $2 AND e.contract_id = p.contract_id
            AND e.plan_id = p.plan_id AND e.rxcui = d.rxcui
        ) AS excluded_drug_supplemental,
        EXISTS (
          SELECT 1 FROM cms_spuf_indication_based_coverage i
          WHERE i.release_id = $2 AND i.contract_id = p.contract_id
            AND i.plan_id = p.plan_id AND i.rxcui = d.rxcui
        ) AS indication_restricted,
        $2::bigint
      FROM plans p
      JOIN drug_agg d ON d.formulary_id = p.formulary_id
      LEFT JOIN cms_spuf_beneficiary_cost bc
        ON bc.release_id = $2
       AND bc.contract_id = p.contract_id
       AND bc.plan_id = p.plan_id
       AND bc.segment_id = p.segment_id
       AND bc.tier = d.tier
       AND bc.coverage_level = 1
       AND bc.days_supply = 1
      `,
      [planYear, releaseId],
    );
    counts.pm_formulary_v2 = fr.rowCount ?? 0;

    // ─── pm_rxcui_meta sync ───────────────────────────────────────────
    //
    // pm_formulary is a view: pm_formulary_v2 LEFT JOIN pm_rxcui_meta
    // USING (rxcui). pm_formulary_v2 carries no drug_name; names live
    // in pm_rxcui_meta. If that table isn't kept current, every
    // formulary read returns drug_name = null (which is what caused the
    // 19M-row backfill in scripts/backfill-formulary-drug-name.ts).
    //
    // Sync every rxcui present in pm_drugs into pm_rxcui_meta. This is
    // a no-op for unchanged rows and an upsert otherwise — keeps the
    // two name sources from drifting after each SPUF refresh. The
    // RxNorm import (pm_drugs source) runs independently; this step
    // just ensures the view's join target is current.
    const mr = await c.query(
      `
      INSERT INTO pm_rxcui_meta (rxcui, drug_name, fetched_at)
      SELECT rxcui, name, now() FROM pm_drugs
      ON CONFLICT (rxcui) DO UPDATE
        SET drug_name  = EXCLUDED.drug_name,
            fetched_at = EXCLUDED.fetched_at
      `,
    );
    counts.pm_rxcui_meta = mr.rowCount ?? 0;

    // ─── pm_beneficiary_cost_v2 (wide → long) ─────────────────────────

    await c.query(`DELETE FROM pm_beneficiary_cost_v2 WHERE plan_year = $1`, [planYear]);
    const bcr = await c.query(
      `
      INSERT INTO pm_beneficiary_cost_v2 (
        contract_id, plan_id, segment_id, plan_year,
        coverage_level, tier, days_supply_code, pharmacy_type,
        cost_type, cost_amount, cost_min, cost_max,
        tier_specialty, deductible_applies, gap_cov_tier, release_id
      )
      SELECT
        contract_id, plan_id, segment_id, $1::smallint, coverage_level, tier, days_supply,
        pt.kind AS pharmacy_type,
        pt.cost_type, pt.cost_amount,
        NULLIF(regexp_replace(pt.cost_min_text, '[^0-9.\-]', '', 'g'), '')::numeric(12,2) AS cost_min,
        pt.cost_max,
        tier_specialty_yn = 'Y' AS tier_specialty,
        ded_applies_yn = 'Y' AS deductible_applies,
        gap_cov_tier,
        $2::bigint AS release_id
      FROM cms_spuf_beneficiary_cost bc
      CROSS JOIN LATERAL (VALUES
        ('pref',         bc.cost_type_pref,         bc.cost_amt_pref,         bc.cost_min_amt_pref,         bc.cost_max_amt_pref),
        ('nonpref',      bc.cost_type_nonpref,      bc.cost_amt_nonpref,      bc.cost_min_amt_nonpref,      bc.cost_max_amt_nonpref),
        ('mail_pref',    bc.cost_type_mail_pref,    bc.cost_amt_mail_pref,    bc.cost_min_amt_mail_pref,    bc.cost_max_amt_mail_pref),
        ('mail_nonpref', bc.cost_type_mail_nonpref, bc.cost_amt_mail_nonpref, bc.cost_min_amt_mail_nonpref, bc.cost_max_amt_mail_nonpref)
      ) pt(kind, cost_type, cost_amount, cost_min_text, cost_max)
      WHERE bc.release_id = $2
      `,
      [planYear, releaseId],
    );
    counts.pm_beneficiary_cost_v2 = bcr.rowCount ?? 0;

    // ─── pm_pharmacy_network_v2 ───────────────────────────────────────
    //
    // npi = right 10 chars of pharmacy_number (CMS prepends two leading
    // chars to the bare 10-digit NPI).

    await c.query(`DELETE FROM pm_pharmacy_network_v2 WHERE plan_year = $1`, [planYear]);
    const pnr = await c.query(
      `
      INSERT INTO pm_pharmacy_network_v2 (
        contract_id, plan_id, segment_id, plan_year,
        npi, pharmacy_zipcode,
        preferred_retail, preferred_mail, retail, mail, in_area,
        release_id
      )
      SELECT
        contract_id, plan_id, segment_id, $1::smallint,
        right(pharmacy_number, 10) AS npi,
        pharmacy_zipcode,
        preferred_status_retail = 'Y',
        preferred_status_mail   = 'Y',
        pharmacy_retail         = 'Y',
        pharmacy_mail           = 'Y',
        in_area_flag            = 1,
        $2::bigint
      FROM cms_spuf_pharmacy_network
      WHERE release_id = $2
      `,
      [planYear, releaseId],
    );
    counts.pm_pharmacy_network_v2 = pnr.rowCount ?? 0;

    // ─── pm_pricing_v2 ────────────────────────────────────────────────

    await c.query(`DELETE FROM pm_pricing_v2 WHERE plan_year = $1`, [planYear]);
    const pr = await c.query(
      `
      INSERT INTO pm_pricing_v2 (contract_id, plan_id, segment_id, plan_year, ndc, days_supply, unit_cost, release_id)
      SELECT contract_id, plan_id, segment_id, $1::smallint, ndc, days_supply, unit_cost, $2::bigint
      FROM cms_spuf_pricing
      WHERE release_id = $2
      `,
      [planYear, releaseId],
    );
    counts.pm_pricing_v2 = pr.rowCount ?? 0;

    // ─── pm_insulin_cost_v2 (wide → long) ─────────────────────────────

    await c.query(`DELETE FROM pm_insulin_cost_v2 WHERE plan_year = $1`, [planYear]);
    const ir = await c.query(
      `
      INSERT INTO pm_insulin_cost_v2 (
        contract_id, plan_id, segment_id, plan_year, tier, days_supply_code, pharmacy_type, copay_amount, release_id
      )
      SELECT contract_id, plan_id, segment_id, $1::smallint, tier, days_supply, pt.kind, pt.copay, $2::bigint
      FROM cms_spuf_insulin_beneficiary_cost ic
      CROSS JOIN LATERAL (VALUES
        ('pref',         ic.copay_amt_pref_insln),
        ('nonpref',      ic.copay_amt_nonpref_insln),
        ('mail_pref',    ic.copay_amt_mail_pref_insln),
        ('mail_nonpref', ic.copay_amt_mail_nonpref_insln)
      ) pt(kind, copay)
      WHERE ic.release_id = $2
      `,
      [planYear, releaseId],
    );
    counts.pm_insulin_cost_v2 = ir.rowCount ?? 0;

    // ─── pm_indication_coverage_v2 ────────────────────────────────────

    await c.query(`DELETE FROM pm_indication_coverage_v2 WHERE plan_year = $1`, [planYear]);
    const icr = await c.query(
      `
      INSERT INTO pm_indication_coverage_v2 (contract_id, plan_id, plan_year, rxcui, disease, release_id)
      SELECT contract_id, plan_id, $1::smallint, rxcui, disease, $2::bigint
      FROM cms_spuf_indication_based_coverage
      WHERE release_id = $2
      `,
      [planYear, releaseId],
    );
    counts.pm_indication_coverage_v2 = icr.rowCount ?? 0;

    // ─── pm_geographic_locator_v2 ─────────────────────────────────────

    await c.query(`DELETE FROM pm_geographic_locator_v2 WHERE plan_year = $1`, [planYear]);
    const gr = await c.query(
      `
      INSERT INTO pm_geographic_locator_v2 (
        county_code, plan_year, statename, county,
        ma_region_code, ma_region, pdp_region_code, pdp_region, release_id
      )
      SELECT county_code, $1::smallint, statename, county,
             ma_region_code, ma_region, pdp_region_code, pdp_region, $2::bigint
      FROM cms_spuf_geographic_locator
      WHERE release_id = $2
      `,
      [planYear, releaseId],
    );
    counts.pm_geographic_locator_v2 = gr.rowCount ?? 0;

    // ─── pm_mapd_plan_set refresh ─────────────────────────────────────
    //
    // The consumer's api/plans-with-extras.ts uses pm_mapd_plan_set —
    // a tiny (~5k row) projection of distinct (contract_id, plan_id)
    // from pm_formulary_v2 — to detect MA-only plans (no Part D)
    // without paginating millions of formulary rows. Refresh it here
    // every promote so it stays consistent with the active release.
    // TRUNCATE + INSERT inside the transaction keeps it atomic with
    // the v2 swap.

    await c.query(`TRUNCATE pm_mapd_plan_set`);
    const mr = await c.query(`
      INSERT INTO pm_mapd_plan_set (contract_id, plan_id)
      SELECT DISTINCT contract_id, plan_id FROM pm_formulary_v2
    `);
    counts.pm_mapd_plan_set = mr.rowCount ?? 0;

    // ─── Release status flip ──────────────────────────────────────────
    //
    // Mark prior active release for this year as superseded BEFORE the
    // new one becomes active — the partial unique index forbids two
    // active rows on the same plan_year.

    await c.query(
      `UPDATE cms_spuf_releases
          SET status = 'superseded'
        WHERE plan_year = $1
          AND status = 'active'
          AND release_id <> $2`,
      [planYear, releaseId],
    );
    await c.query(
      `UPDATE cms_spuf_releases
          SET status = 'active', promoted_at = now()
        WHERE release_id = $1`,
      [releaseId],
    );
  });

  return { counts };
}
