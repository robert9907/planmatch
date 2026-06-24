// HealthSherpa Medicare intake deeplink builder.
//
// Interim Rob-Simm-branded intake URL while we wait on Partner API
// access. Once Partner API lands, swap `base` and (if needed) the
// param names below — every enrollment CTA in agent-v3 goes through
// this helper, so the swap is one-touch.

export interface MedicareEnrollLinkParams {
  /** Full CMS plan id triple — "{contract}-{plan}-{segment}" (e.g. "H9725-009-004"). */
  cms_plan_id?: string;
  /** County name without state suffix (e.g. "Chatham"). */
  county?: string;
  /** 5-digit ZIP. */
  zip_code?: string;
}

export function buildMedicareEnrollLink(params?: MedicareEnrollLinkParams): string {
  const base = 'https://medicare.healthsherpa.com/intake/robert-simm';
  if (!params) return base;
  const url = new URL(base);
  if (params.cms_plan_id) url.searchParams.set('cms_plan_id', params.cms_plan_id);
  if (params.county) url.searchParams.set('county', params.county);
  if (params.zip_code) url.searchParams.set('zip_code', params.zip_code);
  return url.toString();
}
