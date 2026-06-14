/**
 * Answer synthesis + end-to-end orchestration (Issue #5, Brief §6, PRD §6.5).
 *
 * synthesizeClaims() turns a query + the retrieved memories into the model's DRAFT claims (each optionally
 * citing a source id), via ONE forced-tool-use call through the gateway chokepoint. answerQuestion() ties the
 * tracer bullet together: retrieve (#4) → abstain-shortcut → synthesize → labelAnswer (#5 structural guard).
 *
 * The prompt frames the EASY problem ("ground each claim in a listed source, else don't cite") — but the
 * model is NOT trusted: labelAnswer's structural guard is the safety net that catches any fabricated id even
 * if the prompt is ignored. Synthesis only ever produces a DRAFT; the label is derived downstream, never here.
 */
import { z } from 'zod';
import type { Answer } from '@aios/shared';
import { callModel as gatewayCallModel, type CallOptions, type CallResult } from './gateway.js';
import { retrieve, type RetrieveDeps, type RetrieveOutcome, type RetrievedMemory } from './retrieval.js';
import { labelAnswer, type DraftClaim, type FabricatedCitationSignal } from './provenance.js';

/** The gateway call, injectable so hermetic tests feed a FAKE model response (no network). Default: gateway. */
export type ModelCaller = <T>(opts: CallOptions<T>) => Promise<CallResult<T>>;

/** The structured shape the model is forced to emit. `sourceId` is the id of a LISTED source, or omitted. */
const DraftClaimsSchema = z.object({
  claims: z.array(
    z.object({
      text: z.string(),
      // nullable + optional: models emit `null` or omit the field for an uncited (general-inference) claim.
      sourceId: z.string().nullable().optional(),
    }),
  ),
});

const SYNTHESIS_SYSTEM =
  'You answer ONLY from the SOURCES provided by the user. Break your answer into a list of short, ' +
  'self-contained claims. For each claim that comes from a source, set sourceId to that source\'s exact id ' +
  '(the value in [brackets]). If a claim generalises beyond the sources or is your own inference, OMIT ' +
  'sourceId (do not guess an id). Never cite an id that is not in the list. Prefer fewer, well-grounded claims.';

/** Render the retrieved memories as an id-tagged source list the model cites against. Statements only — the
 *  permission filtering already happened in retrieve(); nothing unauthorised reaches this prompt. */
function renderSources(memories: RetrievedMemory[]): string {
  return memories.map((m) => `[${m.id}] ${m.statement}`).join('\n');
}

export interface SynthesizeDeps {
  callModel?: ModelCaller;
}

/**
 * One forced-tool-use call → the model's draft claims. NOT labelled here (that is labelAnswer's job, with the
 * structural guard). Returns [] only if the model genuinely produces no claims.
 */
export async function synthesizeClaims(
  query: string,
  memories: RetrievedMemory[],
  deps: SynthesizeDeps = {},
): Promise<DraftClaim[]> {
  const call = deps.callModel ?? gatewayCallModel;

  const { output } = await call({
    taskClass: 'synthesize',
    system: SYNTHESIS_SYSTEM,
    schema: DraftClaimsSchema,
    messages: [
      {
        role: 'user',
        content: `SOURCES:\n${renderSources(memories)}\n\nQUESTION: ${query}`,
      },
    ],
  });

  // Normalise the model's nullable sourceId → the DraftClaim shape (null/empty ⇒ uncited).
  return output.claims.map((c) => ({
    text: c.text,
    ...(c.sourceId ? { sourceId: c.sourceId } : {}),
  }));
}

export interface AnswerDeps extends RetrieveDeps {
  callModel?: ModelCaller;
  onFabricatedCitation?: FabricatedCitationSignal;
}

export interface AnswerOutcome {
  answer: Answer;
  retrieval: RetrieveOutcome; // returned so the surface can resolve sourceId → source ref + as-of (renderAnswer)
}

/**
 * THE TRACER BULLET, end to end. retrieve → (abstain ⇒ stop, NO model call) → synthesize → label.
 *
 * On abstention we do NOT call the model and do NOT log a second miss: retrieve() already logged exactly one
 * (the learning signal, §6). labelAnswer turns the abstained outcome into the honest abstention Answer.
 */
export async function answerQuestion(query: string, deps: AnswerDeps): Promise<AnswerOutcome> {
  const retrieval = await retrieve(query, deps);

  if (retrieval.abstained) {
    // No knowledge cleared the floor — abstain. No synthesis, no extra miss (retrieve() owns the single miss).
    return { answer: labelAnswer({ draftClaims: [], retrieval }), retrieval };
  }

  const draftClaims = await synthesizeClaims(query, retrieval.memories, { ...(deps.callModel ? { callModel: deps.callModel } : {}) });
  const answer = labelAnswer({
    draftClaims,
    retrieval,
    ...(deps.onFabricatedCitation ? { onFabricatedCitation: deps.onFabricatedCitation } : {}),
  });
  return { answer, retrieval };
}
