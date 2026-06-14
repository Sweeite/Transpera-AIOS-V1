/**
 * Hermetic Postgres+pgvector for tests (Issue #2). pglite bundles pgvector 0.8.0 (same major Supabase
 * ships), so the migration SQL — HNSW DDL, `<=>` cosine, partial indexes — runs in-process with NO Docker
 * and NO external server. The DDL exercised here is the SAME file (`migrations/*.sql`) that runs on a real
 * client's Supabase: the migration is the source of truth, the test just applies it.
 *
 * Synthetic embeddings are generated locally (deterministic, no model call) — sizing them to `EMBEDDING_DIM`
 * from the gateway pin (#1) means a drift between #1's pinned dimension and #2's `vector(N)` DDL fails a test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { EMBEDDING_DIM } from '../../../packages/core/src/harness/gateway.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'migrations');

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export interface TestDb {
  db: PGlite;
  query: Query;
}

/** Apply every `*.sql` migration in lexical order (the same order a runner applies them). */
function migrationFiles(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR} — Issue #2 has not authored the schema yet.`);
  }
  return files;
}

/** A fresh in-memory database with the vector extension loaded and all migrations applied. */
export async function freshDb(): Promise<TestDb> {
  const db = new PGlite({ extensions: { vector } });
  for (const f of migrationFiles()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  const query: Query = (sql, params) => db.query(sql, params as any[] | undefined) as Promise<{ rows: any[] }>;
  return { db, query };
}

/**
 * Deterministic unit-norm pseudo-embedding of dimension `EMBEDDING_DIM`. Same seed → same vector, so
 * nearest-neighbour ordering is reproducible across runs. NOT a real embedding (those go through the pinned
 * gateway model, §4.7) — just enough geometry to prove `<=>` ranks by distance.
 */
export function synthVector(seed: string, dim: number = EMBEDDING_DIM): number[] {
  const out = new Array<number>(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    // hash(seed|i) → a stable float in [-1, 1)
    const h = createHash('sha256').update(`${seed}|${i}`).digest();
    const u = h.readUInt32BE(0) / 0xffffffff; // [0,1]
    const v = u * 2 - 1;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  return out.map((x) => x / norm);
}

/** Postgres `vector` literal: `[a,b,c]`. */
export function vec(v: number[]): string {
  return `[${v.join(',')}]`;
}
