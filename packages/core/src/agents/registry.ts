/**
 * Agent registry + capability manifest (Brief §7.2, §7.3).
 *
 * Routing quality depends ENTIRELY on these manifests — the orchestrator reads them to pick the right
 * specialist for a sub-goal. A vague `whenToUse` = flaky routing. This is the one agent-layer detail to
 * nail before building orchestration (the honest caveat from the design review, now made explicit).
 */
import type { Principal, Clearance } from '@aios/shared';

export interface AgentManifest {
  id: string;
  name: string;
  /** THE most important routing field: one precise line on WHEN to pick this agent (not what it is). */
  whenToUse: string;
  /** Structured tags for a cheap pre-filter before the LLM planner runs — narrows the candidate set. */
  capabilities: string[]; // e.g. ['research', 'web-search', 'crm-lookup']
  inputs: string; // what it consumes — helps the orchestrator chain agents
  outputs: string; // what it produces
  exampleGoals: string[]; // few-shot anchors: goals this agent is the right pick for
  allowedTools: string[];
  allowedRoles: string[];
  maxSensitivity?: number; // ceiling; still bounded by the run's principal at execution (§9)
}

const registry = new Map<string, AgentManifest>();

export function registerAgent(m: AgentManifest): void {
  registry.set(m.id, m);
}
export function getAgent(id: string): AgentManifest | undefined {
  return registry.get(id);
}
export function listAgents(): AgentManifest[] {
  return [...registry.values()];
}

/**
 * Candidate selection for the orchestrator (Brief §7.3). Two stages, cheap-to-expensive:
 *   1. deterministic pre-filter — capability-tag overlap + RBAC (principal/clearance + allowedRoles)
 *      → narrows the roster to a SMALL candidate set.
 *   2. the orchestrator LLM then plans over the candidates' `whenToUse`/`exampleGoals`.
 * Keeping the candidate set small is what keeps planning cheap AND routing reliable.
 */
export function candidatesFor(
  _goal: string,
  _principal: Principal,
  _clearance: Clearance,
  _neededCaps?: string[],
): AgentManifest[] {
  // TODO: filter by capability overlap + role/clearance/sensitivity; the LLM planner picks + sequences from these.
  throw new Error('TODO: candidatesFor');
}
