import { defineConfig } from 'vitest/config';

/**
 * Root test config (minimal slice of #51 — the CI harness). The DEFAULT `pnpm test` runs the M0 core suite
 * (tests/core/**), so "the tests pass" can never mean "nothing ran". The key-gated real-LLM tests inside that
 * tree self-skip without keys (describe.skipIf), so the default run is hermetic. #51 expands this (coverage,
 * tenant-fixtures gate, leak-fixture gate wiring); the include glob below is the load-bearing part.
 */
export default defineConfig({
  test: {
    include: ['tests/core/**/*.test.ts'],
  },
});
