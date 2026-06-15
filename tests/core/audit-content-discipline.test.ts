/**
 * Issue #11 — CONTENT DISCIPLINE (§11.10) + the unlocked-append guard + the permission-change class.
 *   • audit metadata is refs/scalars ONLY — never user content (PROBE: "store content in an audit row").
 *   • the permission-change class (#6) records refs/scalars and verifies clean (call sites land in #47).
 *   • prod appendAudit refuses the unlocked race path outside the test runner (loud, never silent).
 */
import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/pglite.ts';
import { appendAudit, verifyChain, readAuditLog } from '../../packages/core/src/audit/audit-log.ts';
import { auditPermissionChange, PERMISSION_AUDIT_ACTIONS } from '../../packages/core/src/audit/events.ts';

describe('audit content discipline + permission-change class (#11)', () => {
  it('a permission change records refs/scalars only and verifies clean', async () => {
    const { query } = await freshDb();
    await auditPermissionChange(query, {
      actor: 'admin:1',
      targetUserRef: 'user:42',
      action: PERMISSION_AUDIT_ACTIONS.clearanceChanged,
      before: { allowedZones: ['general'], maxSensitivity: 2 },
      after: { allowedZones: ['general', 'finance'], maxSensitivity: 3 },
    });

    const v = await verifyChain(query);
    expect(v.ok).toBe(true);

    const [row] = await readAuditLog(query, { actionPrefix: 'permission.' });
    expect(row.action).toBe('permission.clearance.changed');
    expect(row.targetRef).toBe('user:user:42');
    // metadata is scalars/refs: zone labels, a sensitivity ordinal, a user ref — never content.
    expect(row.metadata).toMatchObject({
      targetUser: 'user:42',
      zonesBefore: ['general'],
      zonesAfter: ['general', 'finance'],
      maxSensitivityBefore: 2,
      maxSensitivityAfter: 3,
    });
    const serialized = JSON.stringify(row.metadata);
    expect(serialized).not.toMatch(/confidential|salary|secret/i); // no content ever
  });

  it('the highest-value class is filterable as a whole via the permission. prefix', async () => {
    const { query } = await freshDb();
    await appendAudit(query, { actor: 'u', action: 'config.applied', metadata: { key: 'x' } });
    await auditPermissionChange(query, { targetUserRef: 'u9', action: PERMISSION_AUDIT_ACTIONS.roleAssigned, role: 'editor' });
    await auditPermissionChange(query, { targetUserRef: 'u9', action: PERMISSION_AUDIT_ACTIONS.clearanceRevoked });

    const perms = await readAuditLog(query, { actionPrefix: 'permission.' });
    expect(perms.map((p) => p.action)).toEqual(['permission.role.assigned', 'permission.clearance.revoked']);
  });

  it('appendAudit refuses the unlocked path outside the test runner (loud, never a silent fork risk)', async () => {
    const { query } = await freshDb();
    const saved = { vitest: process.env.VITEST, node: process.env.NODE_ENV };
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      await expect(appendAudit(query, { actor: 'u', action: 'a', metadata: {} })).rejects.toThrow(/transaction runner/);
    } finally {
      if (saved.vitest !== undefined) process.env.VITEST = saved.vitest;
      if (saved.node !== undefined) process.env.NODE_ENV = saved.node;
      else delete process.env.NODE_ENV;
    }
  });
});
