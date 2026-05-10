// scripts/cms-pbp/schema.ts
//
// Static metadata for every PBP file the importer loads. Column lists
// for each file come from the dictionary (see dictionary.ts) at
// runtime — they're too long to maintain by hand (~16,000 columns
// total across 17 files) and CMS adds/removes fields year-over-year.
//
// What lives here is the small set of facts NOT in the dictionary:
// internal name, source filename, target landing-table name, primary-
// key column list (the standard 3 — pbp_a_hnumber, pbp_a_plan_identifier,
// segment_id — plus county_code for PlanArea), and a flag for whether
// the file is in v1 scope.
//
// Skipped from v1 (commented out at the bottom): pharmacy / MRX
// (covered by SPUF), Section C / OON (out-of-network — separate
// effort), step files (long-format detail), VBID (discontinued in
// 2026), B3 / B5 / B11 / B12 / B19 / B20.

export interface PbpFileSpec {
  // Internal short name for logging and the --skip CLI flag.
  name: string;
  // The .txt name inside the PBP ZIP (lowercase, no path).
  fileName: string;
  // Landing table to COPY into.
  landingTable: string;
  // Natural-key columns. When `dedupePolicy: 'unique'` (default) these
  // form the PRIMARY KEY. When 'tolerate-duplicates', the landing
  // table gets a synthetic `id bigserial PRIMARY KEY` and these
  // columns get a non-unique index — for files where CMS ships
  // legitimately duplicate natural-key rows (PlanArea has ~14 dupes
  // in 2026 — same plan listed twice for the same county).
  pkColumns: string[];
  // Default 'unique' (PK on release_id + pkColumns). 'tolerate-
  // duplicates' uses a synthetic id PK + non-unique index.
  dedupePolicy?: 'unique' | 'tolerate-duplicates';
}

const STD_PK = ['pbp_a_hnumber', 'pbp_a_plan_identifier', 'segment_id'];

// ─── A. Plan registry & financials ─────────────────────────────────

export const SECTION_A: PbpFileSpec = {
  name: 'section_a',
  fileName: 'pbp_Section_A.txt',
  landingTable: 'pbp_section_a',
  pkColumns: STD_PK,
};

export const SECTION_D: PbpFileSpec = {
  name: 'section_d',
  fileName: 'pbp_Section_D.txt',
  landingTable: 'pbp_section_d',
  pkColumns: STD_PK,
};

export const PLANAREA: PbpFileSpec = {
  name: 'planarea',
  fileName: 'PlanArea.txt',
  landingTable: 'pbp_planarea',
  // PlanArea is keyed by (plan, county) — every county the plan serves
  // gets its own row. ~2.3M rows in 2026 with ~14 legitimate
  // duplicates (CMS lists some plan-county combos twice — same data,
  // intentional artifact). Synthetic PK accommodates these without
  // dropping rows.
  pkColumns: [...STD_PK, 'county_code'],
  dedupePolicy: 'tolerate-duplicates',
};

// ─── B. Medical-benefit subset (14 files) ──────────────────────────
//
// Every Section B top-level file is at (contract, plan, segment) grain
// — one row per plan-segment regardless of how many sub-letter benefits
// the file covers. The cost-share for each sub-letter is in dedicated
// columns (e.g. pbp_b7a_*, pbp_b7d_*, pbp_b7j_*) within the same row.

export const B1A_INPAT_HOSP: PbpFileSpec = {
  name: 'b1a_inpat_hosp',
  fileName: 'pbp_b1a_inpat_hosp.txt',
  landingTable: 'pbp_b1a_inpat_hosp',
  pkColumns: STD_PK,
};

export const B1B_INPAT_HOSP: PbpFileSpec = {
  name: 'b1b_inpat_hosp',
  fileName: 'pbp_b1b_inpat_hosp.txt',
  landingTable: 'pbp_b1b_inpat_hosp',
  pkColumns: STD_PK,
};

export const B2_SNF: PbpFileSpec = {
  name: 'b2_snf',
  fileName: 'pbp_b2_snf.txt',
  landingTable: 'pbp_b2_snf',
  pkColumns: STD_PK,
};

export const B4_EMERG_URGENT: PbpFileSpec = {
  name: 'b4_emerg_urgent',
  fileName: 'pbp_b4_emerg_urgent.txt',
  landingTable: 'pbp_b4_emerg_urgent',
  pkColumns: STD_PK,
};

export const B6_HOME_HEALTH: PbpFileSpec = {
  name: 'b6_home_health',
  fileName: 'pbp_b6_home_health.txt',
  landingTable: 'pbp_b6_home_health',
  pkColumns: STD_PK,
};

export const B7_HEALTH_PROF: PbpFileSpec = {
  name: 'b7_health_prof',
  fileName: 'pbp_b7_health_prof.txt',
  landingTable: 'pbp_b7_health_prof',
  pkColumns: STD_PK,
};

