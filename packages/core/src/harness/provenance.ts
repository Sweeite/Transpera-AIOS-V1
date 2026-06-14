/**
 * Provenance & abstention layer (PRD §6.5, Brief §6) — THE DEMO (Issue #5).
 *
 * Per-claim grounding by citation (NOT per-span): the model emits a list of claims, each optionally citing a
 * memory id; this layer maps each to an honest provenance label. The design flips the hard problem ("detect
 * inference") into the easy one ("detect grounding"): a claim is "I know this" ONLY if it cites a memory that
 * was ACTUALLY in the retrieved set — everything else is general inference.
 *
 * ⚠ AUDIT FIX (Tier 3) — THE STRUCTURAL CITATION GUARD: any claim whose `sourceId` is NOT in the retrieved set
 *   is a FABRICATED citation. It is relabelled to general-inference, its sourceId/asOf stripped (so no fake
 *   source or date can ever render), and the event is SIGNALLED (never silent). This is the STRUCTURAL check
 *   (is the cited id even real); the SEMANTIC support-check (does the source actually support the claim) is #24.
 *
 * M0 emits ONLY two labels: 'memory' ("I know this") and 'general-inference'. 'live' / 'failed-fetch' need SoR
 * federation (#23) and are OUT OF SCOPE. Abstention is the third path (handled here, sourced from #4).
 */
import type { Answer, Claim, ProvenanceLabel } from '@aios/shared';
import type { RetrieveOutcome, RetrievedMemory } from './retrieval.js';

/**
 * The honest M0 abstention copy. It does NOT promise "here's what the systems of record show" — that is live
 * federation (#23), which we cannot deliver yet. It tells the truth (no durable knowledge) and offers the one
 * thing we CAN do today: capture an answer if a human knows it. A bounded string, not scattered literals.
 */
export const ABSTENTION_COPY =
  "I don't have durable knowledge on this — want me to capture an answer if someone knows?";

/** What the model returns per claim: the text and an OPTIONAL cited memory id. The label is NOT the model's to
 *  set — this layer derives it. (A subset of `Claim` so synthesis can't smuggle in a pre-set label/asOf.) */
export type DraftClaim = Pick<Claim, 'text' | 'sourceId'>;

/** Fired when the structural guard catches a fabricated citation — the non-silent signal (refs only, no
 *  content beyond the claim text the caller already holds). Default: console.warn. The trace/monitor wiring
 *  (emitSpan/auditEvent) replaces the default once it lands; the seam is here so it is never silent. */
export type FabricatedCitationSignal = (info: { claimText: string; citedId: string }) => void;

const defaultFabricatedSignal: FabricatedCitationSignal = ({ citedId }) => {
  // Refs only: the cited id is a memory id (a ref), never content. Loud, alertable, never swallowed (red line).
  console.warn(
    `[labelAnswer] structural citation guard: claim cited '${citedId}' which is NOT in the retrieved set — ` +
      `relabelled to general-inference (never surfaced as "I know this"). See #5; semantic check is #24.`,
  );
};

export interface LabelAnswerArgs {
  draftClaims: DraftClaim[];
  retrieval: RetrieveOutcome;
  /** #24 seam: when set, a semantic support-check runs per cited claim. No-op in M0 (structural guard only). */
  verify?: boolean;
  onFabricatedCitation?: FabricatedCitationSignal;
}

const MEMORY: ProvenanceLabel = 'memory';
const GENERAL_INFERENCE: ProvenanceLabel = 'general-inference';

/**
 * Turn the model's draft claims + the actual retrieval into a provenance-labelled Answer.
 *
 * PURE & synchronous (no network) — the model call already happened upstream (synthesis). This makes the guard
 * trivially testable: the draft claims ARE the (possibly adversarial) model response.
 *
 * Abstention short-circuit: if #4 abstained, return an abstained Answer with NO claims (the surface renders
 * ABSTENTION_COPY). We do NOT invent a business fact and do NOT call the model — #4 already logged the miss.
 */
export function labelAnswer(args: LabelAnswerArgs): Answer {
  const { draftClaims, retrieval } = args;
  const signal = args.onFabricatedCitation ?? defaultFabricatedSignal;

  if (retrieval.abstained) {
    // The product, not an error: below the floor ⇒ abstain. No claims, no model output surfaced (§6).
    return { abstained: true, claims: [] };
  }

  // The set of ids that were ACTUALLY retrieved — the structural guard's source of truth.
  const byId = new Map<string, RetrievedMemory>(retrieval.memories.map((m) => [m.id, m]));

  const claims: Claim[] = draftClaims.map((draft) => {
    if (!draft.sourceId) {
      // Uncited → general inference by exclusion. `!sourceId` covers undefined, '', and null (a model emitting
      // an EMPTY citation is "no citation", NOT a fabricated one) — so it must NOT trip the fabrication signal.
      // (Easy-to-detect grounding: no citation ⇒ not a business fact.)
      return { text: draft.text, label: GENERAL_INFERENCE };
    }

    const source = byId.get(draft.sourceId);
    if (!source) {
      // FABRICATED citation — the cited id was never retrieved. Relabel + STRIP the fake id/date; signal it.
      signal({ claimText: draft.text, citedId: draft.sourceId });
      return { text: draft.text, label: GENERAL_INFERENCE };
    }

    // Grounded: "I know this" + the real source handle + an honest as-of (when the knowledge was captured).
    // capturedAt is the truthful as-of; #7's lifecycle schema swaps in valid_from when it exists.
    return {
      text: draft.text,
      label: MEMORY,
      sourceId: source.id,
      ...(source.provenance?.capturedAt ? { asOf: source.provenance.capturedAt } : {}),
    };
  });

  return { abstained: false, claims };
}

/** Below the relevance floor → abstain and log a miss (the learning signal, §6). Retained for callers/#4. */
export function shouldAbstain(score: number, floor: number): boolean {
  return score < floor;
}

/** What a memory claim renders as when its human source ref can't be resolved — NEVER a raw uuid (a uuid is
 *  not a "source" a user can act on, and leaking the internal id reads as provenance theatre). */
const SOURCE_UNAVAILABLE = 'source unavailable';

/**
 * Human-readable render of a labelled Answer — the answer surface (used by the demo + later the UI).
 * Abstained ⇒ the honest copy. Memory claims resolve their sourceId → the real source ref + as-of (the trust
 * pitch — show the DOCUMENT, never the uuid). If `retrieval` is omitted, or the id no longer resolves to a
 * source ref, we render "source unavailable" rather than expose the raw id. General inference shows no source.
 */
export function renderAnswer(answer: Answer, retrieval?: RetrieveOutcome): string {
  if (answer.abstained) return ABSTENTION_COPY;

  const byId = new Map<string, RetrievedMemory>((retrieval?.memories ?? []).map((m) => [m.id, m]));

  return answer.claims
    .map((c) => {
      if (c.label === MEMORY) {
        const source = c.sourceId ? byId.get(c.sourceId) : undefined;
        // Resolve to a HUMAN ref only; a missing retrieval arg or unresolved id ⇒ "source unavailable", never the uuid.
        const ref = source?.provenance?.sourceRefs?.[0] ?? SOURCE_UNAVAILABLE;
        const asOf = c.asOf ? `, as of ${c.asOf.slice(0, 10)}` : '';
        return `✔ I know this — ${c.text}\n    └─ source: ${ref}${asOf}`;
      }
      return `≈ general inference — ${c.text}`;
    })
    .join('\n');
}
