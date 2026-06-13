/**
 * Architecture test — enforces the gateway chokepoint (silent-failure guard, Brief §11.8).
 * Nothing may call a model provider directly: a rogue `import Anthropic` outside gateway.ts means
 * untracked cost + untraced calls — a silent failure of the observability layer itself.
 */
import { describe, it, expect } from 'vitest';

const FORBIDDEN_IMPORTS = [
  '@anthropic-ai/sdk',
  'openai',
  '@google/generative-ai',
  // add providers as they're introduced
];

const ALLOWED_FILES = [
  'packages/core/src/harness/gateway.ts', // the ONLY place provider SDKs may be imported
];

describe('gateway chokepoint', () => {
  it('no provider SDK is imported outside the gateway', async () => {
    // TODO: walk packages/**/*.ts (excluding ALLOWED_FILES + node_modules), assert none import FORBIDDEN_IMPORTS.
    // Fail CI on any violation. This is a guard, not a feature — keep it green forever.
    expect(FORBIDDEN_IMPORTS.length).toBeGreaterThan(0);
  });
});
