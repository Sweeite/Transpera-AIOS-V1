/**
 * Semantic audit-event classes over the raw `appendAudit` writer (audit/audit-log.ts). Keeps the chain
 * primitive store-correct and content-free (§11.10) while giving callers a typed, refs-only API per event
 * class — so a call site can't accidentally pass content or an ad-hoc action string.
 *
 * PERMISSION CHANGES are the HIGHEST-VALUE audit class (#11 acceptance): a clearance/role grant or revoke is
 * exactly the event a later investigation must be able to trust. The CLASS + API live here now; the actual
 * CALL SITES are #47 (admin grants) — when #47 lands it calls `auditPermissionChange`, it does not invent its
 * own action strings. Everything recorded is a REFERENCE or a SCALAR (a user ref, a zone label, a sensitivity
 * ordinal, a role name) — never user content.
 */
import { appendAudit, type AppendAuditOpts, type AuditWriteResult, type QueryFn } from './audit-log.js';
import type { SensitivityLevel, Zone } from '@aios/shared';

/** The permission-change action vocabulary — a closed set so the read API can filter the whole class by the
 *  `permission.` prefix (see `readAuditLog({ actionPrefix: 'permission.' })`). */
export const PERMISSION_AUDIT_ACTIONS = {
  clearanceGranted: 'permission.clearance.granted',
  clearanceRevoked: 'permission.clearance.revoked',
  clearanceChanged: 'permission.clearance.changed',
  roleAssigned: 'permission.role.assigned',
  roleRemoved: 'permission.role.removed',
} as const;

export type PermissionAuditAction = (typeof PERMISSION_AUDIT_ACTIONS)[keyof typeof PERMISSION_AUDIT_ACTIONS];

/** A clearance snapshot for the before/after of a change — scalars only (zone labels + a sensitivity ordinal). */
export interface ClearanceSnapshot {
  allowedZones: Zone[];
  maxSensitivity: SensitivityLevel;
}

export interface PermissionChange {
  /** Who made the change (principal ref) — null for a system-driven change. */
  actor?: string | null;
  /** The user whose permissions changed — a REFERENCE (user id), never their content. */
  targetUserRef: string;
  action: PermissionAuditAction;
  /** Optional role name (for role assign/remove) — a scalar label. */
  role?: string;
  /** Optional clearance before/after (for clearance changes) — scalars only. */
  before?: ClearanceSnapshot;
  after?: ClearanceSnapshot;
}

/**
 * Record a permission change on the audit chain. Metadata is refs/scalars ONLY by construction. Pass the same
 * `opts` (the `transaction` runner) the rest of the audit path uses, so the append is serialised under the
 * advisory-lock guard.
 */
export async function auditPermissionChange(
  query: QueryFn,
  change: PermissionChange,
  opts: AppendAuditOpts = {},
): Promise<AuditWriteResult> {
  const metadata: Record<string, unknown> = { targetUser: change.targetUserRef };
  if (change.role !== undefined) metadata.role = change.role;
  if (change.before !== undefined) {
    metadata.zonesBefore = change.before.allowedZones;
    metadata.maxSensitivityBefore = change.before.maxSensitivity;
  }
  if (change.after !== undefined) {
    metadata.zonesAfter = change.after.allowedZones;
    metadata.maxSensitivityAfter = change.after.maxSensitivity;
  }
  return appendAudit(
    query,
    { actor: change.actor ?? null, action: change.action, targetRef: `user:${change.targetUserRef}`, metadata },
    opts,
  );
}
