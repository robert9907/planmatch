-- drug_match_candidates: compare strengths as numbers, and honor a label form.
--
-- Maria Guimaraes, 2026-11-05 (AgentBase client 507):
--   • "Levothyroxin 25mcg" never matched — strength was compared as text, so
--     the label's "25 MCG" never equalled RxNorm's "0.025 MG". Every mcg drug
--     (levothyroxine, B12, …) missed rank 1.
--   • "ROSUVASTATIN 20mg" (tablet bottle) ranked the 20 MG CAPSULE first —
--     form was only read from the name, never from the label's form field.
--
-- Changes (everything else is unchanged):
--   • MG / MCG / G strengths are compared numerically in mg (5% tolerance for
--     RxNorm's rounding: 12.5 mcg is filed as 0.013 MG). Other units keep the
--     exact text compare.
--   • New optional p_form ('tablet' / 'capsule' / free text). Used only when
--     the name itself doesn't state a form. Existing named calls
--     (p_name, p_dose, p_limit) keep working.

begin;

drop function if exists public.drug_match_candidates(text, text, integer);

create function public.drug_match_candidates(
  p_name  text,
  p_dose  text    default null,
  p_limit integer default 12,
  p_form  text    default null
)
returns table(rxcui text, drug_name text, generic_name text, strength text, dose_form text,
              is_brand boolean, part_b boolean, match_rank integer, match_note text, similarity real)
language sql
stable parallel safe
set search_path to 'public', 'pg_temp'
set statement_timeout to '10s'
as $function$
with base as (
  select
    -- ingredient with any parenthetical dropped
    regexp_replace(regexp_replace(
      lower(trim(regexp_replace(regexp_replace(regexp_replace(coalesce(p_name,''), '\s*\(.*$', ''),
        '\y(TABS?|CAPS?|TABLETS?|CAPSULES?|ER|XR|SR|DR|CR|XL|LA|ODT|EC|HFA|AERO|SOLN|AUTO-INJ|INJ)\y', '', 'gi'),
        '\s+[0-9.]+\s*(MG|MCG|ML|G|UNIT)\y.*$', '', 'i'))),
      '\yhcl\y','hydrochloride','g'), '\s+',' ','g') as ing,
    -- whatever was inside the parenthetical, as a second candidate term
    lower(trim(coalesce(substring(p_name from '\(([^)]*)\)'), ''))) as paren,
    case when p_name ~* '\y(ER|XR|SR|XL|LA)\y' then 'extended'
         when p_name ~* '\y(DR|EC)\y'          then 'delayed'
         else 'immediate' end as rel,
    case when p_name ~* '\y(CAPS?|CAPSULES?)\y' then 'capsule'
         when p_name ~* '\y(TABS?|TABLETS?)\y'  then 'tablet'
         when p_form ~* '\y(CAPS?|CAPSULES?)\y' then 'capsule'
         when p_form ~* '\y(TABS?|TABLETS?)\y'  then 'tablet' end as form,
    upper(regexp_replace(regexp_replace(coalesce(p_dose,''), '\s+', '', 'g'),
      '(?i)(MG|MCG|ML|G|UNIT)$', ' \1')) as strength
),
qq as (
  select *,
         nullif(trim(regexp_replace(ing, '\s*\(.*$','')), '') as ing_c,
         -- label strength in mg when it is a plain MG / MCG / G amount
         case
           when strength ~ '^[0-9]*\.?[0-9]+ MCG$' then substring(strength from '^([0-9]*\.?[0-9]+)')::numeric / 1000
           when strength ~ '^[0-9]*\.?[0-9]+ MG$'  then substring(strength from '^([0-9]*\.?[0-9]+)')::numeric
           when strength ~ '^[0-9]*\.?[0-9]+ G$'   then substring(strength from '^([0-9]*\.?[0-9]+)')::numeric * 1000
         end as q_mg
  from base
),
d as (
  select x.rxcui, x.name, x.generic_name, x.strength, x.dose_form, x.is_brand,
         coalesce(x.part_b,false) as part_b,
         lower(x.generic_name) as gname_l,
         lower(coalesce(x.brand_name,'')) as bname_l,
         regexp_replace(
           lower(trim(regexp_replace(x.generic_name,'\s+[0-9.]+\s*(MG|MCG|ML|G|UNIT)\y.*$','','i'))),
           '^[0-9]+\s*hr\s+', '') as drug_ing,
         case when x.name ~* 'Extended Release' then 'extended'
              when x.name ~* 'Delayed Release'  then 'delayed'
              else 'immediate' end as drug_rel,
         case when x.name ~* 'Capsule' then 'capsule' when x.name ~* 'Tablet' then 'tablet' end as drug_form,
         case
           when upper(trim(x.strength)) ~ '^[0-9]*\.?[0-9]+ ?MCG$' then substring(trim(x.strength) from '^([0-9]*\.?[0-9]+)')::numeric / 1000
           when upper(trim(x.strength)) ~ '^[0-9]*\.?[0-9]+ ?MG$'  then substring(trim(x.strength) from '^([0-9]*\.?[0-9]+)')::numeric
           when upper(trim(x.strength)) ~ '^[0-9]*\.?[0-9]+ ?G$'   then substring(trim(x.strength) from '^([0-9]*\.?[0-9]+)')::numeric * 1000
         end as drug_mg
  from public.pm_drugs x
),
matched as (
  select d.*, qq.strength as q_strength, qq.rel, qq.form,
         -- ingredient relation in EITHER direction, or a brand-name hit
         ( d.drug_ing like qq.ing_c || '%' or qq.ing_c like d.drug_ing || '%' ) as ing_hit,
         ( qq.ing_c <> '' and d.bname_l = qq.ing_c )
         or ( qq.paren <> '' and (d.drug_ing like qq.paren || '%' or d.bname_l = qq.paren) ) as brand_hit,
         ( upper(d.strength) = qq.strength
           or ( qq.q_mg is not null and d.drug_mg is not null and qq.q_mg > 0
                and abs(d.drug_mg - qq.q_mg) <= 0.05 * greatest(d.drug_mg, qq.q_mg) ) ) as strength_hit,
         greatest(similarity(d.gname_l, coalesce(qq.ing_c,'')),
                  similarity(d.bname_l, coalesce(qq.ing_c,''))) as sim
  from d cross join qq
  where qq.ing_c is not null
    and ( d.drug_ing like qq.ing_c || '%'
       or qq.ing_c like d.drug_ing || '%'
       or d.bname_l = qq.ing_c
       or (qq.paren <> '' and (d.drug_ing like qq.paren || '%' or d.bname_l = qq.paren))
       or similarity(d.gname_l, qq.ing_c) > 0.45 )
),
scored as (
  select m.*,
    case
      when (m.ing_hit or m.brand_hit) and m.strength_hit
           and m.drug_rel = m.rel
           and (m.form is null or m.drug_form is null or m.drug_form = m.form) then 1
      when (m.ing_hit or m.brand_hit) and m.strength_hit                        then 2
      when (m.ing_hit or m.brand_hit)                                           then 3
      else 4
    end as rank
  from matched m
)
select rxcui, name, generic_name, strength, dose_form, is_brand, part_b, rank,
  case rank
    when 1 then 'exact - strength, release and form all match'
    when 2 then 'strength matches; form or release not stated'
    when 3 then 'same drug, different strength'
    else        'similar name'
  end,
  sim
from scored
order by rank, (not is_brand) desc, sim desc nulls last, name
limit greatest(1, least(p_limit, 50));
$function$;

commit;
