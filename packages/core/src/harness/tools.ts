/**
 * Tool-calling orchestration (PRD §6.6).
 * Agent loop: model proposes tool call → execute → feed result back → repeat to a turn cap.
 * Live SoR federation fetches happen here (§4.9). Errors surfaced, not swallowed.
 */
import type { Principal } from '@aios/shared';

export type BlastRadius = 'reversible-internal' | 'external-irreversible'; // §9.2

export interface ToolDef {
  name: string;
  access: 'read' | 'write';
  sor?: string; // which system of record it touches
  blastRadius: BlastRadius;
  // TODO: input schema (zod), executor
}

export interface ToolContext {
  principal: Principal; // tokens + authz resolve from here; inherited by sub-agents (§7.5)
  allowedTools: string[]; // agent's RBAC-scoped tool set
}

/**
 * Authorization = intersection(allowedTools, principal permissions). External-irreversible actions
 * require preview → confirm unless a standing approval exists (§9.2). Per-user tokens unavailable to
 * service principals.
 */
export async function runToolLoop(_ctx: ToolContext, _tools: ToolDef[]): Promise<unknown> {
  // Confirmation gate (blastRadius === 'external-irreversible') reuses the ONE human-in-the-loop primitive:
  // pause to task_state.status='paused_awaiting_confirmation' with a {kind:'confirmation'} payload → Inbox →
  // resume idempotently (version/lease). Skipped only if a matching `standing_approvals` row exists for the
  // principal + actionType (not expired). Same pause/resume path as the clarification interrupt (§7.3).
  // TODO: loop with turn cap + bounded retries; full step trace (§11.4); errors surfaced, not swallowed.
  throw new Error('TODO: runToolLoop');
}
