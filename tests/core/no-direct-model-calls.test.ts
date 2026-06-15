/**
 * Architecture test — enforces the gateway chokepoint (silent-failure guard, Brief §11.8, red line #46).
 *
 * EVERY model/provider call must flow through `packages/core/src/harness/gateway.ts`. A rogue `import Anthropic`
 * — OR a raw `fetch('https://api.anthropic.com/…')` — anywhere else means untracked cost + untraced calls: a
 * silent failure of the observability layer itself. This walks the REAL source tree and FAILS on any leak.
 *
 * The detection logic lives in a PURE function (./detect-direct-model-calls) so it can be unit-tested against
 * known-BAD snippets — see detect-direct-model-calls.test.ts. That separation is the point of the #46 audit
 * fix: walking the (clean) tree alone would stay green even if the detector silently rotted to a no-op (the
 * M0 green-stub failure mode). The unit suite proves the guard guards; this file proves the real tree is clean.
 *
 * Scope: packages/​**​/src/**.ts, excluding the gateway itself, node_modules, dist, *.test.ts, *.d.ts.
 * Watch (#46): the forbidden lists live in ./detect-direct-model-calls — keep them updated as providers are added.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectDirectModelCalls } from './detect-direct-model-calls';

const ROOT = join(import.meta.dirname, '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const GATEWAY = join('packages', 'core', 'src', 'harness', 'gateway.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('gateway chokepoint (#46)', () => {
  const files = walk(PACKAGES_DIR);

  it('found source files to scan (the walker is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith(join('harness', 'gateway.ts')))).toBe(true);
  });

  it('no provider SDK or raw REST host is referenced outside the gateway', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (file.endsWith(GATEWAY)) continue; // the ONE allowed place
      const hits = detectDirectModelCalls(readFileSync(file, 'utf8'));
      for (const v of hits) {
        violations.push(`${file.replace(ROOT + '/', '')} — ${v.kind === 'import' ? 'imports' : 'references host'} ${v.specifier}`);
      }
    }
    expect(violations, `direct provider access outside the gateway:\n${violations.join('\n')}`).toEqual([]);
  });
});
