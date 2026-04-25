-- 003_manufacturer_assistance.sql
--
-- pm_manufacturer_assistance — manufacturer-run patient assistance
-- programs (PAPs), copay cards, and disease-specific foundations
-- that help Medicare beneficiaries afford brand-name drugs.
--
-- Why this matters: Medicare Part D excludes most copay cards under
-- the federal anti-kickback statute, so a 65-year-old hitting a
-- $300/mo Eliquis copay can't use the BMS savings card the way a
-- commercially-insured patient could. PAPs (free drug from the
-- manufacturer, income-tested) and foundation grants (PAN, HealthWell,
-- Good Days) are the realistic options. The agent quote screen
-- surfaces this layer alongside the formulary tier so Rob sees
-- "Not covered · assistance available" instead of just dead-ending
-- on a tier-5 row.
--
-- Seed source-of-truth caveat: the rows below are sourced from
-- manufacturer landing pages and FPL multiples Rob is most likely to
-- recommend. Income limits derived from 2025 federal poverty
-- guidelines (HHS) — 400% FPL ≈ $60,240 individual / $81,760
-- couple, 500% FPL ≈ $75,300 / $102,200, 250% FPL ≈ $37,650 /
-- $51,100. Programs flagged covers_medicare=true accept Medicare
-- Part D enrollees (most PAPs do once Extra Help is exhausted);
-- copay cards almost always exclude Medicare.
--
-- Verify URLs and phone numbers periodically — these were correct
-- at seed time but manufacturers reorganize PAPs regularly. The
-- updated_at column would normally track that; for now re-run the
-- migration to refresh the seed when needed (UPSERT semantics
-- below — re-running will not duplicate rows).
--
-- Run in the Supabase SQL Editor against plan-match-prod.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pm_manufacturer_assistance (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  drug_name                   text NOT NULL,
  brand_name                  text NOT NULL,
  manufacturer                text NOT NULL,
  program_name                text NOT NULL,
  program_type                text NOT NULL CHECK (program_type IN ('PAP','copay_card','foundation')),
  eligibility_summary         text,
  income_limit_individual     numeric,
  income_limit_couple         numeric,
  requires_m3p_enrollment     boolean DEFAULT false,
  application_url             text,
  phone_number                text,
  covers_medicare             boolean DEFAULT true,
  created_at                  timestamptz DEFAULT now()
);

-- Lookups by drug name when an agent expands the assistance card
-- on the quote screen. Lower-case the index target so case-mismatch
-- (Mounjaro vs MOUNJARO vs mounjaro) still hits.
CREATE INDEX IF NOT EXISTS idx_pm_mfr_assist_brand
  ON pm_manufacturer_assistance (lower(brand_name));

CREATE INDEX IF NOT EXISTS idx_pm_mfr_assist_drug
  ON pm_manufacturer_assistance (lower(drug_name));

-- A drug+program pair is the natural key — multiple programs can
-- reference the same drug (Lilly Cares PAP + Lilly Insulin Value Program
-- copay both touch Humalog). Use a partial unique to enable
-- ON CONFLICT upsert without forcing the synthetic id into clients.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_mfr_assist_brand_program
  ON pm_manufacturer_assistance (lower(brand_name), program_name);

-- ═══ SEED ═══════════════════════════════════════════════════════════
-- Top 20 brand drugs Rob's senior clients commonly see at retail. One
-- canonical PAP per drug — for drugs with both a PAP and a copay
-- card the PAP is the Medicare-relevant one.

INSERT INTO pm_manufacturer_assistance
  (drug_name, brand_name, manufacturer, program_name, program_type,
   eligibility_summary, income_limit_individual, income_limit_couple,
   requires_m3p_enrollment, application_url, phone_number, covers_medicare)
