// scripts/cms-pbp/discover.ts
//
// Resolves a year to the canonical PBP-benefits ZIP URL. Unlike the
// SPUF importer (which has to scrape data.cms.gov for UUID-suffixed
// URLs), CMS publishes PBP at a stable, predictable URL per year:
//
//   https://www.cms.gov/files/zip/pbp-benefits-2026.zip
//   https://www.cms.gov/files/zip/pbp-benefits-2025.zip
//   https://www.cms.gov/files/zip/pbp-benefits-2024-quarter-N.zip   (pre-2025 used quarter suffixes)
//
// CMS updates the 2025+ files in place each quarter — same URL, new
// SHA + new Last-Modified. The importer's idempotency keys on SHA, so
// re-running the same URL is a no-op until CMS posts a refresh.

export interface DiscoveredRelease {
  url: string;
  releaseDate: string;   // YYYY-MM-DD from Last-Modified header
  planYear: number;
  fileName: string;      // pbp-benefits-2026.zip
}

const CMS_HOST = 'https://www.cms.gov';

export async function discoverRelease(opts: { year: number }): Promise<DiscoveredRelease> {
  const fileName = `pbp-benefits-${opts.year}.zip`;
  const url = `${CMS_HOST}/files/zip/${fileName}`;

  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) {
    throw new Error(
      `CMS returned ${head.status} for ${url}. ` +
        `Pre-2025 releases use quarter suffixes (e.g. pbp-benefits-2024-quarter-1.zip) — ` +
        `pass --url to override.`,
    );
  }
  const lastModifiedHeader = head.headers.get('last-modified');
  const releaseDate = lastModifiedHeader ? toYmd(lastModifiedHeader) : todayYmd();

  return {
    url,
    releaseDate,
    planYear: opts.year,
    fileName,
  };
}

// Parse RFC-7231 IMF-fixdate (e.g. "Tue, 28 Oct 2025 13:39:17 GMT") → YYYY-MM-DD.
function toYmd(httpDate: string): string {
  const d = new Date(httpDate);
  if (Number.isNaN(d.getTime())) return todayYmd();
  return d.toISOString().slice(0, 10);
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

// For --url=... overrides. Tries to parse year out of the filename;
// caller must pass --year explicitly when the URL doesn't match the
// canonical pattern.
export function parseUrlMetadata(url: string): { fileName: string; planYearGuess: number | null } {
  const fileName = url.split('/').pop() ?? url;
  const m = fileName.match(/pbp-benefits-(\d{4})/i);
  return {
    fileName,
    planYearGuess: m ? Number(m[1]) : null,
  };
}
