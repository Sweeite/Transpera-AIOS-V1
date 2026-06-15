/**
 * Issue #11 — the audit log's TAMPER-EVIDENCE. The hash chain must (a) verify a clean chain — including the
 * config-audit rows #8 already writes (FLOATS like 0.608 in metadata, the cry-wolf trap), (b) detect any
 * rewrite at the exact `seq` it happened, and (c) reuse the EXACT canonicaliser (`canonicalizeAuditEntry`) the
 * writer used — never a re-implementation that could silently diverge.
 *
 * Every detection case here is a permanent regression test (each maps to a PROBE: "tamper a row undetected",
 * "fork/delete a row undetected"). The CONCURRENCY race itself needs true parallelism → real-PG lane
 * (audit-concurrency.real.test.ts); here we prove the LOCKED code path executes (pglite is real Postgres).
 */
import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/pglite.ts';
import { pgliteTx } from './helpers/pglite.ts';
import { appendAudit, verifyChain, canonicalizeAuditEntry } from '../../packages/core/src/audit/audit-log.ts';
import { proposeConfigChange } from '../../packages/core/src/config/system-config.ts';

describe('audit chain — verifyChain (#11)', () => {
  it('verifies a clean hand-built chain', async () => {
    const { query } = await freshDb();
    await appendAudit(query, { actor: 'u1', action: 'a.one', targetRef: 'ref:1', metadata: { x: 1 } });
    await appendAudit(query, { actor: null, action: 'a.two', metadata: { y: 'z' } });
    await appendAudit(query, { actor: 'u2', action: 'a.three', targetRef: 'ref:3', metadata: {} });

    const v = await verifyChain(query);
    expect(v.ok).toBe(true);
    expect(v.checkedRows).toBe(3);
    expect(v.brokenAtSeq).toBeUndefined();
  });

  it("verifies #8's existing config-audit rows clean — incl. a FLOAT in metadata (the jsonb roundtrip trap)", async () => {
    const { query } = await freshDb();
    // qualityAffecting:true float key → a 'config.proposed' row with metadata {old: 0.608, new: 0.7} (floats).
    await proposeConfigChange('retrieval_min_relevance', 0.7, 'tighten floor', { query });
    // a non-qualityAffecting change → an instant 'config.applied' row.
    await proposeConfigChange('latency_budget_ms', 9000, 'more headroom', { query });

    const actions = (await query(`SELECT action FROM audit_log ORDER BY seq`)).rows.map((r) => r.action);
    expect(actions).toContain('config.proposed');
    expect(actions).toContain('config.applied');

    const v = await verifyChain(query);
    expect(v.ok).toBe(true); // a clean chain with float metadata must NOT cry tamper
  });

  it('detects a tampered metadata column at that seq (hash_input untouched → projection check)', async () => {
    const { query } = await freshDb();
    await appendAudit(query, { actor: 'u1', action: 'a.one', metadata: { v: 1 } });
    await appendAudit(query, { actor: 'u2', action: 'a.two', metadata: { v: 2 } });
    await appendAudit(query, { actor: 'u3', action: 'a.three', metadata: { v: 3 } });

    // Rewrite row 2's metadata WITHOUT touching hash_input — the silent edit verifyChain must catch.
    await query(`UPDATE audit_log SET metadata = '{"v":999}'::jsonb WHERE seq = 2`);
    const v = await verifyChain(query);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(2);
  });

  it('detects a rewritten hash / hash_input', async () => {
    const { query } = await freshDb();
    await appendAudit(query, { actor: 'u1', action: 'a.one', metadata: { v: 1 } });
    await appendAudit(query, { actor: 'u2', action: 'a.two', metadata: { v: 2 } });

    await query(`UPDATE audit_log SET hash_input = '{"actor":"evil","action":"x","metadata":{},"targetRef":null}' WHERE seq = 2`);
    const v = await verifyChain(query);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(2);
  });

  it('detects a deleted row via broken linkage (fork/deletion probe)', async () => {
    const { query } = await freshDb();
    await appendAudit(query, { actor: 'u1', action: 'a.one', metadata: {} });
    await appendAudit(query, { actor: 'u2', action: 'a.two', metadata: {} });
    await appendAudit(query, { actor: 'u3', action: 'a.three', metadata: {} });

    await query(`DELETE FROM audit_log WHERE seq = 2`);
    const v = await verifyChain(query);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(3); // row 3's prev_hash no longer matches row 1's hash
  });

  it('the verifier hashes the SAME canonical bytes the writer stored (no divergent re-impl)', async () => {
    const { query } = await freshDb();
    const entry = { actor: 'u1', action: 'a.one', targetRef: 'r', metadata: { b: 2, a: 1 } };
    await appendAudit(query, entry);
    const stored = (await query(`SELECT hash_input FROM audit_log WHERE seq = 1`)).rows[0].hash_input;
    expect(stored).toBe(canonicalizeAuditEntry(entry)); // identical canonicalisation, key-sorted
  });

  it('verifyChain(sinceSeq) verifies incrementally from a checkpoint', async () => {
    const { query } = await freshDb();
    for (let i = 0; i < 5; i++) await appendAudit(query, { actor: `u${i}`, action: 'a', metadata: { i } });
    const v = await verifyChain(query, { sinceSeq: 3 });
    expect(v.ok).toBe(true);
    expect(v.checkedRows).toBe(3); // seq 3,4,5 — anchored on seq 2's hash
  });

  it('runs the LOCKED append path (advisory xact lock) and still verifies clean', async () => {
    const { db, query } = await freshDb();
    const transaction = pgliteTx(db);
    await appendAudit(query, { actor: 'u1', action: 'a.one', metadata: {} }, { transaction });
    await appendAudit(query, { actor: 'u2', action: 'a.two', metadata: {} }, { transaction });
    const v = await verifyChain(query);
    expect(v.ok).toBe(true);
    expect(v.checkedRows).toBe(2);
  });
});
