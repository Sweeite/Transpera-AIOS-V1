/**
 * Unit suite for the gateway-chokepoint DETECTOR (#46) — this is what makes the acceptance criterion real.
 *
 * The sibling no-direct-model-calls.test.ts walks the (clean) real tree; on its own it would stay green even
 * if the detector silently rotted to a no-op. Here we prove the guard GUARDS by feeding it known-BAD input
 * (every import form + a raw host) and assert each is flagged, plus false-positive hardening (a false RED
 * blocks legit code and is as corrosive as a false green) and the acknowledged known gaps.
 */
import { describe, it, expect } from 'vitest';
import { detectDirectModelCalls, FORBIDDEN_IMPORTS, FORBIDDEN_HOSTS } from './detect-direct-model-calls';

const kinds = (src: string) => detectDirectModelCalls(src).map((v) => `${v.kind}:${v.specifier}`);

describe('detectDirectModelCalls — positive detection (the guard guards)', () => {
  // The audit fix: catch import()/require(), not just static import.
  it.each([
    ['static default import', `import Anthropic from 'openai';`],
    ['static named import', `import { OpenAI } from 'openai';`],
    ['static namespace import', `import * as o from 'openai';`],
    ['dynamic import()', `const m = await import('openai');`],
    ['require()', `const o = require('openai');`],
    ['static import, no semicolon', `import X from 'openai'\nconst y = 1`],
    // Regression (probe, #46): multiline named imports are what prettier/eslint emit once the line wraps —
    // the keyword and the specifier land on different lines. A single-line scan MISSED these (false-negative,
    // the cardinal sin for a fail-closed guard). The `from`-anchored branch catches them.
    ['multiline named import', `import {\n  OpenAI,\n} from 'openai';`],
    ['from on its own line', `import\n  Anthropic\nfrom 'openai';`],
    ['side-effect import', `import 'openai';`],
    // Regression (probe, #46): a re-export of a provider SDK is also a leak — caught by the `from` anchor.
    ['re-export', `export { OpenAI } from 'openai';`],
  ])('flags a direct provider import: %s', (_label, src) => {
    expect(kinds(src)).toContain('import:openai');
  });

  it('flags a raw provider REST host literal', () => {
    expect(kinds(`const r = await fetch('https://api.openai.com/v1/embeddings');`)).toContain('host:api.openai.com');
  });

  it('flags each forbidden SDK — incl. the embedding-provider SDKs (audit fix)', () => {
    for (const spec of FORBIDDEN_IMPORTS) {
      expect(kinds(`import x from '${spec}';`)).toContain(`import:${spec}`);
    }
  });

  it('flags each forbidden REST host', () => {
    for (const host of FORBIDDEN_HOSTS) {
      expect(kinds(`const u = 'https://${host}/v1';`)).toContain(`host:${host}`);
    }
  });

  it('flags multiple distinct leaks in one file', () => {
    const src = `import a from 'openai';\nimport b from '@anthropic-ai/sdk';\nfetch('https://api.cohere.com/x');`;
    expect(kinds(src).sort()).toEqual(['host:api.cohere.com', 'import:@anthropic-ai/sdk', 'import:openai']);
  });
});

describe('detectDirectModelCalls — clean code is not flagged', () => {
  it('returns [] for a normal file with no provider calls', () => {
    const src = `import { z } from 'zod';\nimport { callModel } from '../harness/gateway';\nexport const x = 1;`;
    expect(detectDirectModelCalls(src)).toEqual([]);
  });

  it('does not flag the gateway-relative import path itself', () => {
    expect(detectDirectModelCalls(`import { callModel } from './harness/gateway';`)).toEqual([]);
  });
});

describe('detectDirectModelCalls — false-positive hardening (a false RED is as corrosive as a false green)', () => {
  // Word boundaries: identifiers that merely CONTAIN the keywords must not trip the detector.
  it('does not flag acquire(x) (contains no `require` token, and word-boundaried anyway)', () => {
    expect(detectDirectModelCalls(`const c = acquire('openai-pool');`)).toEqual([]);
  });

  it('does not flag a function whose name contains `require`', () => {
    expect(detectDirectModelCalls(`function requireAuth() { return load('openai-ish'); }`)).toEqual([]);
  });

  it('does not flag a variable whose name contains `import`', () => {
    expect(detectDirectModelCalls(`const important = config['openai'];`)).toEqual([]);
  });

  it('exact-quote: a longer specifier sharing a prefix is not flagged', () => {
    expect(detectDirectModelCalls(`import x from 'openai-edge';`)).toEqual([]);
  });

  // Regression (probe, #46): the `from` anchor must not turn query-builder method calls into a false RED.
  // `db.from('…')` is everywhere in this repo (Supabase / Drizzle / pgmq); the (?<!\.) lookbehind excludes it.
  it('does not flag a query-builder .from() call', () => {
    expect(detectDirectModelCalls(`const rows = await db.from('openai').select('*');`)).toEqual([]);
  });

  it('does not flag a transform()/method whose name merely contains a keyword', () => {
    expect(detectDirectModelCalls(`const v = transform('openai'); importFoo('openai'); requireBar('openai');`)).toEqual([]);
  });
});

describe('detectDirectModelCalls — accepted trade-off & known gaps (never silently over-claimed)', () => {
  // ACCEPTED false-RED: for a chokepoint we bias fail-loud. A provider mention in a comment IS flagged —
  // rare, safe, trivially fixed. We codify the choice so it can't silently flip to comment-stripping
  // (which would open a desync->drop-a-real-host false-NEGATIVE surface).
  it('flags a host even inside a comment (accepted fail-loud false-positive; we do NOT strip comments)', () => {
    expect(kinds(`// docs: see https://api.openai.com/v1 for the schema`)).toContain('host:api.openai.com');
  });

  // KNOWN GAP (audit fix): a static text scan cannot resolve variable indirection. Documented + asserted,
  // never over-claimed. Catching this needs runtime enforcement, which is out of scope per the issue.
  it('KNOWN GAP: variable-indirection import is NOT caught (static scan limit)', () => {
    expect(detectDirectModelCalls(`const p = 'openai';\nconst m = await import(p);`)).toEqual([]);
  });

  // KNOWN GAP: a dynamically-concatenated host has no contiguous literal to match.
  it('KNOWN GAP: a concatenated host literal is NOT caught (static scan limit)', () => {
    expect(detectDirectModelCalls("const u = 'https://api.' + 'openai' + '.com';")).toEqual([]);
  });
});