VALUES
  ('semaglutide injection', 'Ozempic', 'Novo Nordisk',
   'Novo Nordisk Patient Assistance Program', 'PAP',
   'Free drug for Medicare Part D enrollees who have exhausted Extra Help and meet income limits. 12-month enrollment, renewable.',
   60240, 81760, false,
   'https://www.novocare.com/diabetes/help-with-costs/PAP.html',
   '1-866-310-7549', true),

  ('tirzepatide for diabetes', 'Mounjaro', 'Eli Lilly',
   'Lilly Cares Foundation Patient Assistance Program', 'PAP',
   'Free drug for Medicare beneficiaries with hardship who do not qualify for Extra Help OR earn ≤400% FPL with significant Rx burden. Application + income documentation.',
   60240, 81760, false,
   'https://www.lillycares.com',
   '1-800-545-6962', true),

  ('empagliflozin', 'Jardiance', 'Boehringer Ingelheim',
   'BI Cares Foundation', 'PAP',
   'Free drug for Medicare Part D enrollees, income ≤500% FPL. Co-marketed with Lilly but PAP runs through BI.',
   75300, 102200, false,
   'https://www.bicaresfoundation.com',
   '1-800-556-8317', true),

  ('dulaglutide', 'Trulicity', 'Eli Lilly',
   'Lilly Cares Foundation Patient Assistance Program', 'PAP',
   'Free drug for low-income Medicare Part D enrollees. Same eligibility as Mounjaro / Humalog — Lilly Cares covers all Lilly brands.',
   60240, 81760, false,
   'https://www.lillycares.com',
   '1-800-545-6962', true),

  ('insulin glargine', 'Lantus', 'Sanofi',
   'Sanofi Patient Connection', 'PAP',
   'Free Sanofi drugs (Lantus, Toujeo, Admelog) for uninsured or Medicare with documented inability to afford. ≤400% FPL typical.',
   60240, 81760, false,
   'https://www.sanofipatientconnection.com',
   '1-888-847-4877', true),

  ('insulin lispro', 'Humalog', 'Eli Lilly',
   'Lilly Insulin Value Program', 'copay_card',
   '$35/month cap on any Lilly insulin (Humalog, Humulin, Basaglar). NOT valid with Medicare under federal anti-kickback statute — Medicare beneficiaries should use Lilly Cares PAP instead.',
   NULL, NULL, false,
   'https://www.insulinaffordability.com',
   '1-833-808-1234', false),

  ('insulin lispro', 'Humalog', 'Eli Lilly',
   'Lilly Cares Foundation Patient Assistance Program', 'PAP',
   'Medicare-eligible PAP path for Humalog. Free drug for income ≤400% FPL after Extra Help denial.',
   60240, 81760, false,
   'https://www.lillycares.com',
   '1-800-545-6962', true),

  ('insulin aspart', 'Novolog', 'Novo Nordisk',
   'Novo Nordisk Patient Assistance Program', 'PAP',
   'Free Novo Nordisk insulins (Novolog, Levemir, Tresiba) for Medicare beneficiaries earning ≤400% FPL with no Extra Help.',
   60240, 81760, false,
   'https://www.novocare.com/diabetes/help-with-costs/PAP.html',
   '1-866-310-7549', true),

  ('apixaban', 'Eliquis', 'Bristol-Myers Squibb',
   'BMS Patient Assistance Foundation', 'PAP',
   'Free Eliquis for Medicare Part D enrollees with annual household income ≤500% FPL and no other Rx coverage.',
   75300, 102200, false,
   'https://www.bmspaf.org',
   '1-800-736-0003', true),

  ('rivaroxaban', 'Xarelto', 'Janssen',
   'Johnson & Johnson Patient Assistance Foundation', 'PAP',
   'Free J&J drugs (Xarelto, Invokana, others) for Medicare beneficiaries ≤400% FPL who cannot afford their Part D copay. Janssen CarePath copay card excludes Medicare.',
   60240, 81760, false,
   'https://www.jjpaf.org',
   '1-800-652-6227', true),

  ('sacubitril-valsartan', 'Entresto', 'Novartis',
   'Novartis Patient Assistance Foundation', 'PAP',
   'Free Entresto for income ≤500% FPL. Apply via patient.novartis.com. Renewable annually.',
   75300, 102200, false,
   'https://www.patient.novartis.com',
   '1-800-277-2254', true),

  ('dapagliflozin', 'Farxiga', 'AstraZeneca',
   'AZ&Me Prescription Savings Program', 'PAP',
   'Free AstraZeneca drugs (Farxiga, Symbicort, Brilinta) for Medicare beneficiaries earning ≤300% FPL who have spent ≥3% of household income on Rx in current calendar year.',
   45180, 61320, false,
   'https://www.azandmeapp.com',
   '1-800-292-6363', true),

  ('semaglutide oral', 'Rybelsus', 'Novo Nordisk',
   'Novo Nordisk Patient Assistance Program', 'PAP',
   'Free oral semaglutide for Medicare Part D members ≤400% FPL.',
   60240, 81760, false,
   'https://www.novocare.com/diabetes/help-with-costs/PAP.html',
   '1-866-310-7549', true),

  ('liraglutide', 'Victoza', 'Novo Nordisk',
   'Novo Nordisk Patient Assistance Program', 'PAP',
   'Free Victoza for Medicare beneficiaries ≤400% FPL.',
   60240, 81760, false,
   'https://www.novocare.com/diabetes/help-with-costs/PAP.html',
   '1-866-310-7549', true),

  ('tirzepatide for weight', 'Zepbound', 'Eli Lilly',
   'Lilly Cares Foundation Patient Assistance Program', 'PAP',
   'Anti-obesity indication — Medicare Part D excludes weight-loss drugs (Section 1860D-2(e)(2)). Lilly Cares may still provide free Zepbound for income ≤400% FPL when prescribed off-label for OSA / cardiovascular risk reduction; otherwise patient pays cash. Review with prescriber.',
   60240, 81760, false,
   'https://www.lillycares.com',
   '1-800-545-6962', true),

  ('semaglutide for weight', 'Wegovy', 'Novo Nordisk',
   'Novo Nordisk Patient Assistance Program', 'PAP',
   'Anti-obesity — same Medicare Part D exclusion as Zepbound. PAP available for ≤400% FPL when off-label cardiovascular indication is documented (post-MACE, established CVD).',
   60240, 81760, false,
   'https://www.novocare.com/obesity/wegovy/savings.html',
   '1-833-454-0149', true),

  ('budesonide-formoterol', 'Symbicort', 'AstraZeneca',
   'AZ&Me Prescription Savings Program', 'PAP',
   'Free Symbicort for Medicare beneficiaries ≤300% FPL with significant Rx spend.',
   45180, 61320, false,
   'https://www.azandmeapp.com',
   '1-800-292-6363', true),

  ('tiotropium', 'Spiriva', 'Boehringer Ingelheim',
   'BI Cares Foundation', 'PAP',
   'Free Spiriva HandiHaler / Respimat for income ≤500% FPL.',
   75300, 102200, false,
   'https://www.bicaresfoundation.com',
   '1-800-556-8317', true),

  ('fluticasone-vilanterol', 'Breo Ellipta', 'GSK',
   'GSK Patient Assistance Program (Bridges to Access)', 'PAP',
   'Free GSK respiratory drugs (Breo, Anoro, Trelegy) for Medicare Part D ≤400% FPL after Extra Help denial.',
   60240, 81760, false,
   'https://www.gskforyou.com',
   '1-866-728-4368', true),

  ('nirmatrelvir-ritonavir', 'Paxlovid', 'Pfizer',
   'PAXCESS Patient Assistance Program', 'PAP',
   'Free Paxlovid for Medicare beneficiaries with no charge through 2024 USG distribution; 2025-onward via PAXCESS for ≤400% FPL or no insurance. Single-course 5-day pack.',
   60240, 81760, false,
   'https://www.paxlovid.com/paxcess',
   '1-877-219-7225', true),

  ('evolocumab', 'Repatha', 'Amgen',
   'Amgen Safety Net Foundation', 'PAP',
   'Free Repatha for Medicare beneficiaries ≤500% FPL with documented inability to afford Part D copay (typically >$300/mo on tier 5).',
   75300, 102200, false,
   'https://www.amgensafetynetfoundation.com',
   '1-888-762-6436', true)

ON CONFLICT (lower(brand_name), program_name) DO UPDATE SET
  manufacturer            = EXCLUDED.manufacturer,
  program_type            = EXCLUDED.program_type,
  eligibility_summary     = EXCLUDED.eligibility_summary,
  income_limit_individual = EXCLUDED.income_limit_individual,
  income_limit_couple     = EXCLUDED.income_limit_couple,
  requires_m3p_enrollment = EXCLUDED.requires_m3p_enrollment,
  application_url         = EXCLUDED.application_url,
  phone_number            = EXCLUDED.phone_number,
  covers_medicare         = EXCLUDED.covers_medicare;

-- ═══ VERIFICATION ═══════════════════════════════════════════════════
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'pm_manufacturer_assistance'
  ORDER BY ordinal_position;

SELECT program_type, COUNT(*) AS programs
  FROM pm_manufacturer_assistance
  GROUP BY program_type
  ORDER BY program_type;

SELECT brand_name, manufacturer, program_name, covers_medicare
  FROM pm_manufacturer_assistance
  ORDER BY brand_name;
