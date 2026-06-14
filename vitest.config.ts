import { defineConfig } from 'vitest/config';

/**
 * Root test config (the CI harness, #51). The DEFAULT `pnpm test` runs the core suite (tests/core/**), so
 * "the tests pass" can never mean "nothing ran". The key-gated real-LLM tests inside that tree self-skip
 * without keys (describe.skipIf), so the default run is hermetic; the real-Postgres-gated tests self-skip
 * without SUPABASE_DB_URL (CI's real-postgres job sets it).
 *
 * ⚠ FALSE-GREEN TRAP: this glob is `tests/core/**` ONLY — it gates NO tenant-fixtures and NO eval tests
 * today. When #36 (full leak suite) or #32 (eval harness) add `*.test.ts` under `tests/tenant-fixtures/` or
 * `tests/eval/`, you MUST add those globs to `include` below — otherwise they NEVER run in CI and a broken
 * fixture stays green. The include list is the load-bearing line; expanding it is part of #36/#32.
 */
export default defineConfig({
  test: {
    include: ['tests/core/**/*.test.ts'],
  },
});
