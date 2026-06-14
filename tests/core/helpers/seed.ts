/**
 * A handful of demo rows for the M0 tracer (Issue #2 task: "Seed a handful of rows via a script").
 * Shared by the acceptance/leak tests AND `scripts/seed-demo.ts`, so the demo path and the tested path
 * are the same code. Rows span zones + sensitivity levels precisely so a clearance filter has something
 * to exclude — the seed itself is a leak fixture.
 *
 * Embeddings are synthetic + deterministic (no model call). `embedding_model/version` are stamped from the
 * gateway pin on every row from row one (Issue #2 *Watch* — retrofitting the stamp later is painful).
 */
import type { Query } from './pglite.ts';
import { synthVector, vec } from './pglite.ts';
import {
  EMBEDDING_MODEL,
  EMBEDDING_VERSION,
} from '../../../packages/core/src/harness/gateway.ts';

export interface SeedRow {
  key: string; // stable seed for the synthetic embedding + content_hash
  namespace: string;
  zone: string;
  sensitivity: number;
  text: string;
}

/** Deliberately diverse on (zone, sensitivity) so clearance filtering is observable. */
export const DEMO_ROWS: SeedRow[] = [
  { key: 'gen-1', namespace: 'org', zone: 'general', sensitivity: 1, text: 'Company holiday policy: 25 days plus bank holidays.' },
  { key: 'gen-2', namespace: 'org', zone: 'general', sensitivity: 2, text: 'The office wifi network is AIOS-Guest.' },
  { key: 'fin-1', namespace: 'org', zone: 'finance', sensitivity: 3, text: 'Q3 revenue came in at £1.2M, ahead of plan.' },
  { key: 'fin-2', namespace: 'org', zone: 'finance', sensitivity: 4, text: 'Acme contract margin is 42% after rebates.' },
  { key: 'hr-1', namespace: 'org', zone: 'hr', sensitivity: 5, text: 'Performance review notes for J. Doe (confidential).' },
];

/** Insert the demo rows into BOTH tables. They are written identically — only the text column name differs. */
export async function seedDemoRows(query: Query): Promise<void> {
  for (const r of DEMO_ROWS) {
    const embedding = vec(synthVector(r.key));
    const contentHash = `sha256:${r.key}`;
    await query(
      `INSERT INTO memories (namespace, zone, sensitivity_level, statement, content_hash, embedding_model, embedding_version, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)`,
      [r.namespace, r.zone, r.sensitivity, r.text, contentHash, EMBEDDING_MODEL, EMBEDDING_VERSION, embedding],
    );
    await query(
      `INSERT INTO chunks (namespace, zone, sensitivity_level, text, content_hash, embedding_model, embedding_version, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)`,
      [r.namespace, r.zone, r.sensitivity, r.text, contentHash, EMBEDDING_MODEL, EMBEDDING_VERSION, embedding],
    );
  }
}
