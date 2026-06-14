/**
 * Append-only audit log (Brief §11.10) — references-not-content, with a `prev_hash` hash-chain for
 * tamper-evidence. THIS MODULE IS A SEAM FOR #11: #8 introduces the minimal correct chain so config changes
 * are audited + rollback-able today; #11 OWNS this file and hardens it (adds `verifyChain()`, concurrency
 * control, and the typed read API). #8 deliberately keeps the surface tiny: one `appendAudit()` writer.
 *
 * THE CHAIN CONTRACT (what #11's verifier must reproduce, exactly):
 *   hash_i = sha256( canonicalize(entry_i) + '\n' + (prev_hash_i ?? '') )
 *   prev_hash_i = hash_{i-1}   (the `hash` of the row with the next-lower `seq`; NULL for the genesis row)
 *   canonicalize(entry) = stable-key JSON of { actor, action, targetRef, metadata } with actor/targetRef
 *                         defaulting to null and metadata to {} — object keys sorted recursively so the
 *                         string is independent of insertion key order.
 * `seq` and `created_at` are DB-assigned and NOT hashed (they order/timestamp the row; the content above is
 * what's protected). A verifier reads rows in `seq` order and recomputes the chain.
 *
 * ⚠ CONCURRENCY (deferred to #11): read-last-row-then-insert is not safe under concurrent appenders — two
 *   racing writers could read the same `prev_hash`. #11 adds the advisory-lock / serializable guard. #8's
 *   callers (config changes) are low-frequency and the tests are serial, so the minimal chain holds for now.
 */
import { createHash } from 'node:crypto';

/** Minimal DB executor — matches both pglite (tests) and the real pooled connection (same shape as RBAC). */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export interface AuditEntry {
  actor?: string | null; // principal ref; null for system events
  action: string; // e.g. 'config.applied' | 'config.proposed' | 'config.rolled_back'
  targetRef?: string | null; // a REFERENCE, never content (§11.10)
  metadata?: Record<string, unknown>; // refs/scalars only (config old→new values are scalars, allowed)
}

export interface AuditWriteResult {
  id: string;
  seq: number;
  hash: string;
  prevHash: string | null;
}

/** Recursively sort object keys so JSON.stringify is deterministic regardless of insertion order. */
function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = stableSort((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** The canonical string hashed for a row — THE chain contract (see module header). Exported so #11 verifies
 *  against the identical function, never a re-implementation that could silently diverge. */
export function canonicalizeAuditEntry(entry: AuditEntry): string {
  return JSON.stringify(
    stableSort({
      actor: entry.actor ?? null,
      action: entry.action,
      targetRef: entry.targetRef ?? null,
      metadata: entry.metadata ?? {},
    }),
  );
}

function hashEntry(entry: AuditEntry, prevHash: string | null): string {
  return createHash('sha256').update(`${canonicalizeAuditEntry(entry)}\n${prevHash ?? ''}`).digest('hex');
}

/**
 * Append one tamper-evident row to `audit_log` and return its identity. Reads the current chain head (highest
 * `seq`) to link `prev_hash`, computes `hash` per the contract, and inserts. The whole point: a swallowed
 * failure here is a silent-failure red-line violation, so any DB error propagates to the caller (which is
 * inside the same logical change — see #8's services).
 */
export async function appendAudit(query: QueryFn, entry: AuditEntry): Promise<AuditWriteResult> {
  const head = await query(`SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1`);
  const prevHash: string | null = head.rows.length > 0 ? (head.rows[0].hash as string) : null;
  const hash = hashEntry(entry, prevHash);

  const inserted = await query(
    `INSERT INTO audit_log (actor, action, target_ref, metadata, prev_hash, hash)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id, seq, hash, prev_hash`,
    [
      entry.actor ?? null,
      entry.action,
      entry.targetRef ?? null,
      JSON.stringify(entry.metadata ?? {}),
      prevHash,
      hash,
    ],
  );
  const row = inserted.rows[0];
  return { id: String(row.id), seq: Number(row.seq), hash: String(row.hash), prevHash: row.prev_hash ?? null };
}
