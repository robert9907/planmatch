-- 017_dsnp_populations_canonical.sql
--
-- Canonicalize dsnp_accepted_populations as the single source of truth
-- for D-SNP dual-population membership. Prior state (added Jul 8-9 in
-- migration 015 and the consumer's dsnp_eligible_tiers) had two
-- independently-written columns that disagreed in production for 7,832
-- NC/TX/GA rows — the agent side inverted the CMS "Partial Dual" flag
-- and mapped 7,092 rows to a restrictive 3-population set that should
-- have been the permissive 7-population set. See Phase 1/2 diagnosis
-- 2026-08-12.
--
-- After this migration:
--   • dsnp_accepted_populations is CANONICAL. Ingest writes here.
--     Uses the seven CMS-defined D-SNP dual populations, in uppercase:
--     FBDE, QMB+, QMB, SLMB+, SLMB, QI, QDWI.
--   • dsnp_eligible_tiers is DERIVED. A BEFORE INSERT/UPDATE trigger
--     rewrites the lowercase-underscore form the consumer's
--     filterPlanPool() expects (fbde, qmb_plus, qmb, slmb_plus, slmb,
--     qi, qdwi). Never write directly — writes get overwritten by the
--     trigger on the next row touch.
--
-- Idempotent — safe to re-run.

create or replace function derive_dsnp_eligible_tiers(pops text[])
  returns text[]
  language plpgsql
  immutable
as $$
declare
  result text[] := '{}';
  pop text;
begin
  if pops is null then
    return null;
  end if;
  foreach pop in array pops loop
    result := array_append(result, case lower(pop)
      when 'fbde'  then 'fbde'
      when 'qmb+'  then 'qmb_plus'
      when 'qmb'   then 'qmb'
      when 'slmb+' then 'slmb_plus'
      when 'slmb'  then 'slmb'
      when 'qi'    then 'qi'
      when 'qdwi'  then 'qdwi'
      -- Fallback: lowercase whatever came in. If a new CMS-defined
      -- population lands, it'll surface here instead of getting
      -- silently dropped — the consumer's MedicaidLevel enum will
      -- need widening to match.
      else lower(pop)
    end);
  end loop;
  return result;
end;
$$;

create or replace function pm_plans_sync_dsnp_tiers()
  returns trigger
  language plpgsql
as $$
begin
  new.dsnp_eligible_tiers := derive_dsnp_eligible_tiers(new.dsnp_accepted_populations);
  return new;
end;
$$;

drop trigger if exists pm_plans_sync_dsnp_tiers_trg on pm_plans;
create trigger pm_plans_sync_dsnp_tiers_trg
  before insert or update of dsnp_accepted_populations on pm_plans
  for each row execute function pm_plans_sync_dsnp_tiers();

-- Backfill existing rows so the trigger's semantic applies retroactively.
-- Rows where dsnp_accepted_populations is null keep dsnp_eligible_tiers
-- unchanged (which is null anyway for those rows).
update pm_plans
   set dsnp_eligible_tiers = derive_dsnp_eligible_tiers(dsnp_accepted_populations)
 where dsnp_accepted_populations is not null;
