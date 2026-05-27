-- Snap-to-Session: tag capture sessions with their owning agent-v3 session
-- so the broker can pivot back to the right open quote when reviewing
-- scanned medications and providers later. The column is optional —
-- pre-existing capture rows (consumer widget, v4 wizard) leave it null.

alter table public.capture_sessions
  add column if not exists agent_session_id text;

create index if not exists capture_sessions_agent_session_id_idx
  on public.capture_sessions (agent_session_id)
  where agent_session_id is not null;
