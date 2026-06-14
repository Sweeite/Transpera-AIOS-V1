/**
 * Workflow runner — executes JSON workflow definitions from the tenant DB (Brief §7.4, PRD §4.5).
 * Workflows are DATA, not code. The DSL orchestrates; agents compute — it never becomes Turing-complete.
 */
import type { Principal, TriggerKind } from '@aios/shared';

/** Bounded DSL: sequential steps, conditions, parallel fan-out, human-approval step, retry policy — nothing more (§7.4). */
export interface WorkflowStep {
  agent: string;
  input: string; // template, e.g. "{{contact.name}}"
  condition?: string; // e.g. "score > 7"
  parallel?: WorkflowStep[];
  humanApproval?: boolean;
  retry?: { max: number; backoffMs: number };
}

export interface WorkflowDef {
  workflowId: string;
  trigger: TriggerKind | string;
  steps: WorkflowStep[];
}

/**
 * Variable resolution + condition evaluation are a BOUNDED sub-language, specified so it can't creep into
 * Turing-completeness (#34):
 *   - scope: `trigger.*` (the trigger payload) and `<stepId>.output` (prior step results) ONLY.
 *   - `{{ ... }}` is variable substitution, not code.
 *   - `condition` is a WHITELISTED grammar: comparisons (`>`, `<`, `==`, `!=`, `>=`, `<=`) on a variable vs a
 *     literal. No function calls, no arithmetic, no `eval`. A safe parser, never `new Function`.
 */
export function resolveTemplate(_tmpl: string, _scope: Record<string, unknown>): string {
  throw new Error('TODO: resolveTemplate'); // {{trigger.contact.name}} / {{researcher.output}}
}
export function evalCondition(_expr: string, _scope: Record<string, unknown>): boolean {
  throw new Error('TODO: evalCondition'); // whitelisted comparisons only — no eval
}

export async function runWorkflow(_def: WorkflowDef, _principal: Principal): Promise<unknown> {
  // TODO: interpret steps; resolveTemplate inputs; evalCondition guards; real logic happens INSIDE an agent step.
  throw new Error('TODO: runWorkflow');
}
