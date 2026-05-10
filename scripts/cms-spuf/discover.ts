// scripts/cms-spuf/discover.ts
//
// Resolves a (year, quarter|month) pair to a concrete CMS SPUF/PUF ZIP
// download URL. CMS publishes the dataset metadata as a Drupal node
// embedded in the HTML page; we scrape the page once and pick the
// matching distribution.
//
// Two release flavors:
//   quarterly — file pattern SPUF_<year>_<YYYYMMDD>.zip
//   monthly   — file pattern <year>_<YYYYMMDD>.zip   (no SPUF_ prefix)
//
// Quarterly index page:
//   https://data.cms.gov/provider-summary-by-type-of-service/
//   medicare-part-d-prescribers/quarterly-prescription-drug-plan-formulary-
//   pharmacy-network-and-pricing-information
//
// Monthly index page:
//   https://data.cms.gov/provider-summary-by-type-of-service/
//   medicare-part-d-prescribers/monthly-prescription-drug-plan-formulary-
//   and-pharmacy-network-information
//
// CMS embeds the file URLs in the HTML as `<a href="...">` and also as
// JSON-LD distribution metadata. The HTML link form is more stable
// across page revisions, so we parse that.

const QUARTERLY_INDEX =
  'https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/quarterly-prescription-drug-plan-formulary-pharmacy-network-and-pricing-information';
const MONTHLY_INDEX =
  'https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/monthly-prescription-drug-plan-formulary-and-pharmacy-network-information';

export interface DiscoveredRelease {
  url: string;
  releaseDate: string; // YYYY-MM-DD
  planYear: number;
  releaseKind: 'quarterly' | 'monthly';
  fileName: string;    // SPUF_2026_20260408.zip
}

// Parse an 8-digit YYYYMMDD into YYYY-MM-DD. Returns null on bad input.
function parseYmd(yyyymmdd: string): string | null {
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Map a CMS release date to its quarter (Q1/Q2/Q3/Q4) using calendar
// month. Quarterly releases come out roughly: Q1 in Apr, Q2 in Jul,
// Q3 in Oct, Q4 in Jan-of-next-year. We classify by month at release
// to match how CMS labels them in their methodology PDFs.
export function quarterOf(yyyymmdd: string): 'Q1' | 'Q2' | 'Q3' | 'Q4' {
  const month = Number(yyyymmdd.slice(4, 6));
  if (month >= 1 && month <= 3) return 'Q4';   // Jan release contains Q4 of previous fiscal cycle
  if (month >= 4 && month <= 6) return 'Q1';
  if (month >= 7 && month <= 9) return 'Q2';
  return 'Q3';
}

// Pull every plausible SPUF/PUF ZIP href out of the dataset page HTML.
async function fetchHrefs(indexUrl: string): Promise<string[]> {
  const res = await fetch(indexUrl, {
    headers: { 'user-agent': 'planmatch-spuf-importer/1.0' },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${indexUrl}: ${res.status}`);
  const html = await res.text();
  const hrefs = new Set<string>();
  // Match href="..." capturing the URL only.
  const re = /href="(https:\/\/data\.cms\.gov\/sites\/default\/files\/[^"]+\.zip)"/gi;
  for (const m of html.matchAll(re)) hrefs.add(m[1]);
  return [...hrefs];
}

// Public entrypoint. If `releaseDate` is provided (YYYYMMDD), it picks
// that exact release. Otherwise picks the latest matching the requested
// quarter/year/kind.
export async function discoverRelease(opts: {
  year: number;
  kind: 'quarterly' | 'monthly';
  quarter?: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  releaseDate?: string; // YYYYMMDD
}): Promise<DiscoveredRelease> {
  const indexUrl = opts.kind === 'quarterly' ? QUARTERLY_INDEX : MONTHLY_INDEX;
  const hrefs = await fetchHrefs(indexUrl);

  // Filename patterns:
  //   quarterly: .../SPUF_<year>_<YYYYMMDD>.zip
  //   monthly:   .../<year>_<YYYYMMDD>.zip   (no SPUF_)
  const filenameRe =
    opts.kind === 'quarterly'
      ? /\/(SPUF_(\d{4})_(\d{8})\.zip)$/i
      : /\/((\d{4})_(\d{8})\.zip)$/i;

  type Candidate = { url: string; fileName: string; year: number; ymd: string };
  const matches: Candidate[] = [];
  for (const href of hrefs) {
    const m = href.match(filenameRe);
    if (!m) continue;
    const year = Number(m[2]);
    const ymd = m[3];
    if (year !== opts.year) continue;
    matches.push({ url: href, fileName: m[1], year, ymd });
  }

  if (matches.length === 0) {
    throw new Error(
      `No ${opts.kind} releases found for year=${opts.year} on the CMS dataset page. ` +
        `Pass --url=<zip-url> to override.`,
    );
  }

  let chosen: Candidate;
  if (opts.releaseDate) {
    const c = matches.find((m) => m.ymd === opts.releaseDate);
    if (!c) {
      throw new Error(
        `Release date ${opts.releaseDate} not found for year=${opts.year}. ` +
          `Available: ${matches.map((m) => m.ymd).join(', ')}`,
      );
    }
    chosen = c;
  } else if (opts.kind === 'quarterly' && opts.quarter) {
    const filtered = matches.filter((m) => quarterOf(m.ymd) === opts.quarter);
    if (filtered.length === 0) {
      throw new Error(
        `No quarterly releases for ${opts.year} ${opts.quarter}. ` +
          `Available release dates: ${matches.map((m) => m.ymd).join(', ')}`,
      );
    }
    // Latest by date within the quarter (CMS occasionally posts errata).
    chosen = filtered.sort((a, b) => b.ymd.localeCompare(a.ymd))[0];
  } else {
    // No quarter/release_date specified — pick the latest available for the year.
    chosen = matches.sort((a, b) => b.ymd.localeCompare(a.ymd))[0];
  }

  const releaseDate = parseYmd(chosen.ymd);
  if (!releaseDate) throw new Error(`Failed to parse release date from ${chosen.fileName}`);

  return {
    url: chosen.url,
    releaseDate,
    planYear: chosen.year,
    releaseKind: opts.kind,
    fileName: chosen.fileName,
  };
}

// For --url=... overrides. Parse year and date out of the filename.
export function parseUrlMetadata(url: string): {
  releaseKind: 'quarterly' | 'monthly';
  planYear: number;
  releaseDate: string;
  fileName: string;
} {
  const fileName = url.split('/').pop() ?? url;
  const q = fileName.match(/^SPUF_(\d{4})_(\d{8})\.zip$/i);
  if (q) {
    const releaseDate = parseYmd(q[2]);
    if (!releaseDate) throw new Error(`Bad date in ${fileName}`);
    return { releaseKind: 'quarterly', planYear: Number(q[1]), releaseDate, fileName };
  }
  const m = fileName.match(/^(\d{4})_(\d{8})\.zip$/i);
  if (m) {
    const releaseDate = parseYmd(m[2]);
    if (!releaseDate) throw new Error(`Bad date in ${fileName}`);
    return { releaseKind: 'monthly', planYear: Number(m[1]), releaseDate, fileName };
  }
  throw new Error(
    `Cannot parse year/date from filename "${fileName}". Expected SPUF_<year>_<YYYYMMDD>.zip or <year>_<YYYYMMDD>.zip.`,
  );
}
