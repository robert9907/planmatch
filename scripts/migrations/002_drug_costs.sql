-- 002_drug_costs.sql
--
-- Two tables supporting the Medicare.gov drug-cost integration:
--
--   rxcui_ndcs       — persistent rxcui → NDC[] lookup so we only hit
--                      RxNorm /ndcs.json once per drug.
--   drug_cost_cache  — per-(plan_ids + rxcuis + pharmacy) response
--                      cache, 24h TTL. Keys on a sha256 hash of the
--                      normalized input so order doesn't matter.
--
-- Run in the Supabase SQL Editor — service-role JWT can't do DDL via
-- PostgREST. Safe to re-run (IF NOT EXISTS everywhere).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rxcui_ndcs (
  rxcui       text PRIMARY KEY,
  ndcs        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rxcui_ndcs_updated ON rxcui_ndcs (updated_at);

CREATE TABLE IF NOT EXISTS drug_cost_cache (
  cache_key   text PRIMARY KEY,
  -- Raw normalized response from the upstream call. Readers read this
  -- straight back without re-parsing, so freshness lives entirely in
  -- expires_at.
  payload     jsonb NOT NULL,
  -- 'live' = successful Medicare.gov fetch, 'rate_limited' = 429
  -- (short TTL), 'error' = other failure (we cache failures briefly to
  -- avoid stampeding a flaky origin).
  source      text NOT NULL DEFAULT 'live'
              CHECK (source IN ('live', 'rate_limited', 'error')),
  created_at  timestamptz DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drug_cost_cache_expires
  ON drug_cost_cache (expires_at);

-- Auto-touch updated_at on rxcui_ndcs upserts.
CREATE OR REPLACE FUNCTION rxcui_ndcs_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_rxcui_ndcs_touch ON rxcui_ndcs;
CREATE TRIGGER trg_rxcui_ndcs_touch
  BEFORE UPDATE ON rxcui_ndcs
  FOR EACH ROW EXECUTE FUNCTION rxcui_ndcs_touch();

-- ═══ VERIFICATION ═══════════════════════════════════════════════════
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name IN ('rxcui_ndcs', 'drug_cost_cache')
  ORDER BY table_name, ordinal_position;

SELECT 'rxcui_ndcs' AS table, COUNT(*) AS rows FROM rxcui_ndcs
UNION ALL
SELECT 'drug_cost_cache', COUNT(*) FROM drug_cost_cache;
