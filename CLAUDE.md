# planmatch (agent-facing) — Repo Rules

## Identity

This is the **AGENT-FACING** Plan Match app — Rob's broker tool. The
consumer-facing widget lives at `~/Code/plan-match` (robert9907/plan-match).
Never edit that folder from this session — see
`[[project_planmatch_agent_repo_location]]` in `~/.claude/`.

- Repo: `robert9907/planmatch`
- Owner: Rob Simm — solo NC Medicare broker, NPN #10447418
- Hosting: Vercel

## Databases

- **plan-match-prod** (`rpcbrkmvalvdmroqzpaq`) — shared with consumer app.
  Server endpoints use `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  (service role bypasses RLS).
- **AgentBase** (`wyyasqvouvdcovttzfnv`) — CRM. Use
  `AGENTBASE_SUPABASE_URL` + `AGENTBASE_SUPABASE_SERVICE_ROLE_KEY`.

Never ship any service-role key to the browser.

## Standing rule — Supabase table creation (2026-08-03)

No table is ever created through the Supabase dashboard. Migrations only.
Every new table in `public` MUST ship with, in the same migration:

```sql
create table if not exists public.<name> (...);
alter table public.<name> enable row level security;
-- Then either an explicit `grant select on <name> to anon` + policy,
-- or nothing (service-role only).
```

Reason: four permission incidents in ten days — every one a table that
landed open because Supabase's schema-level default ACL grants CRUD to
anon+authenticated by default. RLS is the only gate. See
`~/Code/plan-match/supabase/migrations/202608031830_public_reads_lockdown.sql`.
