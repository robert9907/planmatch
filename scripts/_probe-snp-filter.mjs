#!/usr/bin/env node
// scripts/_probe-snp-filter.mjs — find the /plans/search knob that
// surfaces SNPs. LIS wasn't it. Trying plan_type variants + body
// fields like snp_type / snpType / include_snps.

const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function h() {
  const t = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  const s = [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return {
    'Content-Type': 'application/json', Accept: 'application/json',
    Origin: 'https://www.medicare.gov', Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': FE_VER,
    traceparent: `00-${t}-${s}-01`,
  };
}

async function main() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6000);

  const zip = '78002', fips = '48029', year = 2026; // Bexar (D-SNP-heavy)

  // 1. Try alternate plan_type enum values
  console.log('▶ Trying plan_type enum variants for Bexar TX…');
  const planTypes = [
    'PLAN_TYPE_MAPD', 'PLAN_TYPE_MA', 'PLAN_TYPE_PDP', 'PLAN_TYPE_MEDIGAP',
    'PLAN_TYPE_MAPD_SNP', 'PLAN_TYPE_SNP', 'PLAN_TYPE_DSNP', 'PLAN_TYPE_CSNP',
    'PLAN_TYPE_ISNP', 'PLAN_TYPE_MA_SNP', 'PLAN_TYPE_ALL',
    'PLAN_TYPE_UNSPECIFIED',
  ];
  for (const pt of planTypes) {
    const qs = new URLSearchParams({ zip, fips, plan_type: pt, year: String(year), lang: 'en' });
    const url = `${SEARCH_URL}?${qs.toString()}&page=1`;
    const body = { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [] };
    const resp = await page.request.post(url, { data: body, headers: h(), timeout: 30_000 });
    if (resp.status() !== 200) {
      const t = (await resp.text()).slice(0, 150);
      console.log(`  ✗ ${pt.padEnd(28)} ${resp.status()}: ${t.slice(0, 100)}`);
      continue;
    }
    const j = await resp.json();
    const list = j.plans ?? [];
    const snps = list.filter((p) => p.snp_type && p.snp_type !== 'SNP_TYPE_NOT_SNP');
    console.log(`  ✓ ${pt.padEnd(28)} total=${j.total_results} on_page=${list.length} snps_on_page=${snps.length}`);
    if (snps.length > 0) {
      snps.slice(0, 3).forEach((p) => console.log(`      ${p.contract_id}-${p.plan_id} ${p.name} (${p.snp_type})`));
    }
    await page.waitForTimeout(400);
  }

  // 2. Try body-level snp_type / snpType / include_snp fields
  console.log('\n▶ Trying body-level SNP fields (with plan_type=MAPD)…');
  const bodyVariants = [
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], snpType: 'SNP_TYPE_DUAL_ELIGIBLE' },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], snp_type: 'SNP_TYPE_DUAL_ELIGIBLE' },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], includeSnps: true },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], include_snp: true },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], hasMedicaid: true },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], has_medicaid: true },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], dualEligible: true },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], snpTypes: ['SNP_TYPE_DUAL_ELIGIBLE'] },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], snp_types: ['SNP_TYPE_DUAL_ELIGIBLE'] },
    { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [], planCategories: ['PLAN_CATEGORY_HMO'], snpTypes: ['SNP_TYPE_DUAL_ELIGIBLE'] },
  ];
  const qs = new URLSearchParams({ zip, fips, plan_type: 'PLAN_TYPE_MAPD', year: String(year), lang: 'en' });
  const url = `${SEARCH_URL}?${qs.toString()}&page=1`;
  for (const bv of bodyVariants) {
    const resp = await page.request.post(url, { data: bv, headers: h(), timeout: 30_000 });
    const extraKey = Object.keys(bv).find((k) => !['npis','prescriptions','lis','starRatings','organizationNames'].includes(k));
    if (resp.status() !== 200) {
      const t = (await resp.text()).slice(0, 150);
      console.log(`  ✗ ${extraKey.padEnd(20)} ${resp.status()}: ${t.slice(0, 100)}`);
      continue;
    }
    const j = await resp.json();
    const list = j.plans ?? [];
    const snps = list.filter((p) => p.snp_type && p.snp_type !== 'SNP_TYPE_NOT_SNP');
    console.log(`  ✓ ${extraKey.padEnd(20)} total=${j.total_results} on_page=${list.length} snps=${snps.length}`);
    if (snps.length > 0) snps.slice(0, 2).forEach((p) => console.log(`      ${p.contract_id}-${p.plan_id} ${p.name} (${p.snp_type})`));
    await page.waitForTimeout(400);
  }

  // 3. Try the plan-detail endpoint directly on a known D-SNP contract/plan
  // to see if plan-detail is unrestricted (would let us fetch SNP data
  // per-plan even if search doesn't list them).
  console.log('\n▶ Testing plan-detail endpoint on Wellcare Superior D-SNP (H0174-004)…');
  const detailUrl = `https://www.medicare.gov/api/v1/data/plan-compare/plan/${year}/H0174/004/0?lis=LIS_NO_HELP`;
  const dResp = await page.request.get(detailUrl, { headers: h(), timeout: 30_000 });
  const dText = await dResp.text();
  console.log(`  status ${dResp.status()}  bytes=${dText.length}`);
  if (dResp.status() === 200) {
    const j = JSON.parse(dText);
    // Peek at what fields the detail carries
    const pc = j.plan_card ?? j.data?.plan_card ?? j;
    console.log('  top-level detail keys:', Object.keys(j).slice(0, 15));
    if (pc && typeof pc === 'object') console.log('  plan_card keys:', Object.keys(pc).slice(0, 20));
    console.log('  snp?', j.snp_type ?? pc?.snp_type ?? '(nothing at these paths)');
  } else {
    console.log('  detail response first 300 chars:', dText.slice(0, 300));
  }

  // 4. Look at what a full page 4 of Bexar looks like (SNPs may be paginated last)
  console.log('\n▶ Checking all pages of Bexar for SNPs…');
  const qs2 = new URLSearchParams({ zip, fips, plan_type: 'PLAN_TYPE_MAPD', year: String(year), lang: 'en' });
  const url2 = `${SEARCH_URL}?${qs2.toString()}`;
  let allSnps = 0;
  for (let p = 1; p <= 20; p++) {
    const bd = { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [] };
    const r = await page.request.post(`${url2}&page=${p}`, { data: bd, headers: h(), timeout: 30_000 });
    if (r.status() !== 200) { console.log(`  page ${p}: status ${r.status()}`); break; }
    const j = await r.json();
    const list = j.plans ?? [];
    if (list.length === 0) break;
    const snpTypes = new Set(list.map((x) => x.snp_type));
    const snpCount = list.filter((x) => x.snp_type && x.snp_type !== 'SNP_TYPE_NOT_SNP').length;
    console.log(`  page ${p}: ${list.length} plans, snp_types=[${[...snpTypes].join(',')}], snps=${snpCount}`);
    allSnps += snpCount;
    if (list.length < 10) break;
    await page.waitForTimeout(300);
  }
  console.log(`  Total SNPs across pages: ${allSnps}`);

  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
