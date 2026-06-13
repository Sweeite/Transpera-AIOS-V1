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

export async function runWorkflow(_def: WorkflowDef, _principal: Principal): Promise<unknown> {
  // TODO: interpret steps; anything needing real logic happens INSIDE an agent step, not in the DSL.
  throw new Error('TODO: runWorkflow');
}
