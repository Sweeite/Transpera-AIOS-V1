/**
 * Issue #15 — context assembly + token budgeting (PRD §6.2). assembleContext() is PURE (no network, no DB):
 * it takes retrieve()'s already-permission-filtered output + persona + tool defs + the asker's own thread, and
 * builds the prompt for a turn WITHOUT blowing the window or leaking. The load-bearing properties, each a
 * permanent regression test:
 *   (a) over-budget ⇒ truncated by relevance (RRF order, tail dropped); kept tokenEstimate ≤ budget.
 *   (b) droppedForBudget + a content-free drop log are emitted (ids/counts/estimates ONLY — §11.10).
 *   (c) deterministic: same input ⇒ byte-identical assembly.
 *   (d) LEAK: a thread entry owned by another principal is NEVER kept; a retrieved item outside the asker's
 *       clearance is dropped (defense-in-depth); an assistant turn in the asker's OWN thread IS kept.
 *   (e) the stable `system` prefix is byte-stable across turns with the same persona + tools (prompt-cache
 *       precondition, #10).
 */
import { describe, it, expect } from 'vitest';
import type { Clearance, Principal, Provenance } from '../../packages/shared/src/types.ts';
import {
  assembleContext,
  CONTEXT_CHARS_PER_TOKEN,
  type AssembledContext,
  type ContextDropLog,
  type ThreadEntry,
  type ToolDef,
} from '../../packages/core/src/harness/context.ts';
import type { RetrievedMemory, RetrievedChunk } from '../../packages/core/src/harness/retrieval.ts';

const USER: Principal = { kind: 'user', userId: 'u-asker' };
const OTHER: Principal = { kind: 'user', userId: 'u-other' };
const THREAD = 't-asker'; // the asker's authorized thread (caller resolves via threads.owner_id + §7.1)
const CLEAR: Clearance = { allowedZones: ['general', 'finance'], maxSensitivity: 3, allowedNamespaces: ['org', 'client:acme'] };

function prov(ref: string): Provenance {
  return { sourceRefs: [ref], capturedAt: '2026-01-01T00:00:00.000Z', trustLevel: 'high' };
}

function mem(id: string, statement: string, over: Partial<RetrievedMemory> = {}): RetrievedMemory {
  return {
    id,
    namespace: 'org',
    zone: 'general',
    sensitivityLevel: 1,
    type: 'semantic',
    statement,
    contentHash: `sha256:${id}`,
    provenance: prov(`ref:${id}`),
    embeddingModel: 'm',
    embeddingVersion: 'v',
    createdAt: '2026-01-01T00:00:00.000Z',
    cosine: 0.9,
    ...over,
  };
}

function chunk(id: string, text: string, over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id,
    namespace: 'org',
    zone: 'general',
    sensitivityLevel: 1,
    text,
    contentHash: `sha256:${id}`,
    provenance: prov(`ref:${id}`),
    embeddingModel: 'm',
    embeddingVersion: 'v',
    createdAt: '2026-01-01T00:00:00.000Z',
    cosine: 0.8,
    ...over,
  };
}

const TOOLS: ToolDef[] = [
  { name: 'search', description: 'search the web' },
  { name: 'email', description: 'send an email' },
];

function base(over: Partial<Parameters<typeof assembleContext>[0]> = {}) {
  return {
    clearance: CLEAR,
    principal: USER,
    persona: 'You are Atlas, an agency operations assistant.',
    toolDefs: TOOLS,
    retrieved: { memories: [] as RetrievedMemory[], chunks: [] as RetrievedChunk[] },
    recentThread: [] as ThreadEntry[],
    authorizedThreadId: THREAD,
    tokenBudget: 100000,
    ...over,
  };
}

function turn(role: 'user' | 'brain', text: string, over: Partial<ThreadEntry> = {}): ThreadEntry {
  return { threadId: THREAD, principal: USER, role, text, ...over };
}

