/**
 * Context assembly + token budgeting — builds the prompt for a turn (Issue #15, PRD §6.2).
 *
 * assembleContext() is PURE (no network, no DB): it consumes retrieve()'s ALREADY permission-filtered, RRF-ordered
 * output (#13/#14) plus the agent's persona + tool defs + the asker's authorized recent thread, and packs them
 * into a token budget. What it can't fit, it DROPS by relevance and LOGS (the Watch: the "what was dropped" log
 * is a silent-failure guard, never skipped). Three properties carry the issue:
 *
 *   • TRUNCATE BY RELEVANCE (Decision A/D): `retrieved` arrives most→least relevant (RRF; the #14 floor already
 *     applied). We keep the most-relevant prefix that fits and drop the TAIL — no re-rank, no second reranker
 *     call (#46). Rerank-REORDERING the surfaced set + per-candidate co-resident drop are #61 (split off #15).
 *     We drop WHOLE items, never truncate one — a half-statement would strip the span its per-claim citation
 *     grounds (#5), mis-grounding the claim. Each survivor keeps its id + refs-only provenance intact.
 *
 *   • NEVER LEAKS (Decision C):
 *       — memories/chunks: fail-closed by construction (they came through retrieve()'s predicate) AND re-checked
 *         here against `clearance` as defense-in-depth — any item outside the asker's zone/sensitivity/namespace
 *         is dropped + loudly alerted (should be impossible; enforced anyway so "assembled context never contains
 *         a hidden-from-asker memory" holds AT the assembly boundary).
 *       — recentThread does NOT come through that predicate. Per migration 0008 a thread is authorized as a UNIT
 *         (threads.owner_id + §7.1 sharing) and `messages.principal` is the PER-TURN AUTHOR, which legitimately
 *         differs across turns once a thread is shared. So the access gate is THREAD-LEVEL, resolved by the caller
 *         (#48/the chat surface) into `authorizedThreadId`; assembly keeps only entries whose `threadId` matches
 *         it and drops any foreign-thread turn fail-closed (the cross-thread-contamination guard). The per-turn
 *         `principal` is kept for attribution, NEVER used as the access gate (that would break shared threads).
 *       — persona + tool defs are operator-authored agent config (no principal-scoped content) and form the
 *         stable, prompt-cached prefix.
 *
 *   • STABLE PREFIX (#10): `system` = persona + a deterministic render of the tool defs, byte-stable across turns
 *     with the same persona+tools, so the gateway can mark it `cache_control` and bill it at the cache-read rate.
 *
 * DEFERRED seams (documented, do NOT pre-build):
 *   #61 — rerank-REORDERING the surfaced set + per-candidate below-floor co-resident drop (memories only). #15
 *         consumes the existing RRF order for budget truncation ("by relevance" via RRF, which meets acceptance);
 *         reordering by `diagnostics.rerankerScores` is split off to #61 (no second reranker call, #46).
 *   synthesis WIRING — synthesis.answerQuestion still reads retrieval.memories DIRECTLY; it does NOT call
 *         assembleContext yet. That surface is #5/#10's; adopting assembleContext (system→CallOptions.system for
 *         prompt caching, retrieved→sources, recentThread→messages) is their refinement, recorded on #15.
 */
import type { Clearance, Principal, Provenance } from '@aios/shared';
import type { RetrievedMemory, RetrievedChunk } from './retrieval.js';

/**
 * ESTIMATION-METHOD DIVISOR — chars-per-token for the deterministic heuristic `ceil(chars / N)`. This is a PIN,
 * not a tunable threshold (the EMBEDDING_MODEL/RERANKER_MODEL family): changing it changes the ESTIMATOR itself,
 * not a dial. The tunable dial is the bounded `context_token_budget` key (§4.8). A real BPE tokenizer would couple
 * assembly to a provider (the gateway is the only model seam) for ±~15% more accuracy we don't need for a window
 * GUARD — the gateway's `generation_max_tokens` is the hard OUTPUT cap and gateway `usage` is the real accounting.
 */
export const CONTEXT_CHARS_PER_TOKEN = 4;

/** A tool definition contributing to the stable, cached prefix (rendered deterministically into `system`). */
export interface ToolDef {
  name: string;
  description: string;
}

/**
 * One turn of the asker's conversation, sourced from the threads/messages store (migration 0008) — NOT working
 * memory. `threadId` is the THREAD it belongs to; `principal` is the per-turn AUTHOR (attribution/rendering),
 * which can differ across turns once a thread is shared (§7.1) — it is NEVER the access gate. The access gate is
 * thread-level: the caller resolves the asker's authorized thread (threads.owner_id + sharing) into
 * `authorizedThreadId` and assembly keeps only matching turns. `role` mirrors the 0008 CHECK ('user' | 'brain').
 */
export interface ThreadEntry {
  threadId: string;
  principal: Principal; // the per-turn author — attribution only, NOT an access gate (shared threads, §7.1)
  role: 'user' | 'brain';
  text: string;
}

/** A retrieved item kept in the assembled context — id + provenance preserved so per-claim citation survives (#5). */
export type AssembledItem =
  | { kind: 'memory'; id: string; statement: string; provenance: Provenance }
  | { kind: 'chunk'; id: string; text: string; provenance: Provenance };

