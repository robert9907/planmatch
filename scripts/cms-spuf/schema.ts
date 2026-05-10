// scripts/cms-spuf/schema.ts
//
// Per-file CMS SPUF column metadata: source file name, expected header
// row, target landing table, target column type. Single source of truth
// consumed by the parser (header validation), the loader (COPY FROM
// column list + per-cell coercion), and the parser unit tests.
//
// CMS column names are uppercase by convention; landing-table column
// names are lowercase. Order matters — landing tables in
// scripts/migrations/004_cms_spuf_landing.sql were defined in this
// exact order.

export type CmsColumnType =
  | 'text'        // verbatim string, trimmed
  | 'smallint'    // integer 16-bit
  | 'numeric'     // numeric(M,D); empty string → null
  | 'yn'          // CMS Y/N or 0/1 → text (preserved verbatim)
  | 'date';       // YYYYMMDD → date

export interface CmsColumn {
  cms: string;       // CMS header name, uppercase
  pg: string;        // landing-table column name
  type: CmsColumnType;
  nullable: boolean; // true if CMS spec allows blanks
}

export interface CmsFileSpec {
  // Internal canonical name for this file — used for logging and the
  // --skip CLI flag. Not used to match ZIP entries.
  name: string;
  // Friendly .txt name we'd write to the temp dir after extraction.
  // Used for log messages only.
  fileName: string;
  // Regex matched against entries inside the OUTER ZIP. The outer SPUF
  // ZIP contains one inner ZIP per data file, with inconsistent
  // human-friendly names like:
  //   "basic drugs formulary file  PPUF_2026Q1.zip"   (double space)
  //   "pricing file PPUF_2026Q1.zip"                   (single space)
  //   "plan information  PPUF_2026Q1.zip"              (no "file" word)
  // The regex tolerates any whitespace and casing.
  innerZipPattern: RegExp;
  // True when the data is split into multiple inner ZIPs (e.g.
  // pharmacy_networks part 1, part 2, …). The importer extracts every
  // matching entry and concatenates them, dropping the header row on
  // every part after the first.
  multiPart?: boolean;
  // Landing table to COPY into.
  landingTable: string;
  // Column order matches both the CMS file and the landing table DDL.
  columns: CmsColumn[];
  // Whether this file is shipped only in the quarterly bundle (not monthly).
  quarterlyOnly?: boolean;
  // Whether CMS may have removed this file in 2025+ (treat as optional).
  optionalSince?: number;
}

// Helper to keep the column tables compact and consistent.
const t = (cms: string, pg: string, nullable = true): CmsColumn => ({ cms, pg, type: 'text', nullable });
const yn = (cms: string, pg: string, nullable = false): CmsColumn => ({ cms, pg, type: 'yn', nullable });
const i = (cms: string, pg: string, nullable = false): CmsColumn => ({ cms, pg, type: 'smallint', nullable });
const n = (cms: string, pg: string, nullable = true): CmsColumn => ({ cms, pg, type: 'numeric', nullable });

// ─── A. plan_information ──────────────────────────────────────────────
export const PLAN_INFORMATION: CmsFileSpec = {
  name: 'plan_information',
  fileName: 'plan_information.txt',
  // CMS uses "plan information  PPUF_…" (no "file" word, double space).
  innerZipPattern: /^plan\s+information(\s+file)?\s+PPUF.*\.zip$/i,
  landingTable: 'cms_spuf_plan_information',
  columns: [
    t('CONTRACT_ID', 'contract_id', false),
    t('PLAN_ID', 'plan_id', false),
    t('SEGMENT_ID', 'segment_id', false),
    t('CONTRACT_NAME', 'contract_name', true),
    t('PLAN_NAME', 'plan_name', true),
    t('FORMULARY_ID', 'formulary_id', false),
    n('PREMIUM', 'premium', true),
    n('DEDUCTIBLE', 'deductible', true),
    // ICL (Initial Coverage Limit) was removed from the CMS file in
    // 2025+ when the IRA eliminated the coverage gap. The landing
    // table column stays (NULL) for compat with older releases.
    t('MA_REGION_CODE', 'ma_region_code', true),
    t('PDP_REGION_CODE', 'pdp_region_code', true),
    t('STATE', 'state', true),
    t('COUNTY_CODE', 'county_code', true),
    t('SNP', 'snp', false),
    yn('PLAN_SUPPRESSED_YN', 'plan_suppressed_yn', false),
  ],
};

