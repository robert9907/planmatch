// scripts/cms-spuf/download.ts
//
// Streams the CMS SPUF/PUF ZIP from data.cms.gov to a temp file while
// computing the SHA-256 in flight. The hash is the idempotency key
// that gates re-imports; the temp file is what yauzl reads from.
//
// We don't load the whole ZIP into memory — they're 600 MB - 1 GB
// compressed and node has hard limits on Buffer length anyway.

import { createHash } from 'node:crypto';
import { createWriteStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadResult {
  filePath: string;
  sha256: string;
  bytes: number;
}

// Format bytes as human-readable for log output.
function fmtBytes(n: number): string {
  if (n < 1_000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} kB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(2)} GB`;
}

export async function downloadZip(url: string, fileName: string): Promise<DownloadResult> {
  const filePath = join(tmpdir(), `cms-spuf-${Date.now()}-${fileName}`);
  console.log(`[download] ${url}`);
  console.log(`[download] → ${filePath}`);

  const res = await fetch(url, {
    headers: { 'user-agent': 'planmatch-spuf-importer/1.0' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;

  const hash = createHash('sha256');
  let bytesSeen = 0;
  let lastLog = Date.now();

  // Wrap the WHATWG ReadableStream as a Node stream and tee through the
  // hash + the file write. Using pipeline gives us proper cleanup if
  // either end errors mid-flight.
  const nodeStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);

  await pipeline(
    nodeStream,
    async function* (source) {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        hash.update(buf);
        bytesSeen += buf.length;
        const now = Date.now();
        if (now - lastLog > 2_000) {
          const pct = total ? ` (${((bytesSeen / total) * 100).toFixed(1)}%)` : '';
          console.log(`[download]   ${fmtBytes(bytesSeen)}${pct}`);
          lastLog = now;
        }
        yield buf;
      }
    },
    createWriteStream(filePath),
  );

  const stat = statSync(filePath);
  const sha256 = hash.digest('hex');
  console.log(`[download] complete: ${fmtBytes(stat.size)}, sha256=${sha256.slice(0, 16)}…`);
  return { filePath, sha256, bytes: stat.size };
}

// SHA a pre-existing local file (used for --zip=<local-path> mode so we
// keep the same idempotency check whether the ZIP came from the network
// or the user's disk).
export async function shaLocal(filePath: string): Promise<DownloadResult> {
  const { createReadStream } = await import('node:fs');
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
    // Sink that drains.
    for await (const _ of source) {
      void _;
    }
  });
  return { filePath, sha256: hash.digest('hex'), bytes };
}
