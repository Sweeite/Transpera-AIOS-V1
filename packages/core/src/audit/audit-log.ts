/**
 * Append-only audit log (Brief §11.10) — references-not-content, PERMANENT (never updated/deleted/pruned —
 * the prune job touches `traces` only), with a `prev_hash` hash-chain for tamper-evidence. #8 introduced the
 * minimal correct chain; #11 OWNS + hardens it: `verifyChain()`, the concurrency guard #8 deferred, the typed
 * read API, and the stored `hash_input`. The opposite store (`traces`) lives in `harness/trace.ts` — content
 * allowed but ephemeral + permission-tagged. NEVER conflate the two.
 *
 * THE CHAIN CONTRACT (what verifyChain reproduces, exactly):
 *   hash_input_i = canonicalize(entry_i)                         (the EXACT bytes hashed — STORED, see below)
 *   hash_i       = sha256( hash_input_i + '\n' + (prev_hash_i ?? '') )
 *   prev_hash_i  = hash_{i-1}   (the `hash` of the row with the next-lower `seq`; NULL for the genesis row)
 *   canonicalize(entry) = stable-key JSON of { actor, action, targetRef, metadata } with actor/targetRef
 *                         defaulting to null and metadata to {} — object keys sorted recursively so the
 *                         string is independent of insertion key order.
 * `seq` and `created_at` are DB-assigned and NOT hashed (they order/timestamp the row; the content above is
 * what's protected). A verifier reads rows in `seq` order and recomputes the chain.
 *
 * ⚠ WHY hash_input IS STORED (0012): the hash is recomputed from this TEXT, never by re-canonicalising a
 *   jsonb-roundtripped row. #8 writes float metadata (0.608, 0.92) as JS numbers; reading them back through
 *   jsonb and re-stringifying can differ (and differ between pglite and Supabase) — which would make
 *   verifyChain cry tamper on a CLEAN chain. Hashing the stored text removes that entirely. A SEPARATE
 *   value-based projection check (parse(hash_input) deep-equals the live columns) still catches a metadata
 *   edit that left hash_input untouched — float-immune because parsed numbers compare by value, not text.
 *
 * ⚠ CONCURRENCY: read-head-then-insert races — two appenders read the same `prev_hash` → a forked chain. The
 *   guard takes a pg ADVISORY XACT LOCK around read-head+insert inside one transaction (so it works under
 *   Supavisor transaction-mode pooling — the explicit txn pins one backend). PROD MUST pass a `transaction`
 *   runner; the unlocked path throws loud unless under the test runner (single-threaded, can't race). The
 *   actual race is proven on the real-PG lane (#51 / SUPABASE_DB_URL) — pglite is single-threaded.
 */
import { createHash } from 'node:crypto';
import { asObject } from '../db/jsonb.js';

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

/** Hash from the EXACT canonical text (`hash_input`) — never re-canonicalised at verify (no float cry-wolf). */
function hashFromInput(hashInput: string, prevHash: string | null): string {
  return createHash('sha256').update(`${hashInput}\n${prevHash ?? ''}`).digest('hex');
}

/** A single-connection transaction runner — runs `fn` against ONE backend so the advisory lock + read-head +
 *  insert are co-located (works under Supavisor txn-mode pooling: an explicit txn pins the backend). */
export type TxFn = <T>(fn: (q: QueryFn) => Promise<T>) => Promise<T>;

export interface AppendAuditOpts {
  /** PROD path: serialise appenders via a pg advisory xact lock inside this transaction. */
  transaction?: TxFn | undefined;
  /** Explicit opt-in to the UNLOCKED read-then-insert path. Allowed ONLY under the test runner (single-threaded)
   *  or with this flag set — prod without a `transaction` throws loud (a forked chain is a silent corruption). */
  unsafeUnlocked?: boolean;
}