// ─── B. basic_drugs_formulary_file ────────────────────────────────────
export const BASIC_DRUGS: CmsFileSpec = {
  name: 'basic_drugs',
  fileName: 'basic_drugs_formulary_file.txt',
  innerZipPattern: /^basic\s+drugs\s+formulary\s+file\s+PPUF.*\.zip$/i,
  landingTable: 'cms_spuf_basic_drugs',
  columns: [
    t('FORMULARY_ID', 'formulary_id', false),
    t('FORMULARY_VERSION', 'formulary_version', false),
    t('CONTRACT_YEAR', 'contract_year', false),
    t('RXCUI', 'rxcui', false),
    t('NDC', 'ndc', false),
    i('TIER_LEVEL_VALUE', 'tier_level_value', false),
    yn('QUANTITY_LIMIT_YN', 'quantity_limit_yn', false),
    t('QUANTITY_LIMIT_AMOUNT', 'quantity_limit_amount', true),
    t('QUANTITY_LIMIT_DAYS', 'quantity_limit_days', true),
    yn('PRIOR_AUTHORIZATION_YN', 'prior_authorization_yn', false),
    yn('STEP_THERAPY_YN', 'step_therapy_yn', false),
    // SELECTED_DRUG_YN was added in 2025+ — flag of unknown semantics
    // (CMS hasn't documented it on the SPUF page). Stored verbatim.
    yn('SELECTED_DRUG_YN', 'selected_drug_yn', true),
  ],
};

// ─── C. beneficiary_cost ──────────────────────────────────────────────
export const BENEFICIARY_COST: CmsFileSpec = {
  name: 'beneficiary_cost',
  fileName: 'beneficiary_cost.txt',
  innerZipPattern: /^beneficiary\s+cost\s+file\s+PPUF.*\.zip$/i,
  landingTable: 'cms_spuf_beneficiary_cost',
  columns: [
    t('CONTRACT_ID', 'contract_id', false),
    t('PLAN_ID', 'plan_id', false),
    t('SEGMENT_ID', 'segment_id', false),
    i('COVERAGE_LEVEL', 'coverage_level', false),
    i('TIER', 'tier', false),
    i('DAYS_SUPPLY', 'days_supply', false),
    i('COST_TYPE_PREF', 'cost_type_pref', false),
    n('COST_AMT_PREF', 'cost_amt_pref', true),
    t('COST_MIN_AMT_PREF', 'cost_min_amt_pref', true),
    n('COST_MAX_AMT_PREF', 'cost_max_amt_pref', true),
    i('COST_TYPE_NONPREF', 'cost_type_nonpref', false),
    n('COST_AMT_NONPREF', 'cost_amt_nonpref', true),
    t('COST_MIN_AMT_NONPREF', 'cost_min_amt_nonpref', true),
    n('COST_MAX_AMT_NONPREF', 'cost_max_amt_nonpref', true),
    i('COST_TYPE_MAIL_PREF', 'cost_type_mail_pref', false),
    n('COST_AMT_MAIL_PREF', 'cost_amt_mail_pref', true),
    t('COST_MIN_AMT_MAIL_PREF', 'cost_min_amt_mail_pref', true),
    n('COST_MAX_AMT_MAIL_PREF', 'cost_max_amt_mail_pref', true),
    i('COST_TYPE_MAIL_NONPREF', 'cost_type_mail_nonpref', false),
    n('COST_AMT_MAIL_NONPREF', 'cost_amt_mail_nonpref', true),
    t('COST_MIN_AMT_MAIL_NONPREF', 'cost_min_amt_mail_nonpref', true),
    n('COST_MAX_AMT_MAIL_NONPREF', 'cost_max_amt_mail_nonpref', true),
    yn('TIER_SPECIALTY_YN', 'tier_specialty_yn', false),
    yn('DED_APPLIES_YN', 'ded_applies_yn', false),
    // GAP_COV_TIER removed in 2025+ when IRA eliminated the coverage
    // gap. Landing column stays NULL for forward compat.
  ],
};

