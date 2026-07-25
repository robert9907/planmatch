// Beneficiary profile fixtures for the parity audit.
//
// 25 profiles spanning NC (1–9), TX (10–17), GA (18–25). Each profile
// is designed to stress-test high-cost, high-complexity scenarios where
// small parity errors have material impact on the beneficiary.
//
// Source: docs/parity-audit/SPEC.md §2 (see profile tables). Drug
// classification (part-b vs part-d vs part-b-or-d) follows §5.3 with
// nuance flagged in drug notes.
//
// Complexity scores match spec Appendix C table.

import type { BeneficiaryProfile, Drug, DrugPart, ExpectedTier } from '../types.js';

// Compact drug helper — makes profile bodies readable.
const d = (
  name: string,
  strength: string,
  qty: number,
  tier: ExpectedTier,
  part: DrugPart,
  notes?: string,
): Drug => ({ name, strength, quantityPerMonth: qty, expectedTier: tier, part, notes });

// ─── North Carolina (Profiles 1–9) ──────────────────────────────────

const p01: BeneficiaryProfile = {
  id: '01-margaret', name: 'Margaret', age: 78,
  state: 'NC', countyName: 'Durham', countyFips: '37063', zip: '27707',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['CHF Stage III', 'Type 2 Diabetes', 'Hypertension', 'Atrial Fibrillation', 'CKD Stage 3b'],
  specialists: ['Cardiology (monthly)', 'Endocrinology (quarterly)', 'Nephrology (quarterly)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 1, inpatientAvgDays: 4 },
  snf: { staysPerYear: 1, avgDaysPerStay: 20 },
  drugs: [
    d('Entresto', '49/51mg', 60, 3, 'part-d', 'CHF'),
    d('Eliquis', '5mg', 60, 3, 'part-d', 'AFib anticoagulation'),
    d('Jardiance', '25mg', 30, 3, 'part-d', 'Diabetes + CKD'),
    d('Metformin', '1000mg', 60, 1, 'part-d'),
    d('Lisinopril', '20mg', 30, 1, 'part-d'),
    d('Furosemide', '40mg', 60, 1, 'part-d', 'CHF diuresis'),
    d('Atorvastatin', '40mg', 30, 1, 'part-d'),
    d('Potassium Chloride', '20mEq', 60, 1, 'part-d'),
    d('Farxiga', '10mg', 30, 3, 'part-d', 'CKD progression'),
  ],
  auditFocus: '4 IRA MFP drugs (Entresto, Eliquis, Jardiance, Farxiga) — ultimate MFP pricing accuracy test; Plan Match must reflect Maximum Fair Prices, not pre-negotiation list prices. SNF days 1-20 boundary; cardiology specialist copay; inpatient per-day stacking.',
  complexityScore: 25,
};

const p02: BeneficiaryProfile = {
  id: '02-james', name: 'James', age: 72,
  state: 'NC', countyName: 'Wake', countyFips: '37183', zip: '27601',
  medicaid: 'full-dual', lis: 'full', esrd: false, disabilityBased: false,
  snpEligibility: ['d-snp'],
  conditions: ['Schizophrenia (stable)', 'Type 2 Diabetes', 'COPD', 'Obesity BMI 38', 'Peripheral Neuropathy'],
  specialists: ['Psychiatry (monthly)', 'Pulmonology (quarterly)', 'Podiatry (quarterly)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 0, inpatientAvgDays: 7 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  drugs: [
    d('Invega Sustenna', '234mg', 1, 'part-b', 'part-b', 'Provider-administered LAI antipsychotic'),
    d('Metformin', '500mg', 120, 1, 'part-d'),
    d('Spiriva Respimat', '', 1, 3, 'part-d', 'COPD maintenance'),
    d('Albuterol HFA', '', 2, 1, 'part-d', 'COPD rescue'),
    d('Gabapentin', '300mg', 90, 1, 'part-d'),
    d('Ozempic', '1mg', 4, 5, 'part-d', 'Diabetes GLP-1'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
    d('Duloxetine', '60mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'D-SNP eligibility filter; full LIS zeroes all drug copays; psych inpatient copay (often different from medical); Invega Sustenna Part B classification; Ozempic PA/QL flags; SBC Spanish availability if selected D-SNP.',
  complexityScore: 26,
};

const p03: BeneficiaryProfile = {
  id: '03-dorothy', name: 'Dorothy', age: 84,
  state: 'NC', countyName: 'Mecklenburg', countyFips: '37119', zip: '28202',
  // v2 correction: partial LIS eliminated by IRA §11404. Income exceeds 150% FPL
  // ($23,940 individual) and no Medicaid → no LIS. Was 'partial-3' pre-IRA.
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['Rheumatoid Arthritis', 'Osteoporosis (T -3.8)', 'Type 2 Diabetes', 'Wet AMD', 'Depression'],
  specialists: ['Rheumatology (monthly)', 'Ophthalmology/Retina (q6w)', 'Endocrinology (quarterly)', 'Psychiatry (quarterly)'],
  hospital: { admissionsPerYear: 1, erVisitsPerYear: 2 },
  snf: { staysPerYear: 1, avgDaysPerStay: 30 },
  drugs: [
    d('Humira', '40mg', 2, 5, 'part-d', 'Biosimilar substitution likely'),
    d('Prolia', '60mg', 0.17, 'part-b', 'part-b-or-d', 'Q6mo; Part B if office admin, D if self-inject'),
    d('Metformin', '1000mg', 60, 1, 'part-d'),
    d('Alendronate', '70mg', 4, 1, 'part-d'),
    d('Calcium + Vitamin D', '600/400', 60, 'otc', 'part-d', 'OTC allowance'),
    d('Eylea', '2mg', 1, 'part-b', 'part-b', 'Intravitreal q6w for AMD'),
    d('Sertraline', '100mg', 30, 1, 'part-d'),
    d('Acetaminophen', '500mg', 30, 'otc', 'part-d'),
    d('Insulin Glargine (Lantus)', '', 5, 3, 'part-d', 'Insulin $35 cap'),
    d('Lisinopril', '10mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Non-subsidized beneficiary with Humira specialty spend → will hit $2,100 TrOOP cap rapidly. Humira biosimilar substitution display; insulin $35 cap; Part B (Prolia, Eylea) vs Part D classification; SNF days 21-30; OTC allowance vs OOP; wet AMD vision benefit vs routine.',
  complexityScore: 26,
};

const p04: BeneficiaryProfile = {
  id: '04-william', name: 'William', age: 66,
  state: 'NC', countyName: 'Guilford', countyFips: '37081', zip: '27401',
  medicaid: 'none', lis: 'none', esrd: true, disabilityBased: true,
  snpEligibility: [],
  conditions: ['ESRD (hemodialysis 3x/wk)', 'Type 2 Diabetes', 'Hypertension', 'Peripheral Artery Disease', 'Anemia of CKD'],
  specialists: ['Nephrology (monthly)', 'Vascular surgery (quarterly)', 'Dialysis center (3x/wk)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 3 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  drugs: [
    d('Epoetin alfa (Procrit)', '', 12, 'part-b', 'part-b', 'At dialysis'),
    d('Sevelamer', '800mg', 270, 2, 'part-d', 'Phosphate binder'),
    d('Calcitriol', '0.25mcg', 30, 1, 'part-d'),
    d('Insulin Lispro (Humalog)', '', 5, 3, 'part-d', 'Insulin $35 cap'),
    d('Amlodipine', '10mg', 30, 1, 'part-d'),
    d('Carvedilol', '25mg', 60, 1, 'part-d'),
    d('Clopidogrel', '75mg', 30, 1, 'part-d'),
    d('Ferrous Sulfate', '325mg', 90, 1, 'part-d'),
  ],
  auditFocus: 'ESRD plan filter (must exclude non-ESRD-eligible MA); Part B epoetin at dialysis; dialysis benefit copay; transportation for 3x/wk trips; insulin $35 cap; disability-based (under 65) eligibility.',
  complexityScore: 25,
};

const p05: BeneficiaryProfile = {
  id: '05-linda', name: 'Linda', age: 69,
  state: 'NC', countyName: 'Buncombe', countyFips: '37021', zip: '28801',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['Metastatic Breast Cancer HER2+', 'Osteoarthritis (bilateral knees)', 'Hypertension', 'Anxiety', 'Chemo-induced nausea'],
  specialists: ['Oncology (q3w)', 'Orthopedics (quarterly)', 'PCP (monthly)'],
  hospital: { admissionsPerYear: 3, erVisitsPerYear: 4 },
  snf: { staysPerYear: 1, avgDaysPerStay: 15 },
  drugs: [
    d('Herceptin (trastuzumab)', '', 1, 'part-b', 'part-b', 'IV q3w'),
    d('Perjeta (pertuzumab)', '', 1, 'part-b', 'part-b', 'IV q3w'),
    d('Ibrance (palbociclib)', '125mg', 21, 5, 'part-d', 'Oral chemo ~$15k/mo'),
    d('Ondansetron', '8mg', 30, 1, 'part-d'),
    d('Dexamethasone', '4mg', 20, 1, 'part-d'),
    d('Lorazepam', '0.5mg', 30, 1, 'part-d'),
    d('Meloxicam', '15mg', 30, 1, 'part-d'),
    d('Losartan', '50mg', 30, 1, 'part-d'),
    d('Filgrastim (Neupogen)', '', 1, 'part-b', 'part-b-or-d', 'B if office, D if home'),
  ],
  auditFocus: 'Ibrance Tier 5 specialty ($15k/mo → immediate $2,100 TrOOP cap hit month 1); Herceptin+Perjeta Part B; Filgrastim setting-dependent classification; high inpatient utilization → MOOP hit; chemo infusion copay.',
  complexityScore: 30,
};

const p06: BeneficiaryProfile = {
  id: '06-rosa', name: 'Rosa', age: 74,
  state: 'NC', countyName: 'Durham', countyFips: '37063', zip: '27705',
  medicaid: 'qmb', lis: 'full', esrd: false, disabilityBased: false,
  snpEligibility: ['d-snp'],
  language: 'es',
  conditions: ['Type 2 Diabetes (insulin-dep)', 'CHF Stage II', 'COPD', 'Osteoarthritis', 'Chronic Pain'],
  specialists: ['Endocrinology (quarterly)', 'Cardiology (quarterly)', 'Pulmonology (biannual)', 'Pain (monthly)'],
  hospital: { admissionsPerYear: 1, erVisitsPerYear: 2 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  drugs: [
    d('Insulin Glargine (Basaglar)', '', 5, 2, 'part-d', 'Insulin $35 cap'),
    d('Insulin Aspart (NovoLog)', '', 5, 3, 'part-d', 'Insulin $35 cap'),
    d('Carvedilol', '12.5mg', 60, 1, 'part-d'),
    d('Lisinopril', '20mg', 30, 1, 'part-d'),
    d('Furosemide', '20mg', 30, 1, 'part-d'),
    d('Spiriva Respimat', '', 1, 3, 'part-d'),
    d('Albuterol HFA', '', 2, 1, 'part-d'),
    d('Tramadol', '50mg', 120, 1, 'part-d'),
    d('Meloxicam', '15mg', 30, 1, 'part-d'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'QMB D-SNP; full LIS zeroes drug copays; dual insulin $35 cap applied per-product; NovoLog is an IRA MFP drug — reflect negotiated price. QMB means $0 all Medicare cost-sharing; Spanish SBC availability; D-SNP food card + transportation + OTC + dental supplemental benefits.',
  complexityScore: 25,
};

const p07: BeneficiaryProfile = {
  id: '07-robert', name: 'Robert', age: 62,
  state: 'NC', countyName: 'Wake', countyFips: '37183', zip: '27606',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: true,
  snpEligibility: [],
  conditions: ['ALS', 'Dysphagia', 'Respiratory Insufficiency', 'Depression', 'Chronic Urinary Retention'],
  specialists: ['Neurology (monthly)', 'Pulmonology (monthly)', 'Speech Therapy (weekly)', 'Physical Therapy (weekly)', 'Urology (quarterly)'],
  hospital: { admissionsPerYear: 3, erVisitsPerYear: 4 },
  snf: { staysPerYear: 2, avgDaysPerStay: 30 },
  dme: ['BiPAP machine', 'Power wheelchair', 'Hospital bed', 'Suction machine', 'Feeding tube supplies'],
  drugs: [
    d('Riluzole', '50mg', 60, 3, 'part-d'),
    d('Radicava (edaravone)', '', 1, 'part-b', 'part-b-or-d', 'IV = Part B, oral = Part D'),
    d('Baclofen', '10mg', 90, 1, 'part-d', 'Spasticity'),
    d('Sertraline', '100mg', 30, 1, 'part-d'),
    d('Tamsulosin', '0.4mg', 30, 1, 'part-d'),
    d('Guaifenesin', '600mg', 60, 1, 'part-d'),
    d('Atropine drops', '1%', 30, 1, 'part-d', 'Sublingual for secretions'),
  ],
  auditFocus: 'Under-65 disability; extensive DME (BiPAP + power chair + bed); 60-day SNF/yr → days 21-100 copay stacking; PT/OT/ST rehab benefit limits; Radicava Part B vs D by route; MOOP will hit early.',
  complexityScore: 33,
};

const p08: BeneficiaryProfile = {
  id: '08-evelyn', name: 'Evelyn', age: 80,
  state: 'NC', countyName: 'Forsyth', countyFips: '37067', zip: '27101',
  // v2 correction: partial LIS eliminated by IRA §11404. SLMB auto-qualifies
  // for full LIS. Was 'partial-2' pre-IRA.
  medicaid: 'slmb', lis: 'full', esrd: false, disabilityBased: false,
  snpEligibility: ['d-snp'],
  conditions: ["Parkinson's (moderate)", 'Dementia (early)', 'Osteoporosis', 'Recurrent UTIs', 'Dysphagia'],
  specialists: ['Neurology (quarterly)', 'Geriatrics (quarterly)', 'Urology (biannual)', 'Speech Therapy (monthly)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 3 },
  snf: { staysPerYear: 1, avgDaysPerStay: 60 },
  drugs: [
    d('Carbidopa/Levodopa', '25/100mg', 180, 1, 'part-d', 'QL likely (5x/day)'),
    d('Pramipexole', '1mg', 90, 1, 'part-d'),
    d('Donepezil', '10mg', 30, 1, 'part-d'),
    d('Memantine', '10mg', 60, 1, 'part-d'),
    d('Alendronate', '70mg', 4, 1, 'part-d'),
    d('Nitrofurantoin', '100mg', 30, 1, 'part-d', 'UTI prophylaxis'),
    d('Mirtazapine', '15mg', 30, 1, 'part-d'),
    d('Senna', '8.6mg', 60, 'otc', 'part-d'),
    d('Polyethylene Glycol', '17g', 30, 'otc', 'part-d'),
  ],
  auditFocus: 'SLMB + Full LIS split: medical copays = standard plan amounts (SLMB covers Part B premium only); drug copays = full LIS schedule ($1.60/$4.90 or $5.10/$12.65 by income band). 60-day SNF → days 21-60 copay math; Carbidopa/Levodopa 180 tabs QL flag; dementia caregiver support supplemental; meal delivery post-discharge.',
  complexityScore: 25,
};

const p09: BeneficiaryProfile = {
  id: '09-thomas', name: 'Thomas', age: 70,
  state: 'NC', countyName: 'Cumberland', countyFips: '37051', zip: '28301',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['HIV (controlled CD4 > 500)', 'Hep C (cured, monitored)', 'Type 2 Diabetes', 'Hypertension', 'Hyperlipidemia', 'Chronic Pain (SC/VA eligible)'],
  specialists: ['Infectious Disease (quarterly)', 'Hepatology (biannual)', 'Endocrinology (quarterly)', 'Pain (monthly)'],
  hospital: { admissionsPerYear: 1, erVisitsPerYear: 1 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  drugs: [
    d('Biktarvy', '', 30, 5, 'part-d', 'HIV ART ~$3.5k/mo'),
    d('Metformin', '1000mg', 60, 1, 'part-d'),
    d('Jardiance', '25mg', 30, 3, 'part-d'),
    d('Lisinopril', '40mg', 30, 1, 'part-d'),
    d('Rosuvastatin', '20mg', 30, 1, 'part-d'),
    d('Gabapentin', '600mg', 90, 1, 'part-d'),
    d('Omeprazole', '40mg', 30, 1, 'part-d'),
    d('Vitamin D3', '2000 IU', 30, 'otc', 'part-d'),
  ],
  auditFocus: 'Biktarvy $3.5k/mo specialty + Jardiance IRA MFP drug — tests both MFP pricing and specialty tier simultaneously. Biktarvy pushes toward $2,100 TrOOP cap by month 1–2. Formulary PA/QL/ST flags; Fort Bragg VA coordination display; lab copay (quarterly VL, CD4, CMP).',
  complexityScore: 23,
};

// ─── Texas (Profiles 10–17) ─────────────────────────────────────────

const p10: BeneficiaryProfile = {
  id: '10-maria', name: 'Maria', age: 76,
  state: 'TX', countyName: 'Harris', countyFips: '48201', zip: '77002',
  medicaid: 'full-dual', lis: 'full', esrd: false, disabilityBased: false,
  snpEligibility: ['d-snp'],
  language: 'es',
  conditions: ['Type 2 Diabetes uncontrolled (A1C 9.8)', 'CHF Stage III', 'COPD', 'Diabetic Retinopathy', 'Diabetic Nephropathy CKD 4'],
  specialists: ['Endocrinology (monthly)', 'Cardiology (monthly)', 'Nephrology (quarterly)', 'Ophthalmology (quarterly)', 'Pulmonology (quarterly)'],
  hospital: { admissionsPerYear: 3, erVisitsPerYear: 5 },
  snf: { staysPerYear: 1, avgDaysPerStay: 20 },
  drugs: [
    d('Insulin Glargine (Lantus)', '', 10, 3, 'part-d', 'High-dose basal; $35 cap'),
    d('Insulin Lispro (Humalog)', '', 10, 3, 'part-d', 'High-dose mealtime; $35 cap'),
    d('Entresto', '49/51mg', 60, 3, 'part-d'),
    d('Empagliflozin (Jardiance)', '25mg', 30, 3, 'part-d'),
    d('Furosemide', '80mg', 60, 1, 'part-d'),
    d('Spironolactone', '25mg', 30, 1, 'part-d'),
    d('Spiriva Respimat', '', 1, 3, 'part-d'),
    d('Albuterol HFA', '', 3, 1, 'part-d'),
    d('Losartan', '100mg', 30, 1, 'part-d'),
    d('Atorvastatin', '80mg', 30, 1, 'part-d'),
    d('Ozempic', '1mg', 4, 5, 'part-d'),
    d('Amlodipine', '10mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Harris D-SNP (largest TX market); 12-drug regimen stresses formulary matching; full LIS on all drugs incl Ozempic; $35 insulin cap per-product not per-total; 2 IRA MFP drugs (Entresto, Jardiance/Empagliflozin) — pricing reflects negotiated rates even under LIS. D-SNP supplementals (food card, transport, OTC, dental, vision, hearing); 5 specialist copays should be $0 for dual.',
  complexityScore: 31,
};

const p11: BeneficiaryProfile = {
  id: '11-charles', name: 'Charles', age: 68,
  state: 'TX', countyName: 'Dallas', countyFips: '48113', zip: '75201',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['Lung Cancer Stage IIIA NSCLC (on immuno)', 'COPD', 'Type 2 Diabetes', 'DVT (on anticoag)', 'Depression'],
  specialists: ['Oncology (q3w)', 'Pulmonology (quarterly)', 'Endocrinology (quarterly)', 'Hematology (monthly)'],
  hospital: { admissionsPerYear: 4, erVisitsPerYear: 4 },
  snf: { staysPerYear: 1, avgDaysPerStay: 21 },
  drugs: [
    d('Keytruda (pembrolizumab)', '', 1, 'part-b', 'part-b', 'IV q3w immunotherapy'),
    d('Tagrisso (osimertinib)', '80mg', 30, 5, 'part-d', 'Oral targeted therapy ~$15k/mo'),
    d('Eliquis', '5mg', 60, 3, 'part-d'),
    d('Metformin', '1000mg', 60, 1, 'part-d'),
    d('Albuterol HFA', '', 2, 1, 'part-d'),
    d('Dexamethasone', '4mg', 30, 1, 'part-d'),
    d('Ondansetron', '8mg', 30, 1, 'part-d'),
    d('Sertraline', '100mg', 30, 1, 'part-d'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Tagrisso $15k/mo → hits $2,100 TrOOP cap in month 1, $0 drug for remaining 11 months. Keytruda Part B split; Eliquis IRA MFP drug — negotiated price. SNF at exactly 21 days (copay trigger); 4 admissions → MOOP hit; outpatient chemo infusion copay.',
  complexityScore: 29,
};

const p12: BeneficiaryProfile = {
  id: '12-patricia', name: 'Patricia', age: 73,
  state: 'TX', countyName: 'Bexar', countyFips: '48029', zip: '78201',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['Systemic Lupus (SLE)', 'Lupus Nephritis CKD 3', 'Osteoporosis', 'Anemia of Chronic Disease', "Raynaud's", 'Anxiety'],
  specialists: ['Rheumatology (monthly)', 'Nephrology (quarterly)', 'Hematology (quarterly)', 'Dermatology (quarterly)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 3 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  drugs: [
    d('Benlysta (belimumab)', '', 1, 'part-b', 'part-b-or-d', 'IV=Part B, SC=Part D'),
    d('Mycophenolate', '500mg', 120, 1, 'part-d'),
    d('Hydroxychloroquine', '200mg', 60, 1, 'part-d'),
    d('Prednisone', '5mg', 30, 1, 'part-d'),
    d('Alendronate', '70mg', 4, 1, 'part-d'),
    d('Calcium + Vitamin D', '', 60, 'otc', 'part-d'),
    d('Nifedipine ER', '30mg', 30, 1, 'part-d'),
    d('Ferrous Sulfate', '325mg', 90, 1, 'part-d'),
    d('Buspirone', '10mg', 60, 1, 'part-d'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Benlysta route-dependent classification (IV=B, SC=D); autoimmune specialty tier; frequent lab copays (CBC, CMP, UA, complement); San Antonio plan market.',
  complexityScore: 24,
};

const p13: BeneficiaryProfile = {
  id: '13-george', name: 'George', age: 71,
  state: 'TX', countyName: 'Travis', countyFips: '48453', zip: '78701',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ["Parkinson's advanced w/ motor fluctuations", 'REM Sleep Behavior Disorder', 'Orthostatic Hypotension', 'Depression', 'Neurogenic Constipation (severe)'],
  specialists: ['Movement Disorder Neurology (monthly)', 'Psychiatry (quarterly)', 'Cardiology (quarterly, orthostatic)', 'Gastroenterology (quarterly)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 3 },
  snf: { staysPerYear: 1, avgDaysPerStay: 30 },
  dme: ['Rollator walker', 'Raised toilet seat', 'Grab bars'],
  drugs: [
    d('Carbidopa/Levodopa', '25/250mg', 150, 1, 'part-d', 'QL likely (5x/day)'),
    d('Carbidopa/Levodopa CR', '50/200mg', 60, 1, 'part-d'),
    d('Entacapone', '200mg', 150, 1, 'part-d', 'COMT inhibitor; QL likely'),
    d('Pramipexole ER', '3mg', 30, 2, 'part-d'),
    d('Droxidopa', '300mg', 90, 3, 'part-d', 'No generic; brand'),
    d('Clonazepam', '0.5mg', 30, 1, 'part-d', 'REM sleep disorder'),
    d('Duloxetine', '60mg', 30, 1, 'part-d'),
    d('Polyethylene Glycol', '17g', 30, 'otc', 'part-d'),
    d('Senna', '8.6mg', 60, 'otc', 'part-d'),
    d('Midodrine', '5mg', 90, 1, 'part-d'),
  ],
  auditFocus: 'High-QTY Carbidopa/Levodopa (210 units/mo) → quantity limit; Entacapone 150 tabs QL; Droxidopa brand-only copay accuracy; DME mobility; Austin has limited MA plan options.',
  complexityScore: 22,
};

const p14: BeneficiaryProfile = {
  id: '14-helen', name: 'Helen', age: 81,
  state: 'TX', countyName: 'Tarrant', countyFips: '48439', zip: '76102',
  medicaid: 'none', lis: 'none', esrd: true, disabilityBased: false,
  snpEligibility: [],
  conditions: ['ESRD (peritoneal dialysis, home)', 'Type 1 Diabetes', 'Hypertension', 'Peripheral Neuropathy', 'Gastroparesis', 'Retinopathy'],
  specialists: ['Nephrology (monthly)', 'Endocrinology (quarterly)', 'Gastroenterology (quarterly)', 'Ophthalmology (quarterly)', 'Podiatry (quarterly)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 2 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  dme: ['Insulin pump', 'Dexcom G7 CGM'],
  drugs: [
    d('Insulin Pump Supplies', '', 30, 'part-b', 'part-b', 'DME for T1DM'),
    d('Dexcom G7 CGM', '', 1, 'part-b', 'part-b', 'DME'),
    d('Peritoneal Dialysis Solution', '', 30, 'part-b', 'part-b', 'Home dialysis supplies'),
    d('Sevelamer', '800mg', 270, 2, 'part-d'),
    d('Metoclopramide', '10mg', 90, 1, 'part-d'),
    d('Gabapentin', '300mg', 90, 1, 'part-d'),
    d('Lisinopril', '20mg', 30, 1, 'part-d'),
    d('Amlodipine', '5mg', 30, 1, 'part-d'),
    d('Ondansetron', '4mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Home PD (different benefit than in-center HD); ESRD plan filter; Part B DME (pump + CGM); T1DM (not T2) insulin management; Fort Worth ESRD-eligible plan availability.',
  complexityScore: 27,
};

const p15: BeneficiaryProfile = {
  id: '15-frank', name: 'Frank', age: 59,
  state: 'TX', countyName: 'Harris', countyFips: '48201', zip: '77030',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: true,
  snpEligibility: [],
  conditions: ['Post-Kidney Transplant (3 yr)', 'Immunosuppression', 'Type 2 Diabetes (transplant-induced)', 'Hypertension', 'CMV Monitoring', 'Gout'],
  specialists: ['Transplant Nephrology (monthly)', 'Endocrinology (quarterly)', 'Infectious Disease (quarterly)'],
  hospital: { admissionsPerYear: 1, erVisitsPerYear: 2 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  drugs: [
    d('Tacrolimus', '1mg', 60, 1, 'part-d', 'Narrow therapeutic index'),
    d('Mycophenolate', '500mg', 120, 1, 'part-d'),
    d('Prednisone', '5mg', 30, 1, 'part-d'),
    d('Valganciclovir', '450mg', 60, 2, 'part-d', 'CMV prophylaxis ~$800/mo'),
    d('Insulin Glargine (Lantus)', '', 5, 3, 'part-d', '$35 cap'),
    d('Metformin', '500mg', 60, 1, 'part-d'),
    d('Amlodipine', '10mg', 30, 1, 'part-d'),
    d('Allopurinol', '300mg', 30, 1, 'part-d'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
    d('Trimethoprim/Sulfa DS', '', 30, 1, 'part-d', 'PCP prophylaxis'),
    d('Calcium + Vitamin D', '', 60, 'otc', 'part-d'),
  ],
  auditFocus: 'Under-65 post-transplant Medicare; transplant immunosuppressants must be on formulary; Valganciclovir expensive generic (~$800/mo) tier 2; Part B 36-month post-transplant immunosuppressive drug benefit; TMC ZIP provider density.',
  complexityScore: 23,
};

const p16: BeneficiaryProfile = {
  id: '16-guadalupe', name: 'Guadalupe', age: 77,
  state: 'TX', countyName: 'El Paso', countyFips: '48141', zip: '79901',
  medicaid: 'full-dual', lis: 'full', esrd: false, disabilityBased: false,
  snpEligibility: ['d-snp'],
  language: 'es',
  conditions: ['Type 2 Diabetes w/ neuropathy', 'CHF Stage II', 'Chronic Venous Insufficiency', 'GERD', 'Obesity BMI 41', 'Bilateral Knee OA'],
  specialists: ['Endocrinology (quarterly)', 'Cardiology (quarterly)', 'Vascular surgery (biannual)', 'Orthopedics (biannual)'],
  hospital: { admissionsPerYear: 1, erVisitsPerYear: 2 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  drugs: [
    d('Insulin Glargine (Toujeo)', '', 5, 3, 'part-d', 'Concentrated; $35 cap applies'),
    d('Metformin ER', '1000mg', 60, 1, 'part-d'),
    d('Carvedilol', '25mg', 60, 1, 'part-d'),
    d('Furosemide', '40mg', 30, 1, 'part-d'),
    d('Pantoprazole', '40mg', 30, 1, 'part-d'),
    d('Diosmin', '500mg', 60, 'otc', 'part-d'),
    d('Acetaminophen', '500mg', 30, 'otc', 'part-d'),
    d('Compression stockings', '', 2, 'part-b', 'part-b', 'DME 2 pairs/yr'),
  ],
  auditFocus: 'El Paso border-county D-SNP (limited options); Toujeo $35 cap on concentrated insulin; compression stockings DME; Spanish SBC.',
  complexityScore: 21,
};

const p17: BeneficiaryProfile = {
  id: '17-betty', name: 'Betty', age: 67,
  state: 'TX', countyName: 'Hidalgo', countyFips: '48215', zip: '78501',
  medicaid: 'qmb', lis: 'full', esrd: false, disabilityBased: false,
  snpEligibility: ['d-snp', 'c-snp-diabetes'],
  conditions: ['Type 2 Diabetes poor A1C 10.2', 'Diabetic Kidney Disease CKD 3a', 'Diabetic Retinopathy (proliferative)', 'Hypertension', 'Hyperlipidemia', 'Depression'],
  specialists: ['Endocrinology (monthly)', 'Nephrology (quarterly)', 'Retinal Ophthalmology (monthly)', 'PCP (monthly)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 3 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  drugs: [
    d('Insulin Degludec (Tresiba)', '', 5, 3, 'part-d', '$35 cap'),
    d('Insulin Aspart (NovoLog)', '', 5, 3, 'part-d', '$35 cap'),
    d('Ozempic', '1mg', 4, 5, 'part-d'),
    d('Eylea', '2mg', 1, 'part-b', 'part-b', 'Intravitreal monthly for retinopathy'),
    d('Losartan', '100mg', 30, 1, 'part-d'),
    d('Atorvastatin', '80mg', 30, 1, 'part-d'),
    d('Sertraline', '100mg', 30, 1, 'part-d'),
    d('Empagliflozin', '25mg', 30, 3, 'part-d'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'C-SNP diabetes AND D-SNP eligibility (surface both); C-SNP supplementals (diabetes supplies, nutritional counseling); 2 IRA MFP drugs (NovoLog, Jardiance/Empagliflozin); Ozempic LIS copay override; Eylea Part B; Rio Grande Valley very limited plan market; triple insulin/GLP-1 regimen.',
  complexityScore: 27,
};

// ─── Georgia (Profiles 18–25) ───────────────────────────────────────

const p18: BeneficiaryProfile = {
  id: '18-annie', name: 'Annie', age: 75,
  state: 'GA', countyName: 'Fulton', countyFips: '13121', zip: '30303',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['HFrEF EF 25%', 'Atrial Fibrillation', 'Type 2 Diabetes', 'Stage 3 CKD', 'Sleep Apnea', 'Gout'],
  specialists: ['Heart Failure Cardiology (monthly)', 'Electrophysiology (quarterly)', 'Nephrology (quarterly)', 'Sleep Medicine (biannual)'],
  hospital: { admissionsPerYear: 3, erVisitsPerYear: 4 },
  snf: { staysPerYear: 1, avgDaysPerStay: 21 },
  dme: ['CPAP machine + supplies'],
  drugs: [
    d('Entresto', '49/51mg', 60, 3, 'part-d'),
    d('Eliquis', '5mg', 60, 3, 'part-d'),
    d('Dapagliflozin', '10mg', 30, 3, 'part-d'),
    d('Metoprolol Succinate ER', '100mg', 30, 1, 'part-d'),
    d('Spironolactone', '25mg', 30, 1, 'part-d'),
    d('Furosemide', '80mg', 60, 1, 'part-d'),
    d('Metformin', '1000mg', 60, 1, 'part-d'),
    d('Allopurinol', '300mg', 30, 1, 'part-d'),
    d('Colchicine', '0.6mg', 30, 2, 'part-d', 'Recently genericized; pricing varies'),
    d('Potassium Chloride', '20mEq', 60, 1, 'part-d'),
    d('Atorvastatin', '40mg', 30, 1, 'part-d'),
  ],
  auditFocus: '3 IRA MFP drugs (Entresto, Eliquis, Farxiga/Dapagliflozin) — maximum MFP pricing test for non-LIS beneficiary in Atlanta metro (largest GA market). SNF at exactly 21 days (trigger boundary); CPAP DME; colchicine generic pricing variance; MOOP likely hit.',
  complexityScore: 27,
};

const p19: BeneficiaryProfile = {
  id: '19-samuel', name: 'Samuel', age: 64,
  state: 'GA', countyName: 'DeKalb', countyFips: '13089', zip: '30030',
  medicaid: 'full-dual', lis: 'full', esrd: false, disabilityBased: true,
  snpEligibility: ['d-snp'],
  conditions: ['Bipolar Type I severe w/ psychotic features', 'PTSD', 'Type 2 Diabetes', 'Obesity BMI 42', 'OSA', 'Tardive Dyskinesia'],
  specialists: ['Psychiatry (biweekly)', 'Psychology (weekly)', 'Endocrinology (quarterly)', 'Sleep Medicine (biannual)'],
  hospital: { admissionsPerYear: 3, erVisitsPerYear: 3 },
  snf: { staysPerYear: 0, avgDaysPerStay: 0 },
  dme: ['CPAP'],
  drugs: [
    d('Lithium', '300mg', 90, 1, 'part-d'),
    d('Quetiapine', '400mg', 30, 1, 'part-d'),
    d('Ingrezza (valbenazine)', '80mg', 30, 5, 'part-d', 'TD ~$7k/mo'),
    d('Prazosin', '5mg', 30, 1, 'part-d', 'PTSD nightmares'),
    d('Metformin', '1000mg', 60, 1, 'part-d'),
    d('Wegovy (Semaglutide)', '2.4mg', 4, 5, 'part-d', 'Obesity — many plans exclude for weight indication'),
    d('Trazodone', '100mg', 30, 1, 'part-d'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Under-65 mental-health disability; D-SNP; Ingrezza $7k/mo specialty; Wegovy coverage for obesity (many plans exclude); psychiatric inpatient copay (often ≠ medical); MH outpatient (psychiatrist vs psychologist copay may differ); full LIS on all incl Ingrezza+Wegovy.',
  complexityScore: 28,
};

const p20: BeneficiaryProfile = {
  id: '20-catherine', name: 'Catherine', age: 79,
  state: 'GA', countyName: 'Gwinnett', countyFips: '13135', zip: '30043',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['Multiple Myeloma R/R 3rd-line', 'Bone Disease (lytic lesions, pathological fractures)', 'Anemia', 'CKD Stage 3 (myeloma kidney)', 'Herpes Zoster (recurrent)'],
  specialists: ['Hematology/Oncology (biweekly)', 'Nephrology (quarterly)', 'Pain (monthly)', 'Radiation Oncology (PRN)'],
  hospital: { admissionsPerYear: 4, erVisitsPerYear: 5 },
  snf: { staysPerYear: 2, avgDaysPerStay: 20 },
  drugs: [
    d('Revlimid (lenalidomide)', '25mg', 21, 5, 'part-d', '~$20k/mo → immediate catastrophic'),
    d('Dexamethasone', '40mg', 16, 1, 'part-d'),
    d('Darzalex (daratumumab)', '', 1, 'part-b', 'part-b', 'IV weekly then monthly'),
    d('Zoledronic Acid', '', 1, 'part-b', 'part-b', 'IV monthly for bone disease'),
    d('Acyclovir', '400mg', 60, 1, 'part-d'),
    d('Oxycodone', '10mg', 120, 1, 'part-d', 'QL likely'),
    d('Gabapentin', '600mg', 90, 1, 'part-d'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
    d('Sennosides', '8.6mg', 60, 'otc', 'part-d'),
    d('Filgrastim (Neupogen)', '', 1, 'part-b', 'part-b-or-d', 'B if office, D if home'),
  ],
  auditFocus: 'Ultimate Part D stress: Revlimid ~$20k/mo → catastrophic phase in first fill; Darzalex+Zoledronic Part B; 4 admissions + 5 ER + 2 SNF → maximum MOOP stress; opioid QL/PA; Gwinnett suburban ATL.',
  complexityScore: 34,
};

const p21: BeneficiaryProfile = {
  id: '21-harold', name: 'Harold', age: 73,
  state: 'GA', countyName: 'Cobb', countyFips: '13067', zip: '30060',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['Severe COPD GOLD IV (home O2)', 'Pulmonary Hypertension', 'Right Heart Failure (Cor Pulmonale)', 'Anxiety', 'Cachexia', 'Osteoporosis'],
  specialists: ['Pulmonology (monthly)', 'Cardiology (quarterly)', 'Palliative Care (monthly)', 'Nutrition (monthly)'],
  hospital: { admissionsPerYear: 4, erVisitsPerYear: 6 },
  snf: { staysPerYear: 2, avgDaysPerStay: 30 },
  dme: ['Home O2 concentrator', 'Portable O2 tanks', 'Nebulizer', 'Pulse oximeter'],
  drugs: [
    d('Trelegy Ellipta', '', 1, 3, 'part-d', 'Triple therapy COPD'),
    d('Albuterol nebulizer solution', '', 90, 1, 'part-d', 'High-QTY vials'),
    d('Ipratropium nebulizer', '', 90, 1, 'part-d', 'High-QTY vials'),
    d('Prednisone', '10mg', 30, 1, 'part-d', 'Burst packs'),
    d('Sildenafil', '20mg', 90, 1, 'part-d', 'Pulm HTN (not ED)'),
    d('Furosemide', '40mg', 30, 1, 'part-d'),
    d('Spironolactone', '25mg', 30, 1, 'part-d'),
    d('Megestrol', '400mg/10mL', 600, 1, 'part-d', 'Appetite (mL/mo)'),
    d('Alendronate', '70mg', 4, 1, 'part-d'),
    d('Lorazepam', '0.5mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Extensive DME — home O2 one of the most audited categories; 90-vial nebulizer QL; Sildenafil for pulm HTN (not ED) different coverage rule; 60-day SNF+4 admissions+6 ER → extreme MOOP hit; palliative care copay; pulmonary rehab.',
  complexityScore: 31,
};

const p22: BeneficiaryProfile = {
  id: '22-shirley', name: 'Shirley', age: 68,
  state: 'GA', countyName: 'Clayton', countyFips: '13063', zip: '30236',
  medicaid: 'full-dual', lis: 'full', esrd: false, disabilityBased: false,
  snpEligibility: ['d-snp'],
  conditions: ['Sickle Cell Disease (HbSS)', 'Chronic Pain (SCD)', 'Pulmonary Hypertension', 'Avascular Necrosis (bilateral hips, post-repl)', 'CKD Stage 3', 'Iron Overload (transfusions)'],
  specialists: ['Hematology (monthly)', 'Pulmonology (quarterly)', 'Orthopedics (quarterly)', 'Pain (monthly)', 'Nephrology (quarterly)'],
  hospital: { admissionsPerYear: 4, erVisitsPerYear: 6 },
  snf: { staysPerYear: 1, avgDaysPerStay: 14 },
  drugs: [
    d('Hydroxyurea', '500mg', 30, 1, 'part-d'),
    // v2 correction: Oxbryta withdrawn globally 2024-09-25 (Pfizer safety recall).
    // Replaced with Crizanlizumab (Adakveo) — IV infusion, Part B.
    d('Crizanlizumab (Adakveo)', '5mg/kg', 1, 'part-b', 'part-b', 'IV q4w for VOC prevention'),
    d('L-Glutamine (Endari)', '', 60, 5, 'part-d', 'SCD BID packets'),
    d('Oxycodone ER', '20mg', 60, 2, 'part-d'),
    d('Oxycodone IR', '5mg', 120, 1, 'part-d', 'QL + PA likely'),
    d('Deferasirox', '360mg', 30, 5, 'part-d', 'Iron chelation ~$5k/mo'),
    d('Sildenafil', '20mg', 90, 1, 'part-d', 'Pulm HTN'),
    d('Folic Acid', '1mg', 30, 1, 'part-d'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Adakveo Part B (replaces withdrawn Oxbryta) + two Part D specialty (Endari + Deferasirox) → rare-disease coverage; full LIS override on specialty; Part B vs D classification for Adakveo; dual opioid regimen 180 units/mo; SCD rare in Medicare (usually younger population); blood transfusion Part B; Clayton south-metro ATL.',
  complexityScore: 32,
};

const p23: BeneficiaryProfile = {
  id: '23-eugene', name: 'Eugene', age: 74,
  state: 'GA', countyName: 'Chatham', countyFips: '13051', zip: '31401',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['Liver Cirrhosis (NASH, compensated)', 'HCC (early stage, post-TACE)', 'Type 2 Diabetes', 'Portal Hypertension', 'Esophageal Varices', 'Hepatic Encephalopathy'],
  specialists: ['Hepatology (monthly)', 'Oncology (quarterly)', 'Gastroenterology (quarterly)', 'Endocrinology (quarterly)'],
  hospital: { admissionsPerYear: 3, erVisitsPerYear: 4 },
  snf: { staysPerYear: 1, avgDaysPerStay: 14 },
  drugs: [
    d('Lactulose', '10g/15mL', 1800, 1, 'part-d', 'HE — 1800mL/mo (~4 large bottles)'),
    d('Rifaximin', '550mg', 60, 3, 'part-d', 'HE ~$2k/mo brand'),
    d('Nadolol', '40mg', 30, 1, 'part-d', 'Variceal prophylaxis'),
    d('Spironolactone', '100mg', 30, 1, 'part-d', 'Ascites'),
    d('Furosemide', '40mg', 30, 1, 'part-d', 'Ascites'),
    d('Metformin', '500mg', 60, 1, 'part-d', 'Dose-limited by liver'),
    d('Insulin Glargine (Lantus)', '', 3, 3, 'part-d', '$35 cap'),
    d('Omeprazole', '20mg', 30, 1, 'part-d'),
    d('Ondansetron', '4mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Rifaximin brand-only $2k/mo; Lactulose high-volume packaging; hepatology specialist copay; TACE interventional radiology; endoscopy variceal surveillance; Savannah rural-adjacent market.',
  complexityScore: 24,
};

const p24: BeneficiaryProfile = {
  id: '24-martha', name: 'Martha', age: 82,
  state: 'GA', countyName: 'Richmond', countyFips: '13245', zip: '30901',
  // v2 correction: partial LIS eliminated by IRA §11404. QDWI does NOT auto-qualify
  // for LIS (unlike QMB/SLMB); Martha qualified separately via SSA application.
  // Was 'partial-1' pre-IRA.
  medicaid: 'qdwi', lis: 'full', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ["Alzheimer's (moderate)", 'Seizure Disorder (Alzheimer-related)', 'Hypertension', 'Urinary Incontinence', 'Recurrent Falls', 'Wandering Behavior'],
  specialists: ['Neurology (quarterly)', 'Geriatrics (quarterly)', 'Urology (biannual)'],
  hospital: { admissionsPerYear: 2, erVisitsPerYear: 4 },
  snf: { staysPerYear: 2, avgDaysPerStay: 45 },
  drugs: [
    d('Leqembi (lecanemab)', '', 2, 'part-b', 'part-b', 'IV biweekly ~$26.5k/yr Part B'),
    d('Donepezil', '10mg', 30, 1, 'part-d'),
    d('Memantine', '10mg', 60, 1, 'part-d'),
    d('Levetiracetam', '500mg', 120, 1, 'part-d', 'QL possible'),
    d('Amlodipine', '5mg', 30, 1, 'part-d'),
    d('Oxybutynin', '5mg', 60, 1, 'part-d'),
    d('Mirtazapine', '15mg', 30, 1, 'part-d'),
    d('Calcium + Vitamin D', '', 60, 'otc', 'part-d'),
  ],
  auditFocus: 'Leqembi Part B ($26.5k/yr → 20% coinsurance = $5.3k without supplement); 90-day SNF (2×45) → benefit period reset test; QDWI + separately-qualified Full LIS split: medical copays = standard plan amounts, drug copays = full LIS schedule; home health aide; wandering GPS device via supplemental.',
  complexityScore: 29,
};

const p25: BeneficiaryProfile = {
  id: '25-clarence', name: 'Clarence', age: 70,
  state: 'GA', countyName: 'Bibb', countyFips: '13021', zip: '31201',
  medicaid: 'none', lis: 'none', esrd: false, disabilityBased: false,
  snpEligibility: [],
  conditions: ['Advanced Prostate Cancer (mCRPC)', 'Bone Metastases', 'Anemia', 'Erectile Dysfunction', 'Depression', 'Osteoporosis (ADT-induced)', 'Spinal Cord Compression (treated)'],
  specialists: ['Urologic Oncology (monthly)', 'Medical Oncology (monthly)', 'Radiation Oncology (PRN)', 'Pain (monthly)', 'Orthopedic Spine (quarterly)'],
  hospital: { admissionsPerYear: 3, erVisitsPerYear: 4 },
  snf: { staysPerYear: 1, avgDaysPerStay: 30 },
  dme: ['Hospital bed', 'Wheelchair', 'TENS unit'],
  drugs: [
    d('Xtandi (enzalutamide)', '40mg', 120, 5, 'part-d', 'Oral chemo ~$13k/mo'),
    d('Lupron Depot', '22.5mg', 1, 'part-b', 'part-b', 'IM q3mo — provider-administered ADT'),
    d('Xgeva (denosumab)', '120mg', 1, 'part-b', 'part-b', 'SC monthly — provider-administered'),
    d('Prednisone', '5mg', 30, 1, 'part-d'),
    d('Oxycodone', '10mg', 90, 1, 'part-d'),
    d('Gabapentin', '600mg', 90, 1, 'part-d'),
    d('Alendronate', '70mg', 4, 1, 'part-d'),
    d('Sertraline', '100mg', 30, 1, 'part-d'),
    d('Tamsulosin', '0.4mg', 30, 1, 'part-d'),
    d('Ondansetron', '4mg', 30, 1, 'part-d'),
  ],
  auditFocus: 'Xtandi $13k/mo Tier 5 → catastrophic; Lupron+Xgeva Part B provider-administered; high DME; 3 admissions + 4 ER + SNF → MOOP hit; radiation therapy for bone mets/cord compression; opioid QL; Macon rural-ish market.',
  complexityScore: 28,
};

// ─── Export ─────────────────────────────────────────────────────────

export const allProfiles: BeneficiaryProfile[] = [
  p01, p02, p03, p04, p05, p06, p07, p08, p09,
  p10, p11, p12, p13, p14, p15, p16, p17,
  p18, p19, p20, p21, p22, p23, p24, p25,
];

export const profilesByState = {
  NC: allProfiles.filter((p) => p.state === 'NC'),
  TX: allProfiles.filter((p) => p.state === 'TX'),
  GA: allProfiles.filter((p) => p.state === 'GA'),
};

export function profileById(id: string): BeneficiaryProfile | undefined {
  return allProfiles.find((p) => p.id === id);
}

// Sanity check the complexity average — spec Appendix C targets ≥ 20.
export const averageComplexity =
  allProfiles.reduce((sum, p) => sum + p.complexityScore, 0) / allProfiles.length;
