// scripts/cms-spuf/pg.ts
//
// Direct Postgres client for the SPUF importer. The Supabase JS client
// goes via PostgREST, which doesn't support COPY FROM and caps payloads
// — neither viable for the 50M-row pharmacy_network or 20M-row
// pricing files. We use `pg` against the Supabase Postgres instance
// directly via the connection string the dashboard exposes.
//
// Set DATABASE_URL in .env.local. Get it from the Supabase dashboard:
//   Project Settings → Database → Connection string → URI
// Use the "session" pooler (port 5432), not the transaction pooler —
// COPY FROM and long-running transactions need a real connection, not
// a pooled one.

import './env.js';
import pg from 'pg';
import { requireEnv } from './env.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = requireEnv('DATABASE_URL');
  pool = new Pool({
    connectionString,
    // One connection — the importer runs sequentially per file. Multiple
    // connections wouldn't help for COPY (CMS files are too big to
    // parallelize within a single import), and a single connection
    // makes the swap transaction simpler to reason about.
    max: 2,
    // CMS files take minutes to load. Disable the default 30s idle.
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 30_000,
    // SSL for hosted Supabase — they only accept TLS connections.
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

export async function withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
