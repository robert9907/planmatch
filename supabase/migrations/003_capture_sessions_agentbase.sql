-- CRM-initiated Snap Link: capture sessions that originate from AgentBase's
-- client-detail "Send Snap Link" button rather than an agent-v3 quoting
-- session. The AgentBase clients.id is stamped here so capture-submit can
-- write extracted medications and providers back into the correct client
-- (via api/_lib/agentbaseDedup upsert helpers, verified_at = NULL).
--
-- clients.id is bigint in the AgentBase Supabase project
-- (public.clients.id, see agentbase-crm migration 001).

alter table public.capture_sessions
  add column if not exists agentbase_client_id bigint;

create index if not exists capture_sessions_agentbase_client_id_idx
  on public.capture_sessions (agentbase_client_id)
  where agentbase_client_id is not null;

-- Every capture session must be attributable to either an agent-v3 quoting
-- session or an AgentBase client. Legacy widget/wizard rows predate both
-- columns, so guard the constraint with NOT VALID + skip when already
-- present. Fresh writes get the check; historical rows are grandfathered.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'capture_sessions_origin_present'
      and conrelid = 'public.capture_sessions'::regclass
  ) then
    alter table public.capture_sessions
      add constraint capture_sessions_origin_present
      check (agent_session_id is not null or agentbase_client_id is not null)
      not valid;
  end if;
end$$;
