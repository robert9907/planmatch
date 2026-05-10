// scripts/cms-pbp/benefit_map.ts
//
// Maps each canonical benefit_type the consumer surfaces to its CMS
// PBP source columns. Used by promote.ts to generate one INSERT per
// entry, which then UNION ALL into pbp_benefits_v2.
//
// The CMS column-naming convention is uniform across most Section B
// sub-letters:
//
//   pbp_{sub}_copay_amt_mc_min   →  copay
//   pbp_{sub}_copay_amt_mc_max   →  copay_max
//   pbp_{sub}_coins_pct_mc_min   →  coinsurance
//   pbp_{sub}_coins_pct_mc_max   →  coinsurance_max
//   pbp_{sub}_auth_yn = 'Y'       →  prior_auth
//   pbp_{sub}_refer_yn = 'Y'      →  referral_required
//
// where {sub} is e.g. 'b7a' (PCP), 'b7d' (specialist), 'b4a' (ER).
// Entries that follow this pattern just specify `sub_letter`. Entries
// with non-standard field names (mental health split, ambulance
// ground/air, lab, etc.) override columns explicitly.
//
// The benefit_type vocabulary matches what api/plans-with-extras.ts,
// api/plans.ts, and the consumer's brain code already consume — see
// /Users/robertsimm/Code/plan-match/api/plans.ts PBP_TYPE_TO_CATEGORY
// for the canonical list.

export interface BenefitMapEntry {
  benefit_type: string;
  // Landing table the row pulls from.
  source_table: string;
  // Sub-letter shorthand: derives copay/coins/auth/refer column names
  // from the standard CMS pattern. Overrides below take precedence.
  sub_letter?: string;
  // Explicit column overrides. Use when CMS uses non-standard names
  // (e.g. b7e MH has _mcis_minamt instead of _copay_amt_mc_min).
  copay_col?: string;
  copay_max_col?: string;
  coinsurance_col?: string;
  coinsurance_max_col?: string;
  prior_auth_col?: string;
  referral_col?: string;
  // For benefits that emit multiple rows per plan (ambulance ground/air,
  // dental preventive/comprehensive). NULL → single row, tier_id=NULL.
  tier_id?: string;
}

// Helper to expand sub_letter → standard column names.
export function resolveColumns(entry: BenefitMapEntry): {
  copay: string | null;
  copay_max: string | null;
  coinsurance: string | null;
  coinsurance_max: string | null;
  prior_auth: string | null;
  referral: string | null;
} {
  const sub = entry.sub_letter ? `pbp_${entry.sub_letter}` : null;
  return {
    copay:           entry.copay_col           ?? (sub ? `${sub}_copay_amt_mc_min` : null),
    copay_max:       entry.copay_max_col       ?? (sub ? `${sub}_copay_amt_mc_max` : null),
    coinsurance:     entry.coinsurance_col     ?? (sub ? `${sub}_coins_pct_mc_min` : null),
    coinsurance_max: entry.coinsurance_max_col ?? (sub ? `${sub}_coins_pct_mc_max` : null),
    prior_auth:      entry.prior_auth_col      ?? (sub ? `${sub}_auth_yn` : null),
    referral:        entry.referral_col        ?? (sub ? `${sub}_refer_yn` : null),
  };
}

// ─── v1 benefit map (22 entries) ──────────────────────────────────────
//
// Skipped from v1, reasons in inline comments below the array:
//   • inpatient_acute / inpatient_psych — interval-tiered, multi-row
//   • snf — interval-tiered (b2 same shape as inpatient)
//   • home_health — single row but uncovered above
//   • fitness, otc, food_card, transportation — supplemental benefits
//     in pbp_b13/b14 with non-standard cap/allowance shapes — defer

