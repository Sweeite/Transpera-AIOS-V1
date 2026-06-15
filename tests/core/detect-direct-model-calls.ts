/**
 * Pure detector for the gateway chokepoint (#46): source text → violations[], with NO filesystem access.
 * Lives in tests/ (the tree-walk scans only packages/**, so its own forbidden-list literals never self-trip)
 * and is unit-testable against synthetic good/bad snippets — SEPARATE from the real-tree walk in
 * no-direct-model-calls.test.ts. Acceptance ("a direct provider import fails CI") is only REAL because the
 * sibling unit test proves this detector flags KNOWN-BAD input; scanning the (clean) real tree alone would
 * stay green even if the detector silently rotted to a no-op (the M0 green-stub failure mode).
 *
 * ⚠ Audit fix (#46, Tier 3):
 *   - embedding-provider SDKs are in the forbidden list (voyageai, cohere-ai), not just chat SDKs;
 *   - import()/require() are caught, not just static `import` (the dynamic forms);
 *   - hostname-level enforcement of a DYNAMICALLY-BUILT host is a KNOWN GAP — see "known gaps" below.
 *   Runtime enforcement is explicitly OUT OF SCOPE (this is a static/CI guard, per the issue).
 *
 * Risk ordering (reviewer call): for a chokepoint a false-NEGATIVE (miss a leak) is far worse than a
 * false-POSITIVE (block on a mention in a comment — rare, safe, trivially fixed, fails LOUD). So we do NOT
 * strip comments: a comment-stripper can desync (a malformed string literal) and DROP a real host/import,
 * which is exactly the false-negative we cannot tolerate. Word boundaries (below) handle acquire/important
 * independently of any comment handling.
 *
 * Known gaps (acknowledged, never silently over-claimed — each is asserted in the unit suite):
 *   - variable indirection:        const p = 'openai'; await import(p)   — the specifier isn't a literal here
 *   - dynamically-built host:       'https://api.' + 'openai.com'        — no contiguous literal to match
 *   A static text scan cannot see through either; catching them needs runtime enforcement (out of scope).
 *
 * Watch (#46): keep FORBIDDEN_IMPORTS / FORBIDDEN_HOSTS updated as providers are added. Today they cover
 * #10's REAL provider set — Anthropic (generation) + OpenAI (embeddings), both SDKs and REST hosts — plus
 * forward-looking Google / Cohere / Voyage.
 */

/** Provider SDKs that must never be imported outside the gateway. */
export const FORBIDDEN_IMPORTS = ['@anthropic-ai/sdk', 'openai', '@google/generative-ai', 'cohere-ai', 'voyageai'];
/** Raw provider REST hosts — the gateway speaks fetch, so a banned host literal elsewhere is also a leak. */
export const FORBIDDEN_HOSTS = ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'api.voyageai.com', 'api.cohere.com'];

export type Violation = { kind: 'import' | 'host'; specifier: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan a single file's source text for direct-provider leaks. Returns every distinct specifier hit.
 *
 * Import regex, per forbidden specifier — two anchored branches so it does NOT require the keyword and the
 * specifier on the same line (a probe found that a single-line scan MISSES multiline named imports — the
 * common `import {\n  OpenAI,\n} from 'openai'` that prettier/eslint produce — a false-negative, the cardinal
 * sin for a fail-closed guard):
 *   (?<!\.)from\s+['"]<spec>['"]            the static-import / re-export tail. Anchored on `from`, so it
 *                                            catches single-line, MULTILINE, `import *`, type-only, AND
 *                                            `export … from`. The (?<!\.) lookbehind excludes query-builder
 *                                            method calls like `db.from('…')` (Supabase/Drizzle/pgmq) — a
 *                                            false RED there would block legit code.
 *   \b(?:import|require)\s*\(?\s*['"]<spec>['"]   side-effect `import 'x'`, dynamic `import('x')`, `require('x')`.
 *                                            The mandatory quote right after the keyword stops 'important' /
 *                                            'requireAuth' / 'acquire(' from matching.
 *   ['"]<spec>['"]                          EXACT quoted specifier — 'openai' ≠ 'openai-edge'.
 */
export function detectDirectModelCalls(
  src: string,
  imports: string[] = FORBIDDEN_IMPORTS,
  hosts: string[] = FORBIDDEN_HOSTS,
): Violation[] {
  const violations: Violation[] = [];
  for (const spec of imports) {
    const q = `['"]${escapeRe(spec)}['"]`;
    const re = new RegExp(`(?:(?<!\\.)from\\s+|\\b(?:import|require)\\s*\\(?\\s*)${q}`);
    if (re.test(src)) violations.push({ kind: 'import', specifier: spec });
  }
  for (const host of hosts) {
    if (src.includes(host)) violations.push({ kind: 'host', specifier: host });
  }
  return violations;
}