/**
 * The what-was-dropped record — counts / ids / token-estimate ONLY, NEVER a memory statement or thread text
 * (§11.10). Always present on the return (testable); also delivered to the `onDropped` sink for trace wiring.
 */
export interface ContextDropLog {
  budget: number;
  tokenEstimate: number;
  keptRetrieved: number;
  droppedRetrieved: number; // dropped to fit the budget (the relevance tail)
  droppedRetrievedIds: string[]; // ids only — never the statement/text
  deniedRetrievedIds: string[]; // defense-in-depth: items outside the asker's clearance (should be empty)
  droppedThreadTurns: number; // budget-dropped thread turns (count only — entries may have no id)
  deniedThreadTurns: number; // fail-closed cross-thread drops (turn not in the authorized thread)
  systemOverBudget: boolean; // persona+tools alone exceed budget — kept whole, misconfig surfaced loudly
  retrievedStarved: boolean; // kept 0 retrieved while dropping some — thread consumed the whole residual
}

export interface AssembledContext {
  system: string; // stable prefix (persona + tool defs) → prompt-cached (#10)
  retrieved: AssembledItem[]; // kept, in relevance order (memories then chunks), refs-only provenance preserved
  recentThread: ThreadEntry[]; // kept + thread-scoped, in chronological (input) order
  droppedForBudget: number; // = droppedRetrieved (retrieved items dropped to fit) — the headline #15 counter
  tokenEstimate: number; // est. tokens of the WHOLE assembled prompt (≤ budget unless system alone overflows)
  dropLog: ContextDropLog;
}

export interface AssembleContextArgs {
  clearance: Clearance; // the asker's clearance — defense-in-depth re-check of retrieved items
  persona: string;
  toolDefs: ToolDef[];
  retrieved: { memories: RetrievedMemory[]; chunks: RetrievedChunk[] }; // retrieve()'s output: RRF-ordered, filtered
  recentThread: ThreadEntry[]; // turns from threads/messages (0008), chronological (oldest→newest)
  /** The RBAC-authorized thread for this asker, resolved by the caller (threads.owner_id + §7.1 sharing — the
   *  thread-level access gate assembly cannot re-derive, like retrieve()'s predicate). Absent/empty ⇒ no thread
   *  authorized ⇒ keep NONE (e.g. a service-triggered run has no user session). */
  authorizedThreadId?: string;
  tokenBudget: number; // resolved by the caller from the bounded `context_token_budget` key
  /** Observability sink for drops/anomalies — caller wires it to a permission-tagged trace (emitSpan), like
   *  retrieve()'s onRetrieval. Fired only when something was dropped or an anomaly tripped. */
  onDropped?: (log: ContextDropLog) => void;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CONTEXT_CHARS_PER_TOKEN);
}

/** Deterministic render of the stable prefix — persona then tool defs in GIVEN order. No timestamps/ids that
 *  vary per turn, so it is byte-stable across turns with the same persona+tools (the prompt-cache precondition). */
function renderSystem(persona: string, toolDefs: ToolDef[]): string {
  if (toolDefs.length === 0) return persona;
  const tools = toolDefs.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return `${persona}\n\nTOOLS:\n${tools}`;
}

function threadLine(t: ThreadEntry): string {
  return `${t.role}: ${t.text}`;
}

/** The LOUD default for leak-class / misconfig anomalies — never silent (no-silent-failure red line). Refs-only:
 *  ids + counts, never content (§11.10). Normal budget drops are EXPECTED, so they go to the sink, NOT here. */
function alertAnomaly(log: ContextDropLog): void {
  const problems: string[] = [];
  if (log.deniedThreadTurns > 0) problems.push(`deniedThreadTurns=${log.deniedThreadTurns} (foreign thread)`);
  if (log.deniedRetrievedIds.length > 0) problems.push(`deniedRetrieved=[${log.deniedRetrievedIds.join(',')}] (outside clearance)`);
  if (log.systemOverBudget) problems.push('systemOverBudget (persona+tools exceed budget; kept whole)');
  if (log.retrievedStarved) problems.push('retrievedStarved (thread consumed the whole residual; 0 retrieved kept)');
  if (problems.length > 0) {
    console.error(`[context] ASSEMBLY ANOMALY — ${problems.join('; ')}. budget=${log.budget} tokenEstimate=${log.tokenEstimate}`);
  }
}

/** Is a retrieved item within the asker's clearance on ALL THREE axes? Defense-in-depth — retrieve() already
 *  filtered, so this is belt-and-suspenders; a `false` here means a regression upstream and is treated as a leak. */
function withinClearance(item: { zone: string; sensitivityLevel: number; namespace: string }, c: Clearance): boolean {
  return (
    c.allowedZones.includes(item.zone as never) &&
    item.sensitivityLevel <= c.maxSensitivity &&
    c.allowedNamespaces.includes(item.namespace as never)
  );
}

