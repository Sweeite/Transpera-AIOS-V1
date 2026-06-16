/**
 * Issue #8 — system_config service. The config IS the system's correctness, so the two layers must NEVER be
 * conflated (and each `it` that proves it is a permanent regression test):
 *   • WRITE (propose / instant-apply / approve / rollback): out-of-bounds ⇒ REJECT loudly. Never clamp.
 *   • READ  (getConfig): a value that somehow got into the DB out of bounds ⇒ clamp + fire an alarm
 *     (defense-in-depth; a stored OOB value is a bug). The alarm is NEVER silent.
 *
 * Bounds/quality live in KNOWN_KEYS (code); the DB stores only values. `deps.keys` lets a test simulate a
 * code deploy that tightened bounds while a proposal sits pending — it is ALWAYS code, never DB-sourced.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConfigKeySpec } from '../../packages/core/src/config/system-config.ts';
import {
  getConfig,
  proposeConfigChange,
  approveConfigChange,
  rejectConfigChange,
  rollbackConfig,
  defaultFor,
} from '../../packages/core/src/config/system-config.ts';
import { freshDb, type Query } from './helpers/pglite.ts';

/** Seed an applied value straight into system_config (namespace null ⇒ org default). */
async function seedValue(query: Query, key: string, value: number | string, namespace: string | null = null) {
  await query(
    `INSERT INTO system_config (key, namespace, value) VALUES ($1, $2, $3::jsonb)`,
    [key, namespace, JSON.stringify(value)],
  );
}

async function pendingCount(query: Query, key: string): Promise<number> {
  const r = await query(`SELECT count(*)::int AS n FROM config_proposals WHERE key = $1 AND status = 'pending'`, [key]);
  return r.rows[0].n;
}

async function auditActions(query: Query): Promise<string[]> {
  const r = await query(`SELECT action FROM audit_log ORDER BY seq ASC`);
  return r.rows.map((x) => x.action);
}

// A string-valued key + a numeric key with deliberately-tight bounds, for the DI tests. Code-sourced only.
const STR_KEYS: ConfigKeySpec[] = [{ key: 'reranker_model', default: 'cohere-v3', qualityAffecting: false }];

describe('system_config — resolution order: client → org → declared default (#8)', () => {
  it('client override beats org; absent client falls to org; absent org falls to the declared default', async () => {
    const { query } = await freshDb();
    await seedValue(query, 'retrieval_max_results', 30); // org default
    await seedValue(query, 'retrieval_max_results', 50, 'client:acme'); // client override

    expect(await getConfig('retrieval_max_results', 'client:acme', { query })).toBe(50);
    expect(await getConfig('retrieval_max_results', 'org', { query })).toBe(30);
    expect(await getConfig('retrieval_max_results', 'client:other', { query })).toBe(30); // falls to org
    // a key with no row at all ⇒ the declared default, never a silent 0
    expect(await getConfig('chunk_ttl_days', 'client:x', { query })).toBe(defaultFor('chunk_ttl_days'));
  });

  it('namespace undefined resolves the org default (namespace NULL ⇒ org)', async () => {
    const { query } = await freshDb();
    await seedValue(query, 'retrieval_max_results', 42);
    expect(await getConfig('retrieval_max_results', undefined, { query })).toBe(42);
  });
});

describe('system_config — bounds live in KNOWN_KEYS, DB stores only values (#8 audit fix)', () => {
  it('a DB row for an UNDECLARED key still throws — an undeclared key never returns 0', async () => {
    const { query } = await freshDb();
    await seedValue(query, 'made_up_key', 5); // someone hand-inserted a bound the code never declared
    await expect(getConfig('made_up_key', 'org', { query })).rejects.toThrow();
  });

  it('an undeclared key throws even with no row (no silent 0)', async () => {
    const { query } = await freshDb();
    await expect(getConfig('also_not_declared', 'org', { query })).rejects.toThrow();
  });
});