// The single fixed advisory-lock key for the (global, single) audit chain — all appenders contend on it.
const AUDIT_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('aios:audit_log')::bigint)`;

/** Vitest/Node test runner detection — the only context where an unlocked append path is tolerated. Exported
 *  so sibling atomic writers (#12 invalidate/supersede) apply the IDENTICAL prod-requires-a-txn policy. */
export function underTestRunner(): boolean {
  return !!process.env.VITEST || process.env.NODE_ENV === 'test';
}

/** Read the chain head's hash (highest seq), compute + insert one row. Caller decides locked vs unlocked `q`. */
async function appendWith(q: QueryFn, entry: AuditEntry): Promise<AuditWriteResult> {
  const head = await q(`SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1`);
  const prevHash: string | null = head.rows.length > 0 ? (head.rows[0].hash as string) : null;
  const hashInput = canonicalizeAuditEntry(entry);
  const hash = hashFromInput(hashInput, prevHash);

  const inserted = await q(
    `INSERT INTO audit_log (actor, action, target_ref, metadata, prev_hash, hash, hash_input)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING id, seq, hash, prev_hash`,
    [entry.actor ?? null, entry.action, entry.targetRef ?? null, JSON.stringify(entry.metadata ?? {}), prevHash, hash, hashInput],
  );
  const row = inserted.rows[0];
  return { id: String(row.id), seq: Number(row.seq), hash: String(row.hash), prevHash: row.prev_hash ?? null };
}

/**
 * Append one tamper-evident row to `audit_log` and return its identity. A swallowed failure here is a
 * silent-failure red-line violation, so any DB error propagates to the caller (it sits inside the same logical
 * change — see #8's services). Concurrency: with `opts.transaction`, takes the advisory lock so concurrent
 * appenders can't fork the chain; without it the unlocked path runs ONLY under the test runner (or explicit
 * `unsafeUnlocked`) — prod must pass a runner.
 */
export async function appendAudit(query: QueryFn, entry: AuditEntry, opts: AppendAuditOpts = {}): Promise<AuditWriteResult> {
  if (opts.transaction) {
    return opts.transaction(async (q) => {
      await q(AUDIT_LOCK_SQL); // serialise read-head+insert — released at commit
      return appendWith(q, entry);
    });
  }
  if (!opts.unsafeUnlocked && !underTestRunner()) {
    throw new Error(
      'appendAudit: no transaction runner — the unlocked read-then-insert path can fork the chain under ' +
        'concurrent appenders. Pass `transaction` in production (advisory-lock guard); the unlocked path is ' +
        'tolerated only under the test runner (single-threaded) or with explicit `unsafeUnlocked`.',
    );
  }
  return appendWith(query, entry);
}

/**
 * Append one audit row WITHIN a transaction the caller already opened — for a writer that must commit a memory
 * mutation and its audit row as ONE atomic unit (#12 invalidate/supersede). Takes the advisory lock ONCE on the
 * SAME connection `q`, then appends. The mutation + this row share the caller's txn, so they commit/roll back
 * together (a mutation can't land without its audit, and vice versa — no silent failure, no forked chain).
 *
 * ⚠ Do NOT call the public `appendAudit({transaction})` from inside another transaction: that opens a nested
 *   BEGIN and re-acquires the lock re-entrantly. This is the in-txn entry point — use it instead.
 */
export async function appendAuditInTx(q: QueryFn, entry: AuditEntry): Promise<AuditWriteResult> {
  await q(AUDIT_LOCK_SQL); // serialise read-head+insert on the caller's backend — released at the caller's commit
  return appendWith(q, entry);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// verifyChain — recompute the chain and detect any tamper. REUSES canonicalizeAuditEntry (never a re-impl).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ChainVerification {
  ok: boolean;
  checkedRows: number;
  /** The `seq` at which the chain first failed (hash mismatch, broken linkage, or a metadata column edit). */
  brokenAtSeq?: number;
  reason?: string;
}

interface ChainRow {
  seq: number;
  actor: string | null;
  action: string;
  target_ref: string | null;
  metadata: unknown;
  prev_hash: string | null;
  hash: string;
  hash_input: string | null;
}

// jsonb driver-divergence normaliser (asObject) now lives in db/jsonb.ts — one source of truth shared with
// system-config.ts (#55). verifyChain reconstructs canonical from the live metadata column, so it must read the
// SAME normalised object shape that was written, regardless of driver.

function entryOf(row: ChainRow): AuditEntry {
  return {
    actor: row.actor,
    action: row.action,
    targetRef: row.target_ref,
    metadata: asObject(row.metadata),
  };
}

/** Structural deep-equality with VALUE comparison on primitives — so 0.608 (write) equals 0.608 (jsonb
 *  roundtrip) regardless of textual formatting. Numeric strings are coerced so a driver that returns a jsonb
 *  number as a string can't trigger a false projection mismatch. */
function deepEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const an = typeof a === 'number' || (typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a)));
  const bn = typeof b === 'number' || (typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b)));
  if (an && bn) return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqualValue(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length || !ak.every((k, i) => k === bk[i])) return false;
    return ak.every((k) => deepEqualValue((a as any)[k], (b as any)[k]));
  }
  return false;
}

/**
 * Verify the audit chain row-by-row in `seq` order. Detects: a rewritten hash/prev_hash/hash_input (hash
 * recomputation fails), a broken or forked linkage (prev_hash ≠ the running prior hash), and a metadata column
 * edited without updating hash_input (the value-based projection check). `sinceSeq` verifies INCREMENTALLY from
 * a known-good checkpoint forward, seeding the running hash from the row immediately before it.
 */
export async function verifyChain(query: QueryFn, opts: { sinceSeq?: number } = {}): Promise<ChainVerification> {
  let expectedPrev: string | null = null;
  if (opts.sinceSeq !== undefined) {
    const anchor = await query(`SELECT hash FROM audit_log WHERE seq < $1 ORDER BY seq DESC LIMIT 1`, [opts.sinceSeq]);
    expectedPrev = anchor.rows.length > 0 ? (anchor.rows[0].hash as string) : null;
  }

  const { rows } = await query(
    `SELECT seq, actor, action, target_ref, metadata, prev_hash, hash, hash_input
       FROM audit_log ${opts.sinceSeq !== undefined ? 'WHERE seq >= $1' : ''} ORDER BY seq ASC`,
    opts.sinceSeq !== undefined ? [opts.sinceSeq] : [],
  );

  let checked = 0;
  for (const r of rows as ChainRow[]) {
    checked += 1;
    // The hashed payload: the stored canonical text when present (bulletproof); else reconstruct from the live
    // columns (rollout-window rows written by a pre-#11 image — the only float-sensitive path).
    const hashInput = r.hash_input ?? canonicalizeAuditEntry(entryOf(r));
    const expectedHash = hashFromInput(hashInput, r.prev_hash);
    if (expectedHash !== r.hash) {
      return { ok: false, checkedRows: checked, brokenAtSeq: r.seq, reason: 'hash mismatch (row content or hash tampered)' };
    }
    if ((r.prev_hash ?? null) !== expectedPrev) {
      return { ok: false, checkedRows: checked, brokenAtSeq: r.seq, reason: 'broken linkage (prev_hash ≠ prior row hash — reorder/fork/deletion)' };
    }
    // Projection integrity: the live columns must still match the bytes that were hashed (catches a metadata
    // edit that left hash_input intact). Value-based, so a float's jsonb formatting can't cry wolf.
    if (r.hash_input != null) {
      let stored: unknown;
      try {
        stored = JSON.parse(r.hash_input);
      } catch {
        return { ok: false, checkedRows: checked, brokenAtSeq: r.seq, reason: 'hash_input is not valid JSON' };
      }
      const live = JSON.parse(canonicalizeAuditEntry(entryOf(r)));
      if (!deepEqualValue(stored, live)) {
        return { ok: false, checkedRows: checked, brokenAtSeq: r.seq, reason: 'projection mismatch (a typed column was edited without updating hash_input)' };
      }
    }
    expectedPrev = r.hash;
  }
  return { ok: true, checkedRows: checked };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Typed read API — refs/scalars only by construction (the audit log never holds content, §11.10).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  seq: number;
  actor: string | null;
  action: string;
  targetRef: string | null;
  metadata: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
  createdAt: string;
}

export interface AuditReadFilter {
  sinceSeq?: number; // only rows with seq > this
  action?: string; // exact action match
  actionPrefix?: string; // e.g. 'permission.' — the highest-value class (see audit/events.ts)
  limit?: number; // bounded; default 1000, hard max 10000 (never an unbounded scan)
}

const AUDIT_READ_MAX = 10_000;

/** Read audit rows in `seq` order, typed + bounded. Filterable by action / action-prefix / sinceSeq. */
export async function readAuditLog(query: QueryFn, filter: AuditReadFilter = {}): Promise<AuditLogEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.sinceSeq !== undefined) {
    params.push(filter.sinceSeq);
    where.push(`seq > $${params.length}`);
  }
  if (filter.action !== undefined) {
    params.push(filter.action);
    where.push(`action = $${params.length}`);
  }
  if (filter.actionPrefix !== undefined) {
    params.push(`${filter.actionPrefix}%`);
    where.push(`action LIKE $${params.length}`);
  }
  const limit = Math.min(filter.limit ?? 1000, AUDIT_READ_MAX);
  params.push(limit);
  const { rows } = await query(
    `SELECT id, seq, actor, action, target_ref, metadata, prev_hash, hash, created_at
       FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY seq ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: String(r.id),
    seq: Number(r.seq),
    actor: r.actor ?? null,
    action: String(r.action),
    targetRef: r.target_ref ?? null,
    metadata: asObject(r.metadata),
    prevHash: r.prev_hash ?? null,
    hash: String(r.hash),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}
