-- Composite (plan_id, npi) index on pm_provider_network_cache.
--
-- The plan-brain-data aggregator does:
--   .in('plan_id', contractPlans).in('npi', npis)
-- which is the hot path when scoring a candidate set in CompareScreen.
--
-- Existing indexes:
--   pkey (plan_id, segment_id, npi, source)   — segment_id between cols
--                                               blocks a clean (plan_id,
--                                               npi) range scan.
--   npi_idx (npi)                              — good when npis are few.
--   plan_idx (plan_id, segment_id)             — no npi.
--
-- For workloads that fan out across many plans for a small provider
-- set, the npi index already wins. For larger npi lists or plan-heavy
-- queries the planner needs a direct match — this composite gives it
-- one. Cheap to maintain (~240k rows today).
create index if not exists pm_provider_network_cache_plan_npi_idx
  on public.pm_provider_network_cache (plan_id, npi);