describe('#15 assembleContext — token budgeting', () => {
  it('(a) truncates over-budget retrieved by relevance (tail dropped); kept tokenEstimate ≤ budget', async () => {
    // 5 memories of equal size, RRF order m1..m5 (most→least relevant). A budget that fits system + ~2 of them.
    const memories = [1, 2, 3, 4, 5].map((i) => mem(`m${i}`, 'X'.repeat(40))); // ~10 tokens each (40/4)
    const persona = 'P'.repeat(20);
    // Compute a budget that admits system + exactly the first two memories.
    const probe = await assembleContext(base({ persona, toolDefs: [], retrieved: { memories, chunks: [] }, tokenBudget: 1_000_000 }));
    const sysTokens = Math.ceil(probe.system.length / CONTEXT_CHARS_PER_TOKEN);
    const perItem = Math.ceil((`[m1] ${'X'.repeat(40)}`).length / CONTEXT_CHARS_PER_TOKEN);
    const budget = sysTokens + perItem * 2 + 1; // room for two items, not three

    const out = await assembleContext(base({ persona, toolDefs: [], retrieved: { memories, chunks: [] }, tokenBudget: budget }));
    expect(out.retrieved.map((r) => r.id)).toEqual(['m1', 'm2']); // most-relevant prefix kept, tail dropped
    expect(out.droppedForBudget).toBe(3);
    expect(out.tokenEstimate).toBeLessThanOrEqual(budget);
  });

  it('(a2) memories rank before chunks; the cross-store tail is chunks first', async () => {
    const memories = [mem('m1', 'aaaa'), mem('m2', 'bbbb')];
    const chunks = [chunk('c1', 'cccc')];
    const out = await assembleContext(base({ retrieved: { memories, chunks }, tokenBudget: 100000 }));
    expect(out.retrieved.map((r) => `${r.kind}:${r.id}`)).toEqual(['memory:m1', 'memory:m2', 'chunk:c1']);
  });

  it('(b) emits droppedForBudget + a content-free drop log (ids/counts only, NO statements)', async () => {
    const memories = [mem('m1', 'KEPTSTATEMENT'), mem('m2', 'SECRETDROPPEDSTATEMENT')];
    const logs: ContextDropLog[] = [];
    const probe = await assembleContext(base({ persona: '', toolDefs: [], retrieved: { memories: [memories[0]!], chunks: [] }, tokenBudget: 1_000_000 }));
    const budget = probe.tokenEstimate; // exactly fits m1 only
    const out = await assembleContext(
      base({ persona: '', toolDefs: [], retrieved: { memories, chunks: [] }, tokenBudget: budget, onDropped: (l) => logs.push(l) }),
    );
    expect(out.droppedForBudget).toBe(1);
    expect(out.dropLog.droppedRetrievedIds).toEqual(['m2']);
    expect(logs).toHaveLength(1);
    // §11.10: the drop log must carry NO content — only the id, never the statement text.
    const serialized = JSON.stringify(out.dropLog);
    expect(serialized).not.toContain('SECRETDROPPEDSTATEMENT');
    expect(serialized).toContain('m2');
  });

  it('(c) is deterministic — same input ⇒ byte-identical assembly', async () => {
    const memories = [mem('m1', 'alpha'), mem('m2', 'beta')];
    const recentThread: ThreadEntry[] = [turn('user', 'first'), turn('brain', 'reply')];
    const a = await assembleContext(base({ retrieved: { memories, chunks: [] }, recentThread }));
    const b = await assembleContext(base({ retrieved: { memories, chunks: [] }, recentThread }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('(e) system prefix is byte-stable across turns with the same persona + tools', async () => {
    const t1 = await assembleContext(base({ recentThread: [turn('user', 'turn one')] }));
    const t2 = await assembleContext(base({ recentThread: [turn('user', 'a totally different second turn')] }));
    expect(t1.system).toBe(t2.system); // the cached prefix does not move with the per-turn message
    expect(t1.system).toContain('Atlas');
    expect(t1.system).toContain('search');
  });
});

describe('#15 assembleContext — LEAK fixture (Decision C, thread-scope + clearance)', () => {
  it('(d1) drops a turn from ANOTHER thread (cross-thread contamination); never surfaces it', async () => {
    const recentThread: ThreadEntry[] = [
      turn('user', 'mine'),
      turn('user', 'ANOTHER THREADS SECRET', { threadId: 't-foreign' }),
    ];
    const out = await assembleContext(base({ recentThread }));
    expect(out.recentThread.map((t) => t.text)).toEqual(['mine']);
    expect(JSON.stringify(out)).not.toContain('ANOTHER THREADS SECRET');
    expect(out.dropLog.deniedThreadTurns).toBe(1);
  });

  it('(d2) KEEPS a co-participant turn in a SHARED authorized thread (per-turn author is NOT the gate, §7.1)', async () => {
    // The thing model-B (author-match) would have wrongly dropped: a turn in the asker's authorized thread
    // authored by a DIFFERENT principal (a shared thread) — and the 'brain' turn — both legitimately visible.
    const recentThread: ThreadEntry[] = [
      turn('user', 'asker question'),
      turn('user', 'co-participant turn', { principal: OTHER }),
      turn('brain', 'the brain answer'),
    ];
    const out = await assembleContext(base({ recentThread }));
    expect(out.recentThread.map((t) => `${t.role}:${t.text}`)).toEqual([
      'user:asker question',
      'user:co-participant turn',
      'brain:the brain answer',
    ]);
    expect(out.dropLog.deniedThreadTurns).toBe(0);
  });

  it('(d3) no authorized thread (e.g. a service run) ⇒ keeps NO thread, fail-closed', async () => {
    const recentThread: ThreadEntry[] = [turn('user', 'leaky')];
    const out = await assembleContext(base({ authorizedThreadId: undefined, recentThread }));
    expect(out.recentThread).toEqual([]);
    expect(out.dropLog.deniedThreadTurns).toBe(1);
  });

  it('(d4) defense-in-depth: a retrieved item outside the asker clearance is dropped (zone/sensitivity/namespace)', async () => {
    const memories = [
      mem('ok', 'visible', { zone: 'general', sensitivityLevel: 1, namespace: 'org' }),
      mem('badZone', 'forbidden zone', { zone: 'legal' }), // legal ∉ allowedZones
      mem('badSens', 'too sensitive', { sensitivityLevel: 5 }), // > maxSensitivity 3
      mem('badNs', 'wrong namespace', { namespace: 'project:atlas' as any }), // ∉ allowedNamespaces
    ];
    const out = await assembleContext(base({ retrieved: { memories, chunks: [] } }));
    expect(out.retrieved.map((r) => r.id)).toEqual(['ok']);
    expect(out.dropLog.deniedRetrievedIds.sort()).toEqual(['badNs', 'badSens', 'badZone']);
    expect(JSON.stringify(out.retrieved)).not.toContain('forbidden zone');
  });
});

describe('#15 assembleContext — misconfig anomalies (never silent)', () => {
  it('system alone over budget ⇒ kept WHOLE + systemOverBudget flag', async () => {
    const out = await assembleContext(base({ persona: 'Z'.repeat(400), toolDefs: [], tokenBudget: 1 }));
    expect(out.system).toContain('Z'.repeat(400)); // never shipped half a persona
    expect(out.dropLog.systemOverBudget).toBe(true);
  });

  it('thread starves retrieved (keptRetrieved 0 while drops happen) ⇒ retrievedStarved anomaly', async () => {
    const longThread: ThreadEntry[] = [turn('user', 'T'.repeat(400))];
    const memories = [mem('m1', 'M'.repeat(400))];
    const probe = await assembleContext(base({ persona: '', toolDefs: [], recentThread: longThread, tokenBudget: 1_000_000 }));
    const threadOnly = Math.ceil(probe.system.length / CONTEXT_CHARS_PER_TOKEN) + Math.ceil('user: '.concat('T'.repeat(400)).length / CONTEXT_CHARS_PER_TOKEN);
    const out = await assembleContext(
      base({ persona: '', toolDefs: [], recentThread: longThread, retrieved: { memories, chunks: [] }, tokenBudget: threadOnly }),
    );
    expect(out.recentThread).toHaveLength(1);
    expect(out.droppedForBudget).toBe(1);
    expect(out.dropLog.keptRetrieved).toBe(0);
    expect(out.dropLog.retrievedStarved).toBe(true);
  });
});
