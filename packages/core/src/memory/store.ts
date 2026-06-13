/**
 * Memory store — write / invalidate (NEVER overwrite, §4.4). Provenance, sensitivity, namespace on write (§5).
 */
import type { Memory, MemorySlot, Namespace, Provenance } from '@aios/shared';

export interface WriteMemoryInput {
  type: Memory['type'];
  namespace: Namespace; // derived via the Identity Map from entity refs (§4.10)
  statement: string;
  slot?: MemorySlot;
  provenance: Provenance; // trustLevel gates promotion to semantic (anti-poisoning, §5)
}

/** sensitivity = max(sources), zone = union(sources), content_hash dedup; supersede older fact if needed. */
export async function writeMemory(_input: WriteMemoryInput): Promise<Memory> {
  // TODO: embed (pinned model), compute content_hash, set sensitivity/zone, insert; if it supersedes → invalidate old.
  throw new Error('TODO: writeMemory');
}

/** Invalidate, don't overwrite: set valid_to = now(), status = 'invalidated'. History stays queryable (§4.4). */
export async function invalidate(_memoryId: string, _reason: string): Promise<void> {
  // TODO
  throw new Error('TODO: invalidate');
}