// ─── D. pharmacy_network ──────────────────────────────────────────────
// Note: landing table has a synthetic id; we don't include it in the
// COPY column list. pharmacy_zipcode is nullable per CMS. Split across
// 6 inner ZIPs ("part 1" … "part 6") for the 2026 Q1 release; total
// uncompressed ~24 GB. Skipped by default — pass --skip= to override.
export const PHARMACY_NETWORK: CmsFileSpec = {
  name: 'pharmacy_networks',
  fileName: 'pharmacy_network.txt',
  innerZipPattern: /^pharmacy\s+networks?\s+file\s+PPUF.*part\s*\d+\.zip$/i,
  multiPart: true,
  landingTable: 'cms_spuf_pharmacy_network',
  columns: [
    t('CONTRACT_ID', 'contract_id', false),
    t('PLAN_ID', 'plan_id', false),
    t('SEGMENT_ID', 'segment_id', false),
    t('PHARMACY_NUMBER', 'pharmacy_number', false),
    t('PHARMACY_ZIPCODE', 'pharmacy_zipcode', true),
    yn('PREFERRED_STATUS_RETAIL', 'preferred_status_retail', false),
    yn('PREFERRED_STATUS_MAIL', 'preferred_status_mail', false),
    yn('PHARMACY_RETAIL', 'pharmacy_retail', false),
    yn('PHARMACY_MAIL', 'pharmacy_mail', false),
    i('IN_AREA_FLAG', 'in_area_flag', false),
    n('BRAND_DISPENSING_FEE_30', 'brand_dispensing_fee_30', true),
    n('BRAND_DISPENSING_FEE_60', 'brand_dispensing_fee_60', true),
    n('BRAND_DISPENSING_FEE_90', 'brand_dispensing_fee_90', true),
    n('GENERIC_DISPENSING_FEE_30', 'generic_dispensing_fee_30', true),
    n('GENERIC_DISPENSING_FEE_60', 'generic_dispensing_fee_60', true),
    n('GENERIC_DISPENSING_FEE_90', 'generic_dispensing_fee_90', true),
  ],
};

// ─── E. excluded_drugs_formulary_file ─────────────────────────────────
// Note: PRIOR_AUTH_YN, not PRIOR_AUTHORIZATION_YN. CMS quirk.
export const EXCLUDED_DRUGS: CmsFileSpec = {
  name: 'excluded_drugs',
  fileName: 'excluded_drugs_formulary_file.txt',
  innerZipPattern: /^excluded\s+drugs\s+formulary\s+file\s+PPUF.*\.zip$/i,
  landingTable: 'cms_spuf_excluded_drugs',
  columns: [
    t('CONTRACT_ID', 'contract_id', false),
    t('PLAN_ID', 'plan_id', false),
    t('RXCUI', 'rxcui', false),
    i('TIER', 'tier', false),
    yn('QUANTITY_LIMIT_YN', 'quantity_limit_yn', false),
    t('QUANTITY_LIMIT_AMOUNT', 'quantity_limit_amount', true),
    t('QUANTITY_LIMIT_DAYS', 'quantity_limit_days', true),
    yn('PRIOR_AUTH_YN', 'prior_auth_yn', false),
    yn('STEP_THERAPY_YN', 'step_therapy_yn', false),
    yn('CAPPED_BENEFIT_YN', 'capped_benefit_yn', false),
    // GAP_COV removed in 2025+ (post-IRA). Landing column stays NULL.
  ],
};

// ─── F. indication_based_coverage_formulary_file ──────────────────────
export const INDICATION_BASED_COVERAGE: CmsFileSpec = {
  name: 'indication_based_coverage',
  fileName: 'indication_based_coverage_formulary_file.txt',
  innerZipPattern: /^indication\s+based\s+coverage\s+formulary\s+file\s+PPUF.*\.zip$/i,
  landingTable: 'cms_spuf_indication_based_coverage',
  columns: [
    t('CONTRACT_ID', 'contract_id', false),
    t('PLAN_ID', 'plan_id', false),
    t('RXCUI', 'rxcui', false),
    t('DISEASE', 'disease', false),
  ],
};