export const B8_CLIN_DIAG_THER: PbpFileSpec = {
  name: 'b8_clin_diag_ther',
  fileName: 'pbp_b8_clin_diag_ther.txt',
  landingTable: 'pbp_b8_clin_diag_ther',
  pkColumns: STD_PK,
};

export const B9_OUTPAT_HOSP: PbpFileSpec = {
  name: 'b9_outpat_hosp',
  fileName: 'pbp_b9_outpat_hosp.txt',
  landingTable: 'pbp_b9_outpat_hosp',
  pkColumns: STD_PK,
};

export const B10_AMB_TRANS: PbpFileSpec = {
  name: 'b10_amb_trans',
  fileName: 'pbp_b10_amb_trans.txt',
  landingTable: 'pbp_b10_amb_trans',
  pkColumns: STD_PK,
};

export const B13_OTHER_SERVICES: PbpFileSpec = {
  name: 'b13_other_services',
  fileName: 'pbp_b13_other_services.txt',
  landingTable: 'pbp_b13_other_services',
  pkColumns: STD_PK,
};

export const B14_PREVENTIVE: PbpFileSpec = {
  name: 'b14_preventive',
  fileName: 'pbp_b14_preventive.txt',
  landingTable: 'pbp_b14_preventive',
  pkColumns: STD_PK,
};

export const B15_PARTB_RX_DRUGS: PbpFileSpec = {
  name: 'b15_partb_rx_drugs',
  fileName: 'pbp_b15_partb_rx_drugs.txt',
  landingTable: 'pbp_b15_partb_rx_drugs',
  pkColumns: STD_PK,
};

export const B16_DENTAL: PbpFileSpec = {
  name: 'b16_dental',
  fileName: 'pbp_b16_dental.txt',
  landingTable: 'pbp_b16_dental',
  pkColumns: STD_PK,
};

export const B17_EYE_EXAMS_WEAR: PbpFileSpec = {
  name: 'b17_eye_exams_wear',
  fileName: 'pbp_b17_eye_exams_wear.txt',
  landingTable: 'pbp_b17_eye_exams_wear',
  pkColumns: STD_PK,
};

export const B18_HEARING_EXAMS_AIDS: PbpFileSpec = {
  name: 'b18_hearing_exams_aids',
  fileName: 'pbp_b18_hearing_exams_aids.txt',
  landingTable: 'pbp_b18_hearing_exams_aids',
  pkColumns: STD_PK,
};

// All files in canonical load order. plan_information equivalent
// (Section A) loads first; PlanArea last because it's the largest.
export const ALL_FILES: PbpFileSpec[] = [
  SECTION_A,
  SECTION_D,
  B1A_INPAT_HOSP,
  B1B_INPAT_HOSP,
  B2_SNF,
  B4_EMERG_URGENT,
  B6_HOME_HEALTH,
  B7_HEALTH_PROF,
  B8_CLIN_DIAG_THER,
  B9_OUTPAT_HOSP,
  B10_AMB_TRANS,
  B13_OTHER_SERVICES,
  B14_PREVENTIVE,
  B15_PARTB_RX_DRUGS,
  B16_DENTAL,
  B17_EYE_EXAMS_WEAR,
  B18_HEARING_EXAMS_AIDS,
  PLANAREA,
];

// PK columns are always TEXT in the landing table — leading zeros on
// pbp_a_hnumber / pbp_a_plan_identifier / segment_id are semantically
// significant. The dictionary may declare them as NUMBER; the loader
// overrides to TEXT for these specific names.
export const FORCED_TEXT_COLUMNS: ReadonlySet<string> = new Set([
  'pbp_a_hnumber',
  'pbp_a_plan_identifier',
  'segment_id',
  'county_code',
  'state',
  'stcd',
  'bid_id',
  'version',
  'contract_id',  // present in PlanArea
  'plan_id',       // present in PlanArea
]);

// Skipped CMS files (not in scope for v1):
//   pbp_b3_cardiac_rehab.txt
//   pbp_b5_partial_hosp.txt
//   pbp_b5b_intensive_outpt.txt
//   pbp_b11_dme_prosth_orth_sup.txt
//   pbp_b12_renal_dialysis.txt
//   pbp_b19_model_test.txt        (mostly empty in 2026)
//   pbp_b20.txt                    (cost-plan enhanced Rx)
//   pbp_mrx*.txt                   (Part D — covered by SPUF)
//   pbp_Section_C*.txt             (out-of-network — separate effort)
//   pbp_step*.txt                  (long-format detail companions)
//   *_vbid_uf*.txt                 (VBID discontinued in 2026)
//   pbp_PlanRegionArea.txt         (regional MA / PDP)
