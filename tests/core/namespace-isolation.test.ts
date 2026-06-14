/**
 * Issue #2 — NAMESPACE BLEED (the highest-stakes leak, Brief §4.3 cross-client isolation). Namespace is
 * resolved before retrieval and filtered in SQL — a query scoped to client:acme must NEVER return a
 * client:northwind row, not even when that row is the nearest vector.
 *
 * This also pins the content_hash decision: there is NO global unique on content_hash. The SAME text (same
 * hash) belonging to two different clients must coexist — a global unique would let one client's memory
 * silently evict another's. Dedup is the write path's job (#17), scoped to the namespace, not a DDL constraint.
 */
import { describe, it, expect } from 'vitest';
import { buildRetrievalPredicate, retrievalWhereSql } from '../../packages/core/src/rbac/permissions.ts';
import { freshDb, synthVector, vec, type Query } from './helpers/pglite.ts';
import {
  EMBEDDING_MODEL,
  EMBEDDING_VERSION,
} from '../../packages/core/src/harness/gateway.ts';

const ACME = 'client:acme';
const NORTHWIND = 'client:northwind';

/** Insert the SAME content (text, hash, embedding) under a given namespace, into both tables. */
async function insertShared(query: Query, namespace: string): Promise<void> {
  const embedding = vec(synthVector('shared-text')); // identical vector ⇒ both are distance 0 from the query
  for (const table of ['memories', 'chunks'] as const) {
    const textCol = table === 'memories' ? 'statement' : 'text';
    await query(
      `INSERT INTO ${table} (namespace, zone, sensitivity_level, ${textCol}, content_hash, embedding_model, embedding_version, embedding)
       VALUES ($1,'general',1,'reporting cadence preference','sha256:shared',$2,$3,$4::vector)`,
      [namespace, EMBEDDING_MODEL, EMBEDDING_VERSION, embedding],
    );
  }
}

async function namespacesReturned(query: Query, table: 'memories' | 'chunks', scope: string): Promise<string[]> {
  // Fully-cleared on zone/sensitivity, so ONLY the namespace filter can do the hiding.
  const pred = buildRetrievalPredicate({ allowedZones: ['general'], maxSensitivity: 5 }, [scope]);
  const { sql, params } = retrievalWhereSql(pred, 2);
  const q = vec(synthVector('shared-text'));
  const res = await query(
    `SELECT namespace FROM ${table} WHERE ${sql} ORDER BY embedding <=> $1::vector LIMIT 10`,
    [q, ...params],
  );
  return res.rows.map((r) => r.namespace);
}

describe('namespace isolation — no cross-client bleed (#2, §4.3)', () => {
  it('the same text in two clients coexists (NO global unique on content_hash)', async () => {
    const { query } = await freshDb();
    await insertShared(query, ACME);
    await insertShared(query, NORTHWIND); // same content_hash 'sha256:shared' — must NOT collide/evict

    const m = await query(`SELECT count(*)::int AS n FROM memories WHERE content_hash = 'sha256:shared'`);
    const c = await query(`SELECT count(*)::int AS n FROM chunks   WHERE content_hash = 'sha256:shared'`);
    expect(m.rows[0].n).toBe(2); // both clients kept their memory
    expect(c.rows[0].n).toBe(2);
  });

  it('an Acme-scoped query never returns Northwind rows — even though they are the equally-nearest vector', async () => {
    const { query } = await freshDb();
    await insertShared(query, ACME);
    await insertShared(query, NORTHWIND);

    for (const table of ['memories', 'chunks'] as const) {
      const ns = await namespacesReturned(query, table, ACME);
      expect(ns).toEqual([ACME]); // exactly Acme, despite Northwind being distance 0 too
      expect(ns).not.toContain(NORTHWIND);
    }
  });

  it('the filter is symmetric — Northwind scope sees only Northwind', async () => {
    const { query } = await freshDb();
    await insertShared(query, ACME);
    await insertShared(query, NORTHWIND);

    for (const table of ['memories', 'chunks'] as const) {
      const ns = await namespacesReturned(query, table, NORTHWIND);
      expect(ns).toEqual([NORTHWIND]);
      expect(ns).not.toContain(ACME);
    }
  });
});
