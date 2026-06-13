/**
 * The §5 routing decision tree — runs on every incoming item, stop at first match (Brief §5, PRD §6.3).
 * Gate 1 (drop) + Gate 2 (fetch-live) are DETERMINISTIC — no LLM, ever. Gates 3–4 may use the model.
 */
import type { GateDecision, IngestionDecision } from '@aios/shared';

export interface IncomingItem {
  sourceRef: string;
  content: string;
  connectorType: string;
  connectorIsStructured: boolean;
  fieldMeta?: { field: string; value: string }; // structured connectors tag items
  sensitivityLabel?: string; // MS label / manual tag
  trustLevel: 'high' | 'low';
}

/**
 * 1. SENSITIVE/EXCLUDED?  do-not-ingest source or sensitivity label → DROP / REVIEW.
 * 2. CURRENT-STATE STRUCTURED FACT?  structured connector + field ∈ connector_schemas → FETCH LIVE.
 *      field NOT in registry but connector IS structured → REVIEW (never auto-store) — fail-closed vs schema drift.
 *    (deterministic lookup — NO LLM CALL, EVER.)
 * 3. LASTING INTERPRETIVE VALUE?  cheap pre-classifier first, LLM only on ambiguous (§5.3).
 *      NO/UNSURE → INDEX-IN-PLACE (chunks).   YES → gate 4.
 * 4. ALSO A STRUCTURED ACTION?  YES → write SoR + episodic.   NO → WRITE TO MEMORY.
 * AFTER ANY WRITE: provenance; sensitivity = max(sources); zone = union; content_hash dedup; supersede if needed.
 * Always records an IngestionDecision (refs + confidence, not content).
 */
export async function route(_item: IncomingItem): Promise<{ decision: GateDecision; log: IngestionDecision }> {
  // TODO: implement gates in order; emit to ingestion health (§11.3); honour anti-poisoning trust gate (§5).
  throw new Error('TODO: route');
}