// ─── G. insulin_beneficiary_cost ──────────────────────────────────────
export const INSULIN_BENEFICIARY_COST: CmsFileSpec = {
  name: 'insulin_beneficiary_cost',
  fileName: 'insulin_beneficiary_cost.txt',
  innerZipPattern: /^insulin\s+beneficiary\s+cost\s+file\s+PPUF.*\.zip$/i,
  landingTable: 'cms_spuf_insulin_beneficiary_cost',
  columns: [
    t('CONTRACT_ID', 'contract_id', false),
    t('PLAN_ID', 'plan_id', false),
    t('SEGMENT_ID', 'segment_id', false),
    i('TIER', 'tier', true),                        // NULL for defined-standard plans
    i('DAYS_SUPPLY', 'days_supply', false),
    n('COPAY_AMT_PREF_INSLN', 'copay_amt_pref_insln', true),
    n('COPAY_AMT_NONPREF_INSLN', 'copay_amt_nonpref_insln', true),
    n('COPAY_AMT_MAIL_PREF_INSLN', 'copay_amt_mail_pref_insln', true),
    n('COPAY_AMT_MAIL_NONPREF_INSLN', 'copay_amt_mail_nonpref_insln', true),
    // 4 coinsurance variants added in 2025+. CMS ships these column
    // names lowercase; validator is case-insensitive.
    n('COIN_AMT_PREF_INSLN', 'coin_amt_pref_insln', true),
    n('COIN_AMT_NONPREF_INSLN', 'coin_amt_nonpref_insln', true),
    n('COIN_AMT_MAIL_PREF_INSLN', 'coin_amt_mail_pref_insln', true),
    n('COIN_AMT_MAIL_NONPREF_INSLN', 'coin_amt_mail_nonpref_insln', true),
  ],
};

// ─── H. pricing (quarterly only) ──────────────────────────────────────
export const PRICING: CmsFileSpec = {
  name: 'pricing',
  fileName: 'pricing.txt',
  innerZipPattern: /^pricing\s+file\s+PPUF.*\.zip$/i,
  landingTable: 'cms_spuf_pricing',
  quarterlyOnly: true,
  columns: [
    t('CONTRACT_ID', 'contract_id', false),
    t('PLAN_ID', 'plan_id', false),
    t('SEGMENT_ID', 'segment_id', false),
    t('NDC', 'ndc', false),
    i('DAYS_SUPPLY', 'days_supply', false),         // literal 30/60/90 (NOT coded enum)
    n('UNIT_COST', 'unit_cost', false),
  ],
};

// ─── I. geographic_locator ────────────────────────────────────────────
export const GEOGRAPHIC_LOCATOR: CmsFileSpec = {
  name: 'geographic_locator',
  fileName: 'geographic_locator.txt',
  innerZipPattern: /^geographic\s+locator\s+file\s+PPUF.*\.zip$/i,
  landingTable: 'cms_spuf_geographic_locator',
  columns: [
    t('COUNTY_CODE', 'county_code', false),
    t('STATENAME', 'statename', false),
    t('COUNTY', 'county', false),
    t('MA_REGION_CODE', 'ma_region_code', true),
    t('MA_REGION', 'ma_region', true),
    t('PDP_REGION_CODE', 'pdp_region_code', true),
    t('PDP_REGION', 'pdp_region', true),
  ],
};

// All files in canonical load order. Loader iterates this array.
// plan_information must be first because every other file's "plan
// exists" check depends on it (though the landing tables don't enforce
// FKs to plan_information for ingestion robustness).
export const ALL_FILES: CmsFileSpec[] = [
  PLAN_INFORMATION,
  GEOGRAPHIC_LOCATOR,
  BASIC_DRUGS,
  BENEFICIARY_COST,
  PHARMACY_NETWORK,
  EXCLUDED_DRUGS,
  INDICATION_BASED_COVERAGE,
  INSULIN_BENEFICIARY_COST,
  PRICING,
];

// Default skip list — pharmacy_networks unzips to ~24 GB across 6
// inner ZIPs and would add ~30–50 GB to Postgres after indexes. The
// existing pm_provider_network_cache (FHIR-fed) covers the app's
// current network-membership use cases; SPUF pharmacy_network is
// useful for "preferred vs standard" pharmacy pricing detail that the
// app doesn't surface yet. Override with --skip= or --skip=other_names.
export const DEFAULT_SKIP: string[] = ['pharmacy_networks'];
