/**
 * Issue #12 — invalidate-don't-overwrite + history (Brief §4.4). The fail-closed keystone:
 *   - `invalidate()` flips status→invalidated + valid_to=now() + a reason, NEVER mutating history otherwise,
 *     and appends to the #11 audit chain inside the SAME txn (no silent mutation).
 *   - `supersede()` is the reusable primitive (#30 will build on it): invalidate-old + write-new + a typed
 *     `memory_links` kind='supersedes' edge, ATOMICALLY.
 *   - `retrieve()` filters to the live set with a BASE `status='active'` conjunct that ANDs/parenthesises the
 *     #13 predicate — so an invalidated fact never returns, even with predicate='true'.
 *   - `getMemoryHistory()` (inspector) exposes FULL history incl. invalidated, permission-filtered, leak-safe.
 *
 * Hermetic: pglite (the same migration SQL a client's Supabase runs) + a deterministic injected embedder.
 */
import { describe, it, expect } from 'vitest';
import { freshDb, synthVector, pgliteTx, type Query } from './helpers/pglite.ts';
import {
  writeMemory,
  invalidate,
  supersede,
  getMemoryHistory,
  type WriteMemoryInput,
} from '../../packages/core/src/memory/store.ts';
import { retrieve } from '../../packages/core/src/harness/retrieval.ts';

const embed = async (texts: string[]) => texts.map((t) => synthVector(t));

const baseInput = (over: Partial<WriteMemoryInput> = {}): WriteMemoryInput => ({
  type: 'semantic',
  namespace: 'org',
  zone: 'general',
  sensitivityLevel: 1,
  statement: 'the offsite is in Lisbon in March',
  provenance: { sourceRefs: ['ref:1'], capturedAt: '2026-06-14T00:00:00Z', trustLevel: 'high' },
  ...over,
});

async function activeCount(query: Query, namespace = 'org'): Promise<number> {
  const r = await query(`SELECT count(*)::int AS n FROM memories WHERE namespace=$1 AND status='active'`, [namespace]);
  return r.rows[0].n;
}
async function statusOf(query: Query, id: string): Promise<{ status: string; valid_to: string | null; reason: string | null }> {
  const r = await query(`SELECT status, valid_to, invalidated_reason AS reason FROM memories WHERE id=$1`, [id]);
  return r.rows[0];
}
async function auditActions(query: Query): Promise<string[]> {
  const r = await query(`SELECT action FROM audit_log ORDER BY seq ASC`);
  return r.rows.map((x: any) => x.action);
}

describe('invalidate() primitive (#12)', () => {
  it('flips status→invalidated + sets valid_to + persists the reason note; history row otherwise untouched', async () => {
    const { db, query } = await freshDb();
    const w = await writeMemory(query, baseInput(), { embed });

    await invalidate(query, w.memory.id, { code: 'manual', note: 'fact changed' }, { transaction: pgliteTx(db) });

    const after = await statusOf(query, w.memory.id);
    expect(after.status).toBe('invalidated');
    expect(after.valid_to).not.toBeNull();
    expect(after.reason).toBe('fact changed');
    // statement/zone/sensitivity are NEVER mutated by invalidation (history is preserved verbatim).
    const row = (await query(`SELECT statement, zone, sensitivity_level FROM memories WHERE id=$1`, [w.memory.id])).rows[0];
    expect(row.statement).toBe(baseInput().statement);
    expect(row.zone).toBe('general');
    expect(row.sensitivity_level).toBe(1);
  });

  it('appends a refs-only memory.invalidated event to the audit chain — the WHEN/WHY is durable, never swallowed', async () => {
    const { db, query } = await freshDb();
    const w = await writeMemory(query, baseInput(), { embed });
    await invalidate(query, w.memory.id, { code: 'feedback_wrong', note: 'user said this is wrong' }, { transaction: pgliteTx(db) });

    const row = (await query(`SELECT action, target_ref, metadata FROM audit_log WHERE action='memory.invalidated'`)).rows[0];
    expect(row).toBeTruthy();
    expect(row.target_ref).toBe(`memory:${w.memory.id}`);
    // refs/scalars ONLY — the free-text note lives in the (permission-tagged) memories column, NOT the audit log.
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    expect(meta.code).toBe('feedback_wrong');
    expect(JSON.stringify(meta)).not.toContain('user said this is wrong');
  });

  it('refuses to double-invalidate (no silent no-op) — a missing/already-invalidated row throws', async () => {
    const { db, query } = await freshDb();
    const w = await writeMemory(query, baseInput(), { embed });
    await invalidate(query, w.memory.id, { code: 'manual' }, { transaction: pgliteTx(db) });
    await expect(
      invalidate(query, w.memory.id, { code: 'manual' }, { transaction: pgliteTx(db) }),
    ).rejects.toThrow(/not found or already invalidated/i);
    await expect(
      invalidate(query, '00000000-0000-0000-0000-000000000000', { code: 'manual' }, { transaction: pgliteTx(db) }),
    ).rejects.toThrow(/not found or already invalidated/i);
  });
});

