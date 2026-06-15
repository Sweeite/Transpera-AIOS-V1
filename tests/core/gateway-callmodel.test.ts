/**
 * Issue #5 — the minimal `callModel` chokepoint plumbing (gateway.ts). Network-free: `fetch` is stubbed so the
 * REAL structured-output path (z.toJSONSchema → Anthropic FORCED tool-use → zod-validate) is exercised without
 * a key. The hermetic answer tests inject a fake model and never touch this path, so this is its only cover.
 *
 * Load-bearing properties:
 *   • a structured call FORCES the tool (tool_choice) and ships a JSON-Schema input_schema (reliable structured
 *     output — repair is deferred to #10, so the forcing matters);
 *   • the tool input is zod-VALIDATED → returned as typed output;
 *   • malformed output (no tool_use block) FAILS LOUD — never a silent/empty answer (red line);
 *   • a missing ANTHROPIC_API_KEY fails loud;
 *   • the plain-text path (no schema) returns concatenated text.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { z } from 'zod';
import { callModel, SONNET_MODEL } from '../../packages/core/src/harness/gateway.ts';

const Schema = z.object({ claims: z.array(z.object({ text: z.string(), sourceId: z.string().nullable().optional() })) });

function stubFetch(response: unknown, capture?: (req: { url: string; body: any; headers: any }) => void) {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    capture?.({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, statusText: 'OK', json: async () => response, text: async () => '' };
  });
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('callModel() structured path (#5, forced tool-use)', () => {
  it('forces the tool, ships a JSON-Schema input_schema, and zod-validates the tool input into typed output', async () => {
    let req: any;
    stubFetch(
      {
        content: [{ type: 'tool_use', name: 'emit_structured_output', input: { claims: [{ text: 'a', sourceId: 'mem-1' }] } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      (r) => (req = r),
    );

    const { output, usage } = await callModel({
      taskClass: 'synthesize',
      schema: Schema,
      messages: [{ role: 'user', content: 'SOURCES:\n[mem-1] x\n\nQUESTION: q' }],
    });

    // request shape: the tool is FORCED and carries a real object JSON-Schema
    expect(req.url).toContain('api.anthropic.com');
    expect(req.body.tool_choice).toEqual({ type: 'tool', name: 'emit_structured_output' });
    expect(req.body.tools[0].input_schema.type).toBe('object');
    expect(req.body.tools[0].input_schema.$schema).toBeUndefined(); // stripped — Anthropic wants a bare schema
    // #10 routing: a STRUCTURED 'synthesize' call routes to the safe Sonnet tier (conservative until #32),
    // not the Haiku pin #5 used. The forced-tool structured path itself is unchanged.
    expect(req.body.model).toBe(SONNET_MODEL);
    expect(req.headers['x-api-key']).toBe('test-key');

    // validated, typed output + usage
    expect(output).toEqual({ claims: [{ text: 'a', sourceId: 'mem-1' }] });
    expect(usage).toMatchObject({ model: SONNET_MODEL, tokensIn: 10, tokensOut: 5 });
  });

  it('fails LOUD when the model returns no tool_use block (repair → fallback → loud, no silent malformed answer)', async () => {
    stubFetch({ content: [{ type: 'text', text: 'I will not use the tool' }], usage: {} });
    // #10: malformed survives the bounded repair + the fallback model → the chain is exhausted loudly,
    // naming the structural reason. (Detailed repair/fallback mechanics live in gateway-routing-fallback.)
    await expect(
      callModel({ taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toThrow(/tool_use block[\s\S]*refusing to surface/i);
  });

  it('fails LOUD when the tool input violates the schema (zod → repair → fallback → loud)', async () => {
    stubFetch({ content: [{ type: 'tool_use', name: 'emit_structured_output', input: { claims: 'not-an-array' } }], usage: {} });
    await expect(
      callModel({ taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toThrow(/exhausted/i);
  });

  it('fails LOUD when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      callModel({ taskClass: 'synthesize', schema: Schema, messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('the plain-text path (no schema) returns concatenated text', async () => {
    stubFetch({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }], usage: { input_tokens: 1, output_tokens: 2 } });
    const { output } = await callModel({ taskClass: 'summarise', messages: [{ role: 'user', content: 'q' }] });
    expect(output).toBe('hello world');
  });
});
