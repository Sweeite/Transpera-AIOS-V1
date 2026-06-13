import type { Answer } from '@aios/shared';

/**
 * Thin client to the per-client Fastify engine (packages/api).
 * Auth: Supabase JWT in the Authorization header → the engine resolves the principal (Brief §8.1a).
 * The shared `Answer` type means the provenance contract is identical on both sides.
 */
export async function ask(message: string, signal?: AbortSignal): Promise<Answer> {
  // TODO: real call —
  //   const res = await fetch('/api/chat', {
  //     method: 'POST',
  //     headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  //     body: JSON.stringify({ message }),
  //     signal,
  //   });
  // For chat, switch to SSE/fetch-stream and render tokens as they arrive (latency-as-trust, Brief §12).
  void message;
  void signal;
  throw new Error('TODO: wire ask() to POST /api/chat');
}
