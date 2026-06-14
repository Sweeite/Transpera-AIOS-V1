/**
 * M0 gate / #51 — guard the test harness itself: the DEFAULT `pnpm test` must run the core suite, so a green
 * "tests pass" can never mean "nothing ran". Locks the root vitest config's include glob + the root script.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import rootConfig from '../../vitest.config.ts';

describe('test harness wiring (M0 gate)', () => {
  it('the root vitest config includes tests/core/**', () => {
    const include = (rootConfig as any).test?.include as string[] | undefined;
    expect(include).toBeDefined();
    expect(include!.some((g) => g.includes('tests/core'))).toBe(true);
  });

  it('the root `test` script runs vitest (not a no-op recursive call that covers nothing)', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.test).toMatch(/vitest/);
    expect(pkg.scripts.test).not.toContain('-r'); // recursive package test ran nothing — that was the bug
  });
});