describe('system_config — READ clamps a stored OOB value + alarms, NEVER silently (#8)', () => {
  it('a stored above-max value is clamped to max AND fires onAnomaly', async () => {
    const { query } = await freshDb();
    await seedValue(query, 'retrieval_min_relevance', 1.5); // max is 1 (rerank scale, #14 — was 0.95 on cosine)
    const onAnomaly = vi.fn();
    expect(await getConfig('retrieval_min_relevance', 'org', { query, onAnomaly })).toBe(1);
    expect(onAnomaly).toHaveBeenCalledOnce();
    expect(onAnomaly.mock.calls[0][0]).toMatchObject({ key: 'retrieval_min_relevance', reason: 'out_of_bounds' });
  });

  it('a stored below-min value is clamped to min', async () => {
    const { query } = await freshDb();
    await seedValue(query, 'retrieval_min_relevance', -0.3); // min is 0 (rerank scale, #14 — was 0.5 on cosine)
    expect(await getConfig('retrieval_min_relevance', 'org', { query, onAnomaly: () => {} })).toBe(0);
  });

  it('(no-silent) with onAnomaly OMITTED a clamp still does NOT swallow — it logs loudly', async () => {
    const { query } = await freshDb();
    await seedValue(query, 'retrieval_min_relevance', 1.5);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getConfig('retrieval_min_relevance', 'org', { query })).toBe(1); // still fail-safe
    expect(spy).toHaveBeenCalled(); // surfaced + alertable, never silent
    spy.mockRestore();
  });

  it('a stored wrong-TYPE value falls back to the declared default + fires onAnomaly', async () => {
    const { query } = await freshDb();
    await seedValue(query, 'retrieval_max_results', 'banana'); // numeric key, string row
    const onAnomaly = vi.fn();
    expect(await getConfig('retrieval_max_results', 'org', { query, onAnomaly })).toBe(defaultFor('retrieval_max_results'));
    expect(onAnomaly.mock.calls[0][0]).toMatchObject({ reason: 'type_mismatch' });
  });

  // PROBE regression: a jsonb `null` or boolean is neither a missing row nor a valid value — it must NOT slip
  // through as a silent default; it's a corrupt row, so default-with-alarm (never a thrown read, never silent).
  it.each([['jsonb null', null], ['boolean', true]] as const)(
    'a stored %s for a numeric key falls back to default + alarms (never a silent leak)',
    async (_label, bad) => {
      const { query } = await freshDb();
      await query(`INSERT INTO system_config (key, value) VALUES ('retrieval_max_results', $1::jsonb)`, [
        JSON.stringify(bad),
      ]);
      const onAnomaly = vi.fn();
      expect(await getConfig('retrieval_max_results', 'org', { query, onAnomaly })).toBe(
        defaultFor('retrieval_max_results'),
      );
      expect(onAnomaly.mock.calls[0][0]).toMatchObject({ reason: 'type_mismatch' });
    },
  );
});

describe('system_config — WRITE rejects OOB loudly, never clamps (#8 red line)', () => {
  it('(no-silent) an above-max write is REJECTED and the DB is left untouched', async () => {
    const { query } = await freshDb();
    await expect(proposeConfigChange('retrieval_min_relevance', 1.5, 'fat finger', { query })).rejects.toThrow();
    const rows = await query(`SELECT count(*)::int AS n FROM system_config WHERE key = 'retrieval_min_relevance'`);
    expect(rows.rows[0].n).toBe(0); // never written
    expect(await getConfig('retrieval_min_relevance', 'org', { query })).toBe(defaultFor('retrieval_min_relevance'));
  });

  it('a below-min write is rejected', async () => {
    const { query } = await freshDb();
    await expect(proposeConfigChange('retrieval_min_relevance', -0.3, 'x', { query })).rejects.toThrow();
  });

  it('a NaN / non-finite write is rejected', async () => {
    const { query } = await freshDb();
    await expect(proposeConfigChange('retrieval_min_relevance', Number.NaN, 'x', { query })).rejects.toThrow();
    await expect(proposeConfigChange('retrieval_min_relevance', Infinity, 'x', { query })).rejects.toThrow();
  });

  it('a wrong-type write (string for a numeric key) is rejected', async () => {
    const { query } = await freshDb();
    await expect(proposeConfigChange('retrieval_max_results', 'lots', 'x', { query })).rejects.toThrow();
  });

  it('an undeclared key cannot be written', async () => {
    const { query } = await freshDb();
    await expect(proposeConfigChange('ghost_key', 1, 'x', { query })).rejects.toThrow();
  });
});

describe('system_config — pending quality changes do NOT take effect until approved (#8 seam 1)', () => {
  it('a quality-affecting change queues; getConfig keeps the OLD value until approve', async () => {
    const { query } = await freshDb();
    const res = await proposeConfigChange('retrieval_min_relevance', 0.7, 'eval says so', { query });
    expect(res.status).toBe('pending');
    // pre-approval: still the old (declared default) value
    expect(await getConfig('retrieval_min_relevance', 'org', { query })).toBe(defaultFor('retrieval_min_relevance'));

    if (res.status !== 'pending') throw new Error('unreachable');
    await approveConfigChange(res.proposalId, { query }, { approver: 'admin' });
    expect(await getConfig('retrieval_min_relevance', 'org', { query })).toBe(0.7); // now it applies
  });

  it('a cosmetic (qualityAffecting:false) change applies INSTANTLY', async () => {
    const { query } = await freshDb();
    const res = await proposeConfigChange('chunk_ttl_days', 120, 'ops', { query });
    expect(res.status).toBe('applied');
    expect(await getConfig('chunk_ttl_days', 'org', { query })).toBe(120);
  });
});

