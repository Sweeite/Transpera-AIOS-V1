/**
 * Issue #2 — runnable demo of the M0 tracer slice. Boots an in-process Postgres+pgvector (pglite), applies
 * the real migration, seeds a handful of rows, and runs a `<=>` nearest-neighbour search — proving the
 * store-and-search acceptance end to end with ZERO external infrastructure.
 *
 *   pnpm seed:demo
 *
 * The same migration SQL and the same seedDemoRows() the tests use run here, so the demo never drifts from
 * what is verified. (When a real client DB exists, the identical seedDemoRows(query) runs against it — only
 * the connection changes; the pgmq/Supabase wiring lands in a later issue.)
 */
import { freshDb, synthVector, vec } from '../tests/core/helpers/pglite.ts';
import { seedDemoRows } from '../tests/core/helpers/seed.ts';

async function main(): Promise<void> {
  const { query } = await freshDb();
  await seedDemoRows(query);

  const counts = await query(`SELECT
      (SELECT count(*) FROM memories)::int AS memories,
      (SELECT count(*) FROM chunks)::int   AS chunks`);
  console.log(`seeded: ${counts.rows[0].memories} memories, ${counts.rows[0].chunks} chunks\n`);

  // Search memories for the row nearest to the 'fin-1' embedding (revenue fact).
  const q = vec(synthVector('fin-1'));
  const res = await query(
    `SELECT zone, sensitivity_level, statement, (embedding <=> $1::vector)::float8 AS distance
       FROM memories
      ORDER BY embedding <=> $1::vector
      LIMIT 5`,
    [q],
  );

  console.log('nearest memories to the "Q3 revenue" vector (distance ascending):');
  for (const r of res.rows) {
    console.log(`  ${r.distance.toFixed(4)}  [${r.zone}/s${r.sensitivity_level}]  ${r.statement}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