/**
 * Build the prompt for a turn under a token budget. Precedence (highest kept-priority first), top-down greedy,
 * tail-truncated within each pool:
 *   1. system (persona + tool defs) — NEVER dropped; if it alone exceeds budget, flag systemOverBudget and keep
 *      it whole (we never ship half a persona).
 *   2. recentThread — kept NEWEST-first (oldest turns dropped first) so coreference survives; bounded by 0008's
 *      recent window. Output is restored to chronological order.
 *   3. retrieved — kept MOST-relevant-first (memories then chunks, RRF order); the tail is dropped → droppedForBudget.
 */
export async function assembleContext(args: AssembleContextArgs): Promise<AssembledContext> {
  const { clearance, persona, toolDefs, retrieved, recentThread, authorizedThreadId, tokenBudget } = args;

  const system = renderSystem(persona, toolDefs);

  // ── 1. system is always kept; note if it alone blows the budget (misconfig, not a drop) ──
  let used = estimateTokens(system);
  const systemOverBudget = used > tokenBudget;

  // ── 2. recentThread — fail-closed THREAD-SCOPE filter FIRST (the leak guard), THEN budget newest-first ──
  // The access gate is thread-level (the caller resolved the asker's authorized thread). A turn from any OTHER
  // thread is cross-thread contamination ⇒ dropped fail-closed, its text never read. No authorized thread (e.g.
  // a service run) ⇒ keep none. The per-turn author principal is NOT the gate (that would break shared threads).
  let deniedThreadTurns = 0;
  const inThread: Array<{ entry: ThreadEntry; index: number }> = [];
  recentThread.forEach((entry, index) => {
    if (authorizedThreadId != null && authorizedThreadId !== '' && entry.threadId === authorizedThreadId) {
      inThread.push({ entry, index });
    } else {
      deniedThreadTurns++; // foreign thread / no authorized thread — dropped fail-closed
    }
  });
  // Newest-first admission (preserve original index to restore chronological output order).
  const keptThreadIdx = new Set<number>();
  let droppedThreadTurns = 0;
  for (let i = inThread.length - 1; i >= 0; i--) {
    const { entry, index } = inThread[i]!;
    const cost = estimateTokens(threadLine(entry));
    if (used + cost <= tokenBudget) {
      used += cost;
      keptThreadIdx.add(index);
    } else {
      droppedThreadTurns++; // this turn + any older one (tail-truncation: stop admitting once one overflows)
    }
  }
  const keptThread = inThread.filter(({ index }) => keptThreadIdx.has(index)).map(({ entry }) => entry); // chronological

  // ── 3. retrieved — defense-in-depth clearance re-check, THEN budget by relevance (memories then chunks) ──
  const deniedRetrievedIds: string[] = [];
  const candidates: AssembledItem[] = [];
  for (const m of retrieved.memories) {
    if (withinClearance(m, clearance)) candidates.push({ kind: 'memory', id: m.id, statement: m.statement, provenance: m.provenance });
    else deniedRetrievedIds.push(m.id); // outside clearance — must never happen; dropped + alerted as leak-class
  }
  for (const c of retrieved.chunks) {
    if (withinClearance(c, clearance)) candidates.push({ kind: 'chunk', id: c.id, text: c.text, provenance: c.provenance });
    else deniedRetrievedIds.push(c.id);
  }

  const kept: AssembledItem[] = [];
  const droppedRetrievedIds: string[] = [];
  let budgetExhausted = false;
  for (const item of candidates) {
    const cost = estimateTokens(item.kind === 'memory' ? `[${item.id}] ${item.statement}` : `[${item.id}] ${item.text}`);
    if (!budgetExhausted && used + cost <= tokenBudget) {
      used += cost;
      kept.push(item);
    } else {
      budgetExhausted = true; // tail-truncation: once one doesn't fit, the rest of the (less-relevant) tail drops
      droppedRetrievedIds.push(item.id);
    }
  }

  // keptRetrieved 0 while we dropped some ⇒ the thread consumed the whole residual; surface, don't ship silently.
  const retrievedStarved = kept.length === 0 && droppedRetrievedIds.length > 0;

  const dropLog: ContextDropLog = {
    budget: tokenBudget,
    tokenEstimate: used,
    keptRetrieved: kept.length,
    droppedRetrieved: droppedRetrievedIds.length,
    droppedRetrievedIds,
    deniedRetrievedIds,
    droppedThreadTurns,
    deniedThreadTurns,
    systemOverBudget,
    retrievedStarved,
  };

  // Surface anomalies loudly (leak-class / misconfig) + hand the full record to the observability sink when
  // anything was dropped at all. The Watch: the drop log is a silent-failure guard — it is never skipped.
  alertAnomaly(dropLog);
  const anyDrop =
    droppedRetrievedIds.length > 0 ||
    droppedThreadTurns > 0 ||
    deniedThreadTurns > 0 ||
    deniedRetrievedIds.length > 0 ||
    systemOverBudget ||
    retrievedStarved;
  if (anyDrop) args.onDropped?.(dropLog);

  return {
    system,
    retrieved: kept,
    recentThread: keptThread,
    droppedForBudget: droppedRetrievedIds.length,
    tokenEstimate: used,
    dropLog,
  };
}
