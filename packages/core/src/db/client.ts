/**
 * Per-tenant DB connection (tech-stack §2). The engine connects to EXACTLY ONE client's Supabase,
 * resolved from env. There is no cross-tenant query path — isolation layer 1 (§8.2).
 *
 * TWO connections (the Supavisor transaction-mode trap, #7):
 *   - API/engine  → DATABASE_URL          (Supavisor TRANSACTION mode — fine for stateless queries; but
 *                                          prepared statements DON'T survive a pooled connection, so we MUST
 *                                          disable them: `prepare: false`).
 *   - worker tier → DATABASE_URL_SESSION  (SESSION/direct — pgmq, LISTEN, and advisory locks DO NOT work
 *                                          under transaction-mode pooling; the queue would deadlock).
 * Crons additionally take a per-tenant advisory lock so overlapping runs never double-write (#30).
 *
 * Boot is FAIL-CLOSED: the engine refuses to start without a TENANT_ID, and each connection refuses to open
 * without its URL. These checks are LAZY (called at boot / first use), never at import time — importing the
 * sealed core must not throw merely because env isn't set (tests, tooling, type-only consumers).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * The one tenant this process serves (§8.2). FAIL-CLOSED: no TENANT_ID ⇒ refuse to boot. Lazy by design —
 * call it from the API/worker boot path, NOT at module load (a top-level throw would break every core import).
 */
export function requireTenantId(): string {
  const id = process.env.TENANT_ID;
  if (!id || id.trim() === '') {
    throw new Error('TENANT_ID is required — the engine refuses to boot without a tenant (fail-closed, §8.2).');
  }
  return id;
}

function requireUrl(envVar: 'DATABASE_URL' | 'DATABASE_URL_SESSION'): string {
  const url = process.env[envVar];
  if (!url || url.trim() === '') {
    throw new Error(`${envVar} is required — refusing to open a tenant connection without it (fail-closed).`);
  }
  return url;
}

// Process-wide singletons: one pool per mode (postgres.js manages the pool internally). Lazily created on
// first use so an import never opens a socket.
let _db: Db | undefined;
let _workerDb: Db | undefined;
// Keep the raw postgres.js handles so the pools can be drained on graceful shutdown (and so tests don't leak
// open sockets that keep a worker alive). drizzle wraps but does not expose the client, so we hold it here.
let _dbClient: ReturnType<typeof postgres> | undefined;
let _workerClient: ReturnType<typeof postgres> | undefined;

/**
 * Pooled, TRANSACTION-mode connection (DATABASE_URL → Supavisor). For the stateless API/engine path.
 * `prepare: false` is MANDATORY under transaction pooling — Supavisor hands each query a different backend,
 * so a prepared statement created on one is gone on the next ("prepared statement does not exist" otherwise).
 */
export function getDb(): Db {
  if (!_db) {
    requireTenantId(); // a connection without a bound tenant is a leak surface — fail-closed
    _dbClient = postgres(requireUrl('DATABASE_URL'), { prepare: false });
    _db = drizzle(_dbClient, { schema });
  }
  return _db;
}

/**
 * SESSION-mode/direct connection (DATABASE_URL_SESSION). For the worker + crons ONLY: pgmq, LISTEN/NOTIFY,
 * and advisory locks need a stable backend across statements, which transaction pooling cannot give.
 */
export function getWorkerDb(): Db {
  if (!_workerDb) {
    requireTenantId();
    _workerClient = postgres(requireUrl('DATABASE_URL_SESSION'));
    _workerDb = drizzle(_workerClient, { schema });
  }
  return _workerDb;
}

/**
 * Drain both connection pools and reset the singletons. For graceful shutdown (SIGTERM) and for tests that
 * open a real connection — without it, postgres.js keeps idle sockets open and the process won't exit cleanly.
 * Safe to call when nothing was ever opened.
 */
export async function closeDb(): Promise<void> {
  await Promise.all([_dbClient?.end({ timeout: 5 }), _workerClient?.end({ timeout: 5 })]);
  _db = undefined;
  _workerDb = undefined;
  _dbClient = undefined;
  _workerClient = undefined;
}
