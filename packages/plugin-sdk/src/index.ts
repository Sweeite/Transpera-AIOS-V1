/**
 * @aios/plugin-sdk — the ONLY core surface a plugin imports (tech-stack §2).
 * Types + helpers for the hook points. A plugin can extend; it can never touch gateway/rbac/db/billing.
 */
export type { HookRegistry, Plugin } from '@aios/core/dist/hooks/registry.js';
export type { AgentConfig } from '@aios/core/dist/agents/runner.js';
export type { WorkflowStep } from '@aios/core/dist/workflows/runner.js';

// Re-export domain types so plugins share one definition (Memory, Provenance, etc.)
export type * from '@aios/shared';

/** Convenience: declare a plugin with the right shape. */
export function definePlugin(tenantId: string, register: (r: import('@aios/core/dist/hooks/registry.js').HookRegistry) => void) {
  return { tenantId, register };
}
