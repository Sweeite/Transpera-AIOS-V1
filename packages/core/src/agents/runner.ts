/**
 * Single-agent execution (Brief §7.2, PRD §6.6).
 * Each agent: persona/prompt, allowed tool set, assigned skills, RBAC-scoped memory access, trust score.
 */
import type { Principal } from '@aios/shared';

export interface AgentConfig {
  id: string;
  persona: string;
  allowedTools: string[];
  allowedRoles: string[];
  trustScore: number; // rolling success/rejection/error weighted by feedback; below threshold → constrained/quarantined (§7.2)
}

export interface RunInput {
  agent: AgentConfig;
  principal: Principal; // tokens + authz + permission filtering resolve from here (§7.5)
  goal: string;
  taskId: string; // durable task_state — survives restart, supports pause/resume (§4.1)
}

export async function runAgent(_input: RunInput): Promise<unknown> {
  // TODO: assemble context → tool loop → provenance-labelled output; full step trace; honour trust constraints.
  throw new Error('TODO: runAgent');
}
