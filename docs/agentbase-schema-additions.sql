-- AgentBase Supabase (wyyasqvouvdcovttzfnv) schema additions required
-- by /api/agentbase-recommend when it writes the CMS audit trail.
--
-- ⚠ NOT auto-run. Apply on the AgentBase project once Rob has reviewed.
-- Until applied, the recommend endpoint falls back to its legacy column
-- set (plan_name/plan_id/carrier/year) and skips the activity-log
-- insert, returning audit_columns_missing=true / audit_logged=false in
-- the response so the broker UI can surface a soft warning.

-- ─── clients: recommendation + compliance timestamps ────────────────
-- Mirrors the existing plan_name/plan_id/carrier set so old views keep
-- rendering, while giving the AgentBase CRM a dedicated audit column
-- for the recommended-at timestamp + the two CMS-required compliance
-- stamps (SOA confirmation, call-recording disclosure).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS recommended_plan_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS recommended_plan_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS recommended_carrier TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS recommended_contract_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS recommended_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS soa_confirmed_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS call_recording_disclosed_at TIMESTAMPTZ;

-- ─── planmatch_activity_log: per-enrollment audit row ───────────────
-- One row per "plan_recommended" event. compliance + session_summary
-- are JSONB so the shape can evolve without further migrations. The
-- recommend endpoint inserts into this table whenever a payload
-- carries either compliance or session_summary.
CREATE TABLE IF NOT EXISTS planmatch_activity_log (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  selected_plan_id TEXT,
  selected_plan_name TEXT,
  carrier TEXT,
  contract_id TEXT,
  compliance JSONB,
  session_summary JSONB,
  source TEXT NOT NULL DEFAULT 'planmatch',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_planmatch_activity_log_client
  ON planmatch_activity_log (client_id, created_at DESC);