describe('supersede() primitive (#12 — reused by #30)', () => {
  it('atomically invalidates the old row, writes the new active row, and links new→old kind=supersedes', async () => {
    const { db, query } = await freshDb();
    const old = await writeMemory(query, baseInput({ statement: 'price is $100' }), { embed });

    const fresh = await supersede(
      query,
      old.memory.id,
      baseInput({ statement: 'price is $120' }),
      { code: 'manual', note: 'repriced' },
      { transaction: pgliteTx(db), embed },
    );

    expect(fresh.id).not.toBe(old.memory.id);
    expect((await statusOf(query, old.memory.id)).status).toBe('invalidated');
    expect((await statusOf(query, fresh.id)).status).toBe('active');
    expect(await activeCount(query)).toBe(1);

    const edge = (
      await query(`SELECT from_id, to_id, kind FROM memory_links WHERE kind='supersedes'`)
    ).rows[0];
    expect(edge.from_id).toBe(fresh.id); // NEW supersedes OLD: from=successor, to=invalidated
    expect(edge.to_id).toBe(old.memory.id);

    expect(await auditActions(query)).toContain('memory.superseded');
  });

  it('is ATOMIC: a failure after invalidate rolls the whole pair back — exactly one active row, the original', async () => {
    const { db, query } = await freshDb();
    const old = await writeMemory(query, baseInput({ statement: 'atomic fact' }), { embed });

    // A txn runner that detonates on the memory_links insert — i.e. AFTER invalidate-old and insert-new.
    const failingTx = <T,>(fn: (q: Query) => Promise<T>): Promise<T> =>
      db.transaction(async (tx) => {
        const q: Query = (sql, params) => {
          if (/INSERT INTO memory_links/i.test(sql)) throw new Error('boom: link insert failed');
          return tx.query(sql, params as any[]) as Promise<{ rows: any[] }>;
        };
        return fn(q);
      });

    await expect(
      supersede(query, old.memory.id, baseInput({ statement: 'atomic fact v2' }), { code: 'manual' }, {
        transaction: failingTx,
        embed,
      }),
    ).rejects.toThrow(/boom/);

    // Rolled back: the original is STILL active, no successor exists, no zero-active data loss / double-active leak.
    expect((await statusOf(query, old.memory.id)).status).toBe('active');
    expect(await activeCount(query)).toBe(1);
    expect((await query(`SELECT count(*)::int AS n FROM memories WHERE namespace='org'`)).rows[0].n).toBe(1);
  });

  it('refuses to supersede a non-active row (fail-loud, never a half-applied supersession)', async () => {
    const { db, query } = await freshDb();
    const old = await writeMemory(query, baseInput({ statement: 'one-shot' }), { embed });
    await invalidate(query, old.memory.id, { code: 'manual' }, { transaction: pgliteTx(db) });
    await expect(
      supersede(query, old.memory.id, baseInput({ statement: 'one-shot v2' }), { code: 'manual' }, {
        transaction: pgliteTx(db),
        embed,
      }),
    ).rejects.toThrow(/not found or already invalidated/i);
  });
});

describe('retrieve() filters to the live set — status=active is a BASE conjunct, independent of the #13 predicate', () => {
  it('an invalidated fact NEVER returns, even with predicate=true (proves the conjunct is not the swappable seam)', async () => {
    const { db, query } = await freshDb();
    const w = await writeMemory(query, baseInput({ statement: 'we use vendor Acme' }), { embed });

    // Sanity: it's retrievable while active (exact-match query → cosine 1.0, clears any floor).
    const before = await retrieve('we use vendor Acme', { query, embed, predicate: 'true', floor: 0.5 });
    expect(before.memories.map((m) => m.id)).toContain(w.memory.id);

    await invalidate(query, w.memory.id, { code: 'manual' }, { transaction: pgliteTx(db) });

    const after = await retrieve('we use vendor Acme', { query, embed, predicate: 'true', floor: 0.5 });
    expect(after.memories.map((m) => m.id)).not.toContain(w.memory.id);
    expect(after.abstained).toBe(true); // nothing else active → honest abstention, not a below-floor reach
  });
});

