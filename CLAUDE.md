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

---

## Surfaces

- Consumer: planmatch.generationhealth.me
- Agent (agent-v3): agent.generationhealth.me
- Supabase: plan-match-prod (`rpcbrkmvalvdmroqzpaq`)

## This repo

- Surface served: **agent-v3** (Rob's broker tool). Hosted at Vercel; validator hits `https://planmatch.vercel.app` by default.
- Package manager: **npm** (`package-lock.json`), Node ESM (`"type": "module"`).
- Typecheck: `npm run typecheck` → `tsc -b --noEmit`.
- Brain library lives in `src/lib/` (see `brainPaths` in `scripts/gate/gate.config.json` for the exact list — Gate 1–4 in `plan-brain.ts`/`plan-brain-weights.ts`/`plan-brain-utils.ts`/`plan-brain-ribbons.ts`/`plan-brain-explanations.ts`, ranker/filter in `planFilter.ts`+`planCatalog.ts`+`planMatchWizard.ts`, cost math in `drugCosts.ts`+`utilization-model.ts`, SNP/eligibility in `dual-eligible.ts`+`lis-cap-agent-v3.ts`+`condition-detector.ts`+`condition-profiles.ts`, formulary in `formularyLookup.ts`+`rxnorm.ts`+`parseDrugName.ts`+`resolveAgentBaseDrugs.ts`, provider matching in `networkCheck.ts`+`fhir.ts`+`npi.ts`, broker rules in `broker-rules.ts`+`broker-playbook.ts`+`compliance.ts`). Brain-adjacent server surface: `api/plans.ts`, `api/plans-with-extras.ts`, `api/plan-brain-data.ts`, `api/formulary.ts`, `api/network-check.ts`, `api/provider-network-status.ts`.
- Ground-truth validator: `scripts/cms-ground-truth-validate.ts` (default base is production `https://planmatch.vercel.app`; hits deployed `/api/plans` for every fixture in `scripts/cms-ground-truth-fixtures.json`). Exits `1` on any failure.
- Secret-shopper full audit: `scripts/cms-secret-shopper.ts` (also `npm run test:persona-audit`). Queries `pm_plans`/`pm_plan_benefits`/`pm_formulary` in plan-match-prod directly and drives Playwright/Chromium against medicare.gov — does not require a local Plan Match server.

## How work is done here

- One agreed task per session. Don't drift into adjacent fixes; list anything you noticed at the end instead.
- Rob runs parallel Claude Code sessions. Before committing, check `git status` and `git log -5`. Never commit, revert, or "clean up" changes you didn't make. If work is flagged as belonging to another session, don't touch it.
- Read a file before editing it. Search for an existing implementation before writing a new one; extend it instead of duplicating it.
- Run commands yourself. Never hand Rob terminal commands to paste.

## The brain — don't change semantics without Rob's explicit approval

- Gate 1: unknown = ELIMINATED in STRICT mode.
- Gate 3: hard elimination, 3-pick maximum.
- Gate 4: pure cost = premium × 12 + drug costs − giveback.
- The ref-latch (commit 2039a9e) stops brain re-runs from wiping the Compare workspace. Don't remove or route around it.
- To change brain logic: write or extend the test first, then change the code, then run the full audit (see Gates).

## Data rules

- CMS data is ground truth. Medicare Plan Finder is the benchmark.
- Only backfill a value from a CMS source. Never default, guess, or borrow a value from another plan to make a check pass. Missing stays missing and displays as unknown.
- Accepted deviations in the ground-truth validator are limited to the documented B8b class (carriers inverting the X-ray and advanced-imaging columns). Never add a new acceptance class or loosen a validator or harness to turn a failure green. Fix the data or the loader. If you think a new class is warranted, stop and ask Rob.
- D-SNP population data (128 plans, NC/TX/GA) was seeded manually from HealthSherpa. Don't let an importer overwrite it without Rob's approval.
- Prominence Health Plan (H7680, TX) and Kaiser Georgia (H1170) have no provider directory data. The only path is the carrier FHIR feed. Don't scrape, and don't present network status for those plans as known.
- County "average premium" = the mean consolidated Part C + Part D premium across every MA plan in the county, including $0-premium plans. Not a paid-plans-only average, not a median.

## Compliance text — exact, never paraphrased

- TPMO disclaimer, CMS simplified form only:
  > We do not offer every plan available in your area. Any information we provide is limited to those plans we do offer in your area. Please contact Medicare.gov or 1-800-MEDICARE (TTY 1-877-486-2048), 24 hours a day/7 days a week to get information on all of your options.

  Never use the variant that states a count of organizations or products.
- Phone number: (828) 761-3326. Never 3324. Fix any instance you see and mention it.
- 2026 Medicare figures must be CMS-confirmed. A $257 Part B deductible or $1,676 Part A deductible is stale and counts as a failure.

## Enrollment routing

- HealthSherpa is used only for ACA in North Carolina and Texas (federal marketplace), via deep link. Everything else routes through Plan Match.

## Gates — enforced by hooks, not by memory

- Every `git commit`: the typecheck must pass.
- Every `git push`: typecheck must pass, on a clean tree, with the pushed branch checked out.
- CMS ground truth runs against the branch's Vercel preview URL before any merge to main (PLAN_MATCH_BASE_URL=<preview>). A merge requires 228/228, with B8b-accepted pairs counted.
- A push that changes brain paths also needs a passing full audit (secret-shopper suite) on that exact commit: `node scripts/gate/full-audit.mjs`.
- Dry run anytime: `node scripts/gate/ship-gate.mjs manual`.
- If a gate blocks you, fix the cause. Never use `--no-verify`, change `core.hooksPath`, deploy with the Vercel CLI, or edit gate files or validators to get past a failure. Those trigger an approval prompt for Rob.
- Report results with the real numbers from the output, including failures. Never summarize a failing run as passing.