describe('system_config — one open proposal per (key, namespace); duplicate→reject; reject clears it (#8 seam 2 + reject)', () => {
  it('a second open proposal on the same (key,namespace) is rejected — never two pending', async () => {
    const { query } = await freshDb();
    await proposeConfigChange('retrieval_min_relevance', 0.7, 'a', { query });
    await expect(proposeConfigChange('retrieval_min_relevance', 0.72, 'b', { query })).rejects.toThrow();
    expect(await pendingCount(query, 'retrieval_min_relevance')).toBe(1);
  });

  it('a proposal on a DIFFERENT namespace is allowed alongside the org one', async () => {
    const { query } = await freshDb();
    await proposeConfigChange('retrieval_min_relevance', 0.7, 'org', { query });
    await proposeConfigChange('retrieval_min_relevance', 0.8, 'acme', { query }, { namespace: 'client:acme' });
    expect(await pendingCount(query, 'retrieval_min_relevance')).toBe(2);
  });

  it('rejectConfigChange clears a pending proposal so a NEW one can be proposed (no deadlock)', async () => {
    const { query } = await freshDb();
    const res = await proposeConfigChange('retrieval_min_relevance', 0.7, 'first', { query });
    if (res.status !== 'pending') throw new Error('expected pending');
    await rejectConfigChange(res.proposalId, { query }, { rejecter: 'admin' });
    expect(await pendingCount(query, 'retrieval_min_relevance')).toBe(0);

    // the escape hatch works: a fresh proposal is now accepted
    const again = await proposeConfigChange('retrieval_min_relevance', 0.72, 'second', { query });
    expect(again.status).toBe('pending');
    expect(await auditActions(query)).toContain('config.rejected'); // the reject is itself audited
  });
});

describe('system_config — bounds are RE-VALIDATED at apply, not just propose (#8 must-fix)', () => {
  it('a proposal valid when made is REJECTED at approve if the code bounds tightened underneath it', async () => {
    const { query } = await freshDb();
    const loose: ConfigKeySpec[] = [{ key: 'retrieval_min_relevance', default: 0.608, min: 0.5, max: 0.95, qualityAffecting: true }];
    const tight: ConfigKeySpec[] = [{ key: 'retrieval_min_relevance', default: 0.608, min: 0.5, max: 0.9, qualityAffecting: true }];

    const res = await proposeConfigChange('retrieval_min_relevance', 0.95, 'ok then', { query, keys: loose });
    if (res.status !== 'pending') throw new Error('expected pending');

    // a deploy tightened max to 0.90; approve must NOT bypass the write-reject guard
    await expect(approveConfigChange(res.proposalId, { query, keys: tight }, { approver: 'admin' })).rejects.toThrow();
    expect(await getConfig('retrieval_min_relevance', 'org', { query, keys: tight })).toBe(0.608); // unchanged
  });
});

describe('system_config — every change audited + reversible FROM the audit log (#8 seam 5)', () => {
  it('a change rolls back from the audit log; the value is restored and the rollback is itself audited', async () => {
    const { query } = await freshDb();
    const res = await proposeConfigChange('chunk_ttl_days', 120, 'ops', { query }); // instant apply, default 90 → 120
    expect(res.status).toBe('applied');
    if (res.status !== 'applied') throw new Error('unreachable');
    expect(await getConfig('chunk_ttl_days', 'org', { query })).toBe(120);

    await rollbackConfig(res.auditId, { query }, { actor: 'admin' });
    expect(await getConfig('chunk_ttl_days', 'org', { query })).toBe(defaultFor('chunk_ttl_days')); // back to 90
    expect(await auditActions(query)).toEqual(['config.applied', 'config.rolled_back']); // both audited
  });

  it('rollback can only restore a previously-APPLIED value — it refuses a never-applied (proposed) entry', async () => {
    const { query } = await freshDb();
    await proposeConfigChange('retrieval_min_relevance', 0.7, 'queued', { query }); // quality ⇒ pending + 'config.proposed' audit
    const proposed = await query(`SELECT id FROM audit_log WHERE action = 'config.proposed' LIMIT 1`);
    const proposedAuditId = String(proposed.rows[0].id);

    await expect(rollbackConfig(proposedAuditId, { query }, { actor: 'admin' })).rejects.toThrow();
    expect(await getConfig('retrieval_min_relevance', 'org', { query })).toBe(defaultFor('retrieval_min_relevance')); // never injected
  });
});

describe('system_config — string-valued keys: type-checked, never numerically clamped (#8 refinement)', () => {
  it('a string key applies and resolves as a string; a numeric write to it is rejected', async () => {
    const { query } = await freshDb();
    const res = await proposeConfigChange('reranker_model', 'bge-reranker-v2', 'pin', { query, keys: STR_KEYS });
    expect(res.status).toBe('applied');
    expect(await getConfig('reranker_model', 'org', { query, keys: STR_KEYS })).toBe('bge-reranker-v2');

    await expect(proposeConfigChange('reranker_model', 42, 'oops', { query, keys: STR_KEYS })).rejects.toThrow();
  });
});
