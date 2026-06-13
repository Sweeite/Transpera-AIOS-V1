/**
 * The plugin boundary (Brief §8.2, PRD §6 / tech-stack §2).
 * Plugins MAY: add agents, add workflow steps, override prompts/personas, register scorers/tools.
 * Plugins MAY NOT: touch auth/session, billing, the core LLM call, RBAC, or the DB access layer.
 * Loaded by TENANT_ID at boot. A plugin is a folder, not a fork.
 */
import type { AgentConfig } from '../agents/runner.js';
import type { WorkflowStep } from '../workflows/runner.js';

export interface HookRegistry {
  registerAgent(agent: AgentConfig): void;
  registerStep(name: string, step: WorkflowStep): void;
  overridePrompt(agentId: string, prompt: string): void;
  registerScorer(name: string, fn: (input: unknown) => number): void;
  registerTool(name: string, def: unknown): void;
}

export interface Plugin {
  tenantId: string;
  register(registry: HookRegistry): void;
}

/** Load + register the plugin for this tenant, if any. Fault-isolated: instance-per-client (§8.2). */
export async function loadPluginForTenant(_tenantId: string, _registry: HookRegistry): Promise<void> {
  // TODO: dynamic import from plugins/<tenantId>; never let one client's plugin affect another's runtime.
  throw new Error('TODO: loadPluginForTenant');
}
