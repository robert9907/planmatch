// scripts/cms-pbp/download.ts
//
// Streams the PBP ZIP from cms.gov to a temp file while computing the
// SHA-256 in flight. Same shape as scripts/cms-spuf/download.ts but
// for a much smaller artifact (~22 MB vs 2.5 GB) — log cadence is
// quieter.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadResult {
  filePath: string;
  sha256: string;
  bytes: number;
}

function fmtBytes(n: number): string {
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

export async function downloadZip(url: string, fileName: string): Promise<DownloadResult> {
  const filePath = join(tmpdir(), `cms-pbp-${Date.now()}-${fileName}`);
  console.log(`[download] ${url}`);
  console.log(`[download] → ${filePath}`);

  const res = await fetch(url, {
    headers: { 'user-agent': 'planmatch-pbp-importer/1.0' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;

  const hash = createHash('sha256');
  let bytesSeen = 0;

  const nodeStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);

  await pipeline(
    nodeStream,
    async function* (source) {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        hash.update(buf);
        bytesSeen += buf.length;
        yield buf;
      }
    },
    createWriteStream(filePath),
  );

  const stat = statSync(filePath);
  const sha256 = hash.digest('hex');
  const pct = total ? ` (${((bytesSeen / total) * 100).toFixed(0)}% of advertised size)` : '';
  console.log(`[download] complete: ${fmtBytes(stat.size)}${pct}, sha256=${sha256.slice(0, 16)}…`);
  return { filePath, sha256, bytes: stat.size };
}

export async function shaLocal(filePath: string): Promise<DownloadResult> {
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(createReadStream(filePath), async function* (source) {
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      hash.update(buf);
      bytes += buf.length;
      yield buf;
    }
  }, async function* (source) {
    for await (const _ of source) void _;
  });
  return { filePath, sha256: hash.digest('hex'), bytes };
}