export const BENEFIT_MAP: BenefitMapEntry[] = [
  // ── Section B7 (Health Care Professional services) ───────────────
  { benefit_type: 'primary_care',  source_table: 'pbp_b7_health_prof', sub_letter: 'b7a' },
  { benefit_type: 'specialist',    source_table: 'pbp_b7_health_prof', sub_letter: 'b7d' },
  { benefit_type: 'physical_therapy',
    source_table: 'pbp_b7_health_prof', sub_letter: 'b7i' },
  { benefit_type: 'occupational_therapy',
    source_table: 'pbp_b7_health_prof', sub_letter: 'b7c' },
  { benefit_type: 'telehealth',    source_table: 'pbp_b7_health_prof', sub_letter: 'b7j' },
  // Mental health is split into individual session vs group session.
  // CMS uses _mcis_ (medical-cov individual session) and _mcgs_ for
  // group, with min/max suffixes that differ from the standard
  // _amt_mc_min/_max naming.
  { benefit_type: 'mental_health_individual',
    source_table: 'pbp_b7_health_prof',
    copay_col:           'pbp_b7e_copay_mcis_minamt',
    copay_max_col:       'pbp_b7e_copay_mcis_maxamt',
    coinsurance_col:     'pbp_b7e_coins_mcis_minpct',
    coinsurance_max_col: 'pbp_b7e_coins_mcis_maxpct',
    prior_auth_col:      'pbp_b7e_auth_yn',
    referral_col:        'pbp_b7e_refer_yn',
  },
  { benefit_type: 'mental_health_group',
    source_table: 'pbp_b7_health_prof',
    copay_col:           'pbp_b7e_copay_mcgs_minamt',
    copay_max_col:       'pbp_b7e_copay_mcgs_maxamt',
    coinsurance_col:     'pbp_b7e_coins_mcgs_minpct',
    coinsurance_max_col: 'pbp_b7e_coins_mcgs_maxpct',
    prior_auth_col:      'pbp_b7e_auth_yn',
    referral_col:        'pbp_b7e_refer_yn',
  },
  // Psychiatric services (b7h) — distinct from mental health (b7e).
  { benefit_type: 'psychiatric',   source_table: 'pbp_b7_health_prof', sub_letter: 'b7h' },

  // ── Section B4 (Emergency / Urgent / Worldwide) ──────────────────
  { benefit_type: 'emergency',         source_table: 'pbp_b4_emerg_urgent', sub_letter: 'b4a' },
  { benefit_type: 'urgent_care',       source_table: 'pbp_b4_emerg_urgent', sub_letter: 'b4b' },
  { benefit_type: 'worldwide_emergency',
    source_table: 'pbp_b4_emerg_urgent', sub_letter: 'b4c' },

  // ── Section B8 (Outpatient Diagnostic / Lab) ─────────────────────
  // b8a is one wide row covering lab + diagnostic radiology +
  // therapeutic radiology, each with its own field set.
  { benefit_type: 'lab',
    source_table: 'pbp_b8_clin_diag_ther',
    copay_col:       'pbp_b8a_lab_copay_amt',
    copay_max_col:   'pbp_b8a_lab_copay_amt_max',
    coinsurance_col: 'pbp_b8a_coins_pct_lab',
    coinsurance_max_col: 'pbp_b8a_coins_pct_lab_max',
  },
  { benefit_type: 'diagnostic_radiology',
    source_table: 'pbp_b8_clin_diag_ther',
    copay_col:       'pbp_b8a_copay_min_dmc_amt',
    copay_max_col:   'pbp_b8a_copay_max_dmc_amt',
    coinsurance_col: 'pbp_b8a_coins_pct_dmc',
    coinsurance_max_col: 'pbp_b8a_coins_pct_dmc_max',
  },

  // ── Section B9 (Outpatient Hospital / ASC) ───────────────────────
  // b9a (outpatient hospital surgery) uses _ohs_ infix.
  // b9b (ambulatory surgical center) uses standard _mc_ pattern.
  { benefit_type: 'outpatient_surgery_hospital',
    source_table: 'pbp_b9_outpat_hosp',
    copay_col:           'pbp_b9a_copay_ohs_amt_min',
    copay_max_col:       'pbp_b9a_copay_ohs_amt_max',
    coinsurance_col:     'pbp_b9a_coins_ohs_pct_min',
    coinsurance_max_col: 'pbp_b9a_coins_ohs_pct_max',
    prior_auth_col:      'pbp_b9a_auth_yn',
  },
  { benefit_type: 'outpatient_surgery_asc',
    source_table: 'pbp_b9_outpat_hosp',
    copay_col:           'pbp_b9b_copay_mc_amt',
    copay_max_col:       'pbp_b9b_copay_mc_amt_max',
    coinsurance_col:     'pbp_b9b_coins_pct_mc',
    coinsurance_max_col: 'pbp_b9b_coins_pct_mc_max',
    prior_auth_col:      'pbp_b9b_auth_yn',
  },

  // ── Section B10 (Ambulance / Transport) ──────────────────────────
  // Two rows — ground (gas) and air (aas) ambulance, distinguished
  // by tier_id. Both share auth/refer flags from b10a top level.
  { benefit_type: 'ambulance', tier_id: 'ground',
    source_table: 'pbp_b10_amb_trans',
    copay_col:           'pbp_b10a_copay_gas_amt_min',
    copay_max_col:       'pbp_b10a_copay_gas_amt_max',
    coinsurance_col:     'pbp_b10a_coins_gas_pct_min',
    coinsurance_max_col: 'pbp_b10a_coins_gas_pct_max',
    prior_auth_col:      'pbp_b10a_auth_yn',
  },
  { benefit_type: 'ambulance', tier_id: 'air',
    source_table: 'pbp_b10_amb_trans',
    copay_col:           'pbp_b10a_copay_aas_amt_min',
    copay_max_col:       'pbp_b10a_copay_aas_amt_max',
    coinsurance_col:     'pbp_b10a_coins_aas_pct_min',
    coinsurance_max_col: 'pbp_b10a_coins_aas_pct_max',
    prior_auth_col:      'pbp_b10a_auth_yn',
  },

  // ── Section B16 (Dental) ──────────────────────────────────────────
  { benefit_type: 'dental_preventive',
    source_table: 'pbp_b16_dental', sub_letter: 'b16a' },
  { benefit_type: 'dental_comprehensive',
    source_table: 'pbp_b16_dental', sub_letter: 'b16b' },

  // ── Section B17 (Vision) ──────────────────────────────────────────
  { benefit_type: 'vision_exam',     source_table: 'pbp_b17_eye_exams_wear', sub_letter: 'b17a' },
  { benefit_type: 'vision_eyewear',  source_table: 'pbp_b17_eye_exams_wear', sub_letter: 'b17b' },

  // ── Section B18 (Hearing) ─────────────────────────────────────────
  { benefit_type: 'hearing_exam', source_table: 'pbp_b18_hearing_exams_aids', sub_letter: 'b18a' },
  { benefit_type: 'hearing_aid',  source_table: 'pbp_b18_hearing_exams_aids', sub_letter: 'b18b' },
  { benefit_type: 'hearing_aid_otc',
    source_table: 'pbp_b18_hearing_exams_aids', sub_letter: 'b18c' },

  // ── Section B6 (Home health) ─────────────────────────────────────
  { benefit_type: 'home_health',
    source_table: 'pbp_b6_home_health',
    copay_col:           'pbp_b6_copay_mc_amt_min',
    copay_max_col:       'pbp_b6_copay_mc_amt_max',
    coinsurance_col:     'pbp_b6_coins_pct_mc_min',
    coinsurance_max_col: 'pbp_b6_coins_pct_mc_max',
    prior_auth_col:      'pbp_b6_auth_yn',
  },
];

// Deferred to v1.1 (need multi-row tier emission):
//   inpatient_acute        — b1a interval × tier (3 intervals × up to 3 tiers)
//   inpatient_psych        — b1b same shape
//   snf                    — b2 same shape
//   rx_tier_1..6           — pbp_mrx_tier per Part D tier (covered by SPUF too)
//
// Deferred to v1.2 (allowance/cap shape, not standard cost-share):
//   otc_quarter, food_card_month, fitness, transportation_trips,
//   meals, in_home_support, dental_annual_max
