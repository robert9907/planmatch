-- 012_ssa_fips_crosswalk.sql
--
-- SSA-county-code → FIPS-county-code crosswalk. Bridges:
--   • CMS PBP / SPUF data — keyed on 5-char SSA county codes
--   • pm_plans / pm_zip_county / pm_provider_network_cache — keyed on
--     5-char FIPS county codes (state 2-digit + county 3-digit)
--
-- Without this bridge, pbp_planarea_v2 (SSA-keyed) can't be joined
-- to pm_plans or pm_zip_county to answer "what plans serve ZIP X" or
-- "what counties does plan Y serve" — the ID systems don't overlap.
--
-- Source data:
--   • SSA codes + state name + county name: cms_spuf_geographic_locator
--     (3,279 rows, populated by the SPUF importer)
--   • FIPS codes + state alpha + county name: Census Bureau
--     national_county.txt (3,235 US counties)
--
-- Loaded by scripts/load-ssa-fips-crosswalk.ts after this migration
-- runs. Re-run the loader whenever cms_spuf_geographic_locator gets a
-- new release (annually with each SPUF refresh — county codes are
-- stable but new territories or renamed counties may appear).

CREATE TABLE IF NOT EXISTS ssa_fips_crosswalk (
  ssa_code     text NOT NULL,                  -- 5-char SSA county code
  fips         text NOT NULL,                  -- 5-char FIPS (state 2 + county 3)
  state        text NOT NULL,                  -- 2-char USPS alpha
  state_fips   text NOT NULL,                  -- 2-char FIPS state
  county_fips  text NOT NULL,                  -- 3-char FIPS county
  county_name  text NOT NULL,                  -- bare name, no "County"/"Parish" suffix
  PRIMARY KEY (ssa_code)
);

-- Both directions need to be cheap. SSA→FIPS is the primary lookup
-- (PBP/SPUF queries). FIPS→SSA is many-to-one in some cases (CMS
-- subdivides large counties like Los Angeles into multiple SSA
-- service areas), so the index is non-unique.
CREATE INDEX IF NOT EXISTS idx_ssa_fips_crosswalk_fips
  ON ssa_fips_crosswalk (fips);
CREATE INDEX IF NOT EXISTS idx_ssa_fips_crosswalk_state_county
  ON ssa_fips_crosswalk (state, lower(county_name));

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'ssa_fips_crosswalk'
ORDER BY ordinal_position;

-- After loader runs:
-- SELECT * FROM ssa_fips_crosswalk WHERE state='NC' AND county_name='Durham';
-- should return ssa_code='34310', fips='37063'
