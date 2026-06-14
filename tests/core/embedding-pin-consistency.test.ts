/**
 * M0 gate (SF8) — stop the embedding pin drifting from the bake-off that justified it (Issue #1, §4.7).
 *
 * The gateway's PINNED embedding (EMBEDDING_MODEL/DIM/DTYPE) is a one-way door once a corpus is embedded. It
 * must correspond to a candidate that was actually MEASURED in the bake-off — otherwise the pin and the
 * evidence for it silently diverge. This couples the two: change the gateway pin without a matching measured
 * candidate (or drop the candidate) and this fails, forcing the bake-off to be re-run / the candidate kept.
 */
import { describe, it, expect } from 'vitest';
import { EMBEDDING_MODEL, EMBEDDING_DIM, EMBEDDING_DTYPE } from '../../packages/core/src/harness/gateway.ts';
import { CANDIDATES } from '../eval/embedding-bakeoff/candidates.ts';

describe('embedding pin ↔ bake-off consistency (SF8)', () => {
  it('the gateway pin corresponds to a candidate the bake-off actually measured', () => {
    const match = CANDIDATES.find(
      (c) => c.model === EMBEDDING_MODEL && c.dim === EMBEDDING_DIM && c.dtype === EMBEDDING_DTYPE,
    );
    expect(
      match,
      `gateway pin ${EMBEDDING_MODEL}@${EMBEDDING_DIM}/${EMBEDDING_DTYPE} has no matching bake-off candidate — ` +
        're-run the bake-off (#1/#43) or keep the candidate so the pin stays evidence-backed.',
    ).toBeDefined();
  });
});
