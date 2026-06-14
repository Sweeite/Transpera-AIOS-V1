/**
 * Issue #7 — ACCEPTANCE: "Booting without TENANT_ID fails fast (fail-closed)."
 *
 * The fail-closed check is the BOOT PATH, not module import. #7 moved TENANT_ID from an import-time top-level
 * throw (a footgun: it fired on ANY core import, even type-only/tooling use) to a lazy requireTenantId() the
 * entrypoints call at boot. These tests prove:
 *   1. importing the engine WITHOUT a tenant does NOT throw (no import-time landmine), and
 *   2. the boot path (startWorker / buildServer / requireTenantId / getDb) DOES fail fast when TENANT_ID is unset.
 */
import { describe, it, expect, afterEach } from 'vitest';

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
});

describe('fail-closed boot without TENANT_ID (#7)', () => {
  it('importing the sealed core with NO tenant set does NOT throw at import time (no landmine)', async () => {
    delete process.env.TENANT_ID;
    // A bare import must be safe — the old top-level throw broke every consumer that merely imported core.
    await expect(import('../../packages/core/src/db/client.ts')).resolves.toBeDefined();
  });

  it('requireTenantId() throws fast when TENANT_ID is unset', async () => {
    const { requireTenantId } = await import('../../packages/core/src/db/client.ts');
    delete process.env.TENANT_ID;
    expect(() => requireTenantId()).toThrow(/TENANT_ID is required/);
  });

  it('requireTenantId() also rejects an empty/whitespace TENANT_ID (not just missing)', async () => {
    const { requireTenantId } = await import('../../packages/core/src/db/client.ts');
    process.env.TENANT_ID = '   ';
    expect(() => requireTenantId()).toThrow(/TENANT_ID is required/);
  });

  it('requireTenantId() returns the id when set', async () => {
    const { requireTenantId } = await import('../../packages/core/src/db/client.ts');
    process.env.TENANT_ID = 'acme';
    expect(requireTenantId()).toBe('acme');
  });

  it('the WORKER boot path (startWorker) fails fast before doing any work when TENANT_ID is unset', async () => {
    const { startWorker } = await import('../../packages/worker/src/index.ts');
    delete process.env.TENANT_ID;
    // Must reject with the tenant error specifically — NOT the downstream "TODO: startWorker" (which would
    // mean it got past the gate). Fail-closed = the gate trips first.
    await expect(startWorker()).rejects.toThrow(/TENANT_ID is required/);
  });

  it('the API boot path (buildServer) fails fast when TENANT_ID is unset', async () => {
    const { buildServer } = await import('../../packages/api/src/server.ts');
    delete process.env.TENANT_ID;
    await expect(buildServer()).rejects.toThrow(/TENANT_ID is required/);
  });

  it('getDb() refuses to open a connection without DATABASE_URL even when a tenant is set (fail-closed)', async () => {
    const { getDb } = await import('../../packages/core/src/db/client.ts');
    process.env.TENANT_ID = 'acme';
    delete process.env.DATABASE_URL;
    expect(() => getDb()).toThrow(/DATABASE_URL is required/);
  });

  it('getWorkerDb() refuses to open a SESSION connection without DATABASE_URL_SESSION', async () => {
    const { getWorkerDb } = await import('../../packages/core/src/db/client.ts');
    process.env.TENANT_ID = 'acme';
    delete process.env.DATABASE_URL_SESSION;
    expect(() => getWorkerDb()).toThrow(/DATABASE_URL_SESSION is required/);
  });
});
