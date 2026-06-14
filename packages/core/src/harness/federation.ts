/**
 * Federation-on-read — the flagship "what do we know about Client X" query path
 * (Brief §4.10, PRD §6.12, issue #23). The hardest piece in the system: entity resolution +
 * parallel live fetch + blend, within a latency budget.
 *
 * The five design decisions are ENCODED HERE so they're explicit, not discovered mid-build:
 *   D1 — Entity resolution: deterministic-first (exact/alias), then embedding similarity with a
 *        confidence floor, context-boosted by the query's namespace. Abstain below the floor —
 *        NEVER guess the entity (a wrong entity is a cross-client leak risk).
 *   D2 — Query → fetch-plan: a DETERMINISTIC planner handles common entity-centric queries via a
 *        default field set per entity kind; open-ended queries fall back to the LLM tool-loop (tools.ts).
 *   D3 — Conflict: SoR WINS on conflicting field VALUES; memory is shown as the interpretive layer
 *        BESIDE the live value, never silently overriding it.
 *   D4 — Latency: fetch holding connectors in PARALLEL, each with a deadline; a missed deadline →
 *        "couldn't reach source" + last-known, never a hang. Budgets from `latency_budget_ms`.
 *   D5 — Cache: very short per-principal TTL (seconds), still honestly labelled "live"; SKIPPED for
 *        anything the caller intends to act on (freshness matters more there).
 */
import type { Answer, Clearance, Namespace, Principal } from '@aios/shared';

export interface FederationQuery {
  text: string;
  resolvedNamespaces: Namespace[]; // from query context, before retrieval (§4.3)
  principal: Principal; // tokens + permission filtering resolve from here (§7.5)
  clearance: Clearance;
  forAction?: boolean; // D5: skip cache when the answer will drive an action
}

/**
 * The read-path orchestrator:
 *   1. resolveEntity (memory/identity) — abstain if it won't resolve (D1)
 *   2. plan fetches — deterministic default field set, or LLM tool-loop for open-ended (D2)
 *   3. parallel fetchLive() per holding connector, each under a deadline (D4)
 *   4. retrieve namespace-scoped memory, fail-closed (retrieval.ts)
 *   5. blend: SoR-wins on value conflicts (D3); label each claim live / "I know this" / "couldn't reach"
 */
export async function answerWithFederation(_q: FederationQuery): Promise<Answer> {
  // TODO: implement the 5 steps above. Keep step 3 + step 4 running concurrently — memory retrieval
  // should not wait on slow SoRs; assemble whatever returned within budget and label honestly.
  throw new Error('TODO: answerWithFederation');
}
