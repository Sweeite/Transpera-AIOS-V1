/**
 * Multi-agent orchestration (Brief §7.3, PRD §6.6).
 * Decompose a goal → delegate to sub-agents (which may sub-delegate). Live delegation tree + log.
 * Sub-agents INHERIT the triggering principal — token scope decided once at the top, never escalates (§7.5).
 */
import type { Principal } from '@aios/shared';

export interface DelegationNode {
  agentId: string;
  parentId?: string;
  status: 'running' | 'paused_awaiting_input' | 'done' | 'failed';
}

export async function orchestrate(_args: {
  principal: Principal;
  goal: string;
  taskId: string;
}): Promise<{ tree: DelegationNode[]; result: unknown }> {
  // TODO: decompose; spawn sub-agents; expose live tree; on a sub-agent clarification_request →
  // try answer from context, else escalate to the Inbox (§7.5) and pause; resume on answer (§7.3).
  throw new Error('TODO: orchestrate');
}
