/**
 * Architecture test — enforces the gateway chokepoint (silent-failure guard, Brief §11.8, red line #46).
 *
 * EVERY model/provider call must flow through `packages/core/src/harness/gateway.ts`. A rogue `import Anthropic`
 * — OR a raw `fetch('https://api.anthropic.com/…')` — anywhere else means untracked cost + untraced calls: a
 * silent failure of the observability layer itself. This walks the real source tree and FAILS on any leak.
 *
 * Two leak shapes are caught:
 *   1. importing a provider SDK,
 *   2. a raw provider REST host literal (the gateway uses fetch, so an SDK ban alone isn't enough).
 * Scope: packages/​**​/src/**.ts, excluding the gateway itself, node_modules, dist, and *.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const GATEWAY = join('packages', 'core', 'src', 'harness', 'gateway.ts');

// Provider SDKs that must never be imported outside the gateway.
const FORBIDDEN_IMPORTS = ['@anthropic-ai/sdk', 'openai', '@google/generative-ai', 'cohere-ai', 'voyageai'];
// Raw provider REST hosts — the gateway speaks fetch, so a banned host literal elsewhere is also a leak.
const FORBIDDEN_HOSTS = ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'api.voyageai.com', 'api.cohere.com'];

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

function importsAny(src: string, specifiers: string[]): string[] {
  return specifiers.filter((s) => {
    const re = new RegExp(`(import|require)\\s*[^;\\n]*['"]${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
    return re.test(src);
  });
}

describe('gateway chokepoint (#46)', () => {
  const files = walk(PACKAGES_DIR);

  it('found source files to scan (the walker is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith(join('harness', 'gateway.ts')))).toBe(true);
  });

  it('no provider SDK is imported outside the gateway', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (file.endsWith(GATEWAY)) continue; // the ONE allowed place
      const hits = importsAny(readFileSync(file, 'utf8'), FORBIDDEN_IMPORTS);
      if (hits.length) violations.push(`${file.replace(ROOT + '/', '')} imports ${hits.join(', ')}`);
    }
    expect(violations, `provider SDK imported outside the gateway:\n${violations.join('\n')}`).toEqual([]);
  });

  it('no raw provider REST host is referenced outside the gateway', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (file.endsWith(GATEWAY)) continue;
      const src = readFileSync(file, 'utf8');
      const hits = FORBIDDEN_HOSTS.filter((h) => src.includes(h));
      if (hits.length) violations.push(`${file.replace(ROOT + '/', '')} references ${hits.join(', ')}`);
    }
    expect(violations, `raw provider host referenced outside the gateway:\n${violations.join('\n')}`).toEqual([]);
  });
});