describe('getMemoryHistory() inspector (#12)', () => {
  it('exposes the FULL chain incl. the invalidated row, with its supersession edges and reason', async () => {
    const { db, query } = await freshDb();
    const v1 = await writeMemory(query, baseInput({ statement: 'capital is 1' }), { embed });
    const v2 = await supersede(query, v1.memory.id, baseInput({ statement: 'capital is 2' }), { code: 'manual', note: 'grew' }, {
      transaction: pgliteTx(db),
      embed,
    });

    const history = await getMemoryHistory(query, v2.id, { predicate: 'true' });
    const ids = history.map((h) => h.id);
    expect(ids).toContain(v1.memory.id); // the invalidated ancestor is visible in the inspector
    expect(ids).toContain(v2.id);

    const oldRow = history.find((h) => h.id === v1.memory.id)!;
    expect(oldRow.status).toBe('invalidated');
    expect(oldRow.invalidatedReason).toBe('grew');
    expect(oldRow.supersededById).toBe(v2.id); // walk forward: old is superseded by new

    const newRow = history.find((h) => h.id === v2.id)!;
    expect(newRow.status).toBe('active');
    expect(newRow.supersedesId).toBe(v1.memory.id); // walk back: new supersedes old
  });

  it('walks a MULTI-HOP chain (v1→v2→v3) from any seed — the recursion is not capped at one edge', async () => {
    const { db, query } = await freshDb();
    const v1 = await writeMemory(query, baseInput({ statement: 'rev v1' }), { embed });
    const v2 = await supersede(query, v1.memory.id, baseInput({ statement: 'rev v2' }), { code: 'manual' }, { transaction: pgliteTx(db), embed });
    const v3 = await supersede(query, v2.id, baseInput({ statement: 'rev v3' }), { code: 'manual' }, { transaction: pgliteTx(db), embed });

    // Seed from the OLDEST invalidated row — the walk must still reach the newest, three hops away.
    const history = await getMemoryHistory(query, v1.memory.id, { predicate: 'true' });
    expect(history.map((h) => h.id).sort()).toEqual([v1.memory.id, v2.id, v3.id].sort());
    expect(history.filter((h) => h.status === 'active').map((h) => h.id)).toEqual([v3.id]);
    // edges chain end-to-end
    expect(history.find((h) => h.id === v2.id)!.supersedesId).toBe(v1.memory.id);
    expect(history.find((h) => h.id === v3.id)!.supersedesId).toBe(v2.id);
    expect(history.find((h) => h.id === v1.memory.id)!.supersededById).toBe(v2.id);
  });

  it('LEAK PROBE: the recursive chain is permission-filtered — a hidden ancestor leaks neither content nor its id via an edge', async () => {
    const { db, query } = await freshDb();
    // A finance-zone v1, superseded by a general-zone v2. A general-only reader must see ONLY v2, and must not
    // learn v1 exists — not its content, and not its id surfaced through v2's supersedesId edge.
    const v1 = await writeMemory(query, baseInput({ zone: 'finance', sensitivityLevel: 3, statement: 'SECRET-MARGIN-42' }), { embed });
    const v2 = await supersede(query, v1.memory.id, baseInput({ zone: 'general', sensitivityLevel: 1, statement: 'public note' }), { code: 'manual' }, {
      transaction: pgliteTx(db),
      embed,
    });

    // A general-only predicate (zone must be in the allowed set; finance excluded).
    const history = await getMemoryHistory(query, v2.id, { predicate: `m.zone = ANY($3)`, predicateParams: [['general']] });
    const ids = history.map((h) => h.id);
    expect(ids).toContain(v2.id);
    expect(ids).not.toContain(v1.memory.id); // the finance ancestor is invisible
    expect(JSON.stringify(history)).not.toContain('SECRET-MARGIN-42'); // no content leak
    // and the edge to the hidden row is NOT surfaced (no existence leak via the id either)
    const visible = history.find((h) => h.id === v2.id)!;
    expect(visible.supersedesId).toBeNull();
  });
});
