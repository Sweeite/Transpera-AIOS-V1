/**
 * The one place that resolves the jsonb DRIVER DIVERGENCE (#55, found in the #11 review).
 *
 * A jsonb column arrives PARSED on some drivers (pglite, and postgres.js' simple/param-less protocol) but as
 * RAW JSON TEXT on others — specifically postgres.js running a PARAMETERIZED query under `prepare: false`
 * (the Supavisor transaction-mode invariant, db/client.ts §2). Under `prepare: false` there is no
 * prepared-statement type cache, so neither postgres.js' built-in jsonb parser NOR a custom OID-3802 `types`
 * parser fires — proven against pgvector:0.8.0-pg15. Every real read therefore sees raw text on Supabase while
 * pglite tests see an object. Normalise HERE so reads match the shape that was written, regardless of driver.
 *
 * ⚠ A driver-level parser CANNOT fix this under `prepare: false`. The real one-place fix lives in the
 *   production QueryFn adapter (inspect result-column OIDs == 3802 and parse jsonb post-hoc — that needs no
 *   type cache, so it works under `prepare: false`); ticketed as #56 — too broad to land at M1 close.
 */

/** Object jsonb (e.g. audit_log.metadata) → a plain object, whether the driver handed us text or an object. */
export function asObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}

/**
 * Scalar jsonb (system_config.value, config_proposals.proposed_value) → its JS value, disambiguated by the
 * caller's DECLARED type (KNOWN_KEYS). This is the type knowledge the driver can't supply under `prepare:false`
 * but the caller already holds, so it fully resolves the divergence with no string-scalar footgun:
 *
 *   number key:  pg.js text '0.608' → 0.608 ; pglite 0.608 → 0.608. (A non-numeric value is handed back raw so
 *                the caller's own type/anomaly guard rejects it — we NEVER coerce a non-number into a number.)
 *   string key:  pg.js JSON-quoted text '"hello"' → 'hello' ; pglite bare 'hello' → 'hello'. JSON.parse is
 *                applied ONLY when it yields a string (the quoted pg.js form); a pglite bare string — including
 *                a numeric-looking '123' that JSON.parse would wrongly turn into 123 — is kept verbatim.
 */
export function asConfigValue(raw: unknown, expected: 'number' | 'string'): number | string | null {
  if (raw == null) return null;
  if (expected === 'number') {
    if (typeof raw === 'number') return raw; // pglite / simple-protocol: already parsed
    if (typeof raw === 'string') {
      const n = Number(raw); // pg.js raw text '0.608'
      return Number.isFinite(n) ? n : raw; // non-numeric → hand back raw; the caller's guard flags it
    }
    return raw as number | string;
  }
  // expected === 'string'
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed; // pg.js JSON-quoted text
    } catch {
      /* not JSON → already a bare string (pglite) */
    }
    return raw; // bare string (pglite), incl. numeric-looking ones JSON.parse must NOT mangle
  }
  return raw as number | string;
}
