/**
 * Issue #7 — the DRIFT GUARD that makes "Drizzle MUST MATCH the migrated columns exactly" mechanical, not
 * eyeballed. Raw SQL in /migrations is the SOURCE OF TRUTH; packages/core/src/db/schema.ts MIRRORS it. This
 * test applies every migration to a fresh pglite DB, introspects information_schema, and asserts that for
 * every table the Drizzle definition and the migrated columns agree on:
 *   • the exact SET of columns (no column in one but not the other),
 *   • nullability (Drizzle .notNull ⇔ is_nullable='NO'),
 *   • the column TYPE family (text/jsonb/uuid/timestamptz/vector/…).
 * Plus: the set of public tables in the DB equals the set defined in schema.ts (a migration adding a table
 * that schema.ts forgot — or vice versa — turns this red).
 *
 * A future migration that adds a column without mirroring it here (or a typo'd type) fails CI immediately.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { freshDb, type Query } from './helpers/pglite.ts';
import { schema } from '../../packages/core/src/db/schema.ts';

interface DbCol {
  name: string;
  nullable: boolean;
  family: string;
}

/** Collapse Postgres' reported type onto a coarse family so the two sides compare portably. */
function pgFamily(dataType: string, udtName: string): string {
  if (dataType === 'USER-DEFINED') return udtName === 'vector' ? 'vector' : udtName;
  if (dataType === 'ARRAY') return udtName === '_text' ? 'text[]' : `${udtName}[]`;
  switch (dataType) {
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'double precision':
      return 'double';
    case 'character varying':
      return 'text';
    case 'bigint':
      return 'bigint';
    default:
      return dataType; // text, jsonb, integer, smallint, boolean, uuid pass through
  }
}

/** Same collapse for Drizzle's getSQLType() output. */
function drizzleFamily(sqlType: string): string {
  const t = sqlType.toLowerCase();
  if (t.startsWith('vector')) return 'vector';
  if (t === 'timestamp with time zone') return 'timestamptz';
  if (t === 'double precision') return 'double';
  if (t === 'text[]') return 'text[]';
  if (t === 'bigserial') return 'bigint';
  return t; // text, jsonb, integer, smallint, boolean, uuid
}

async function dbColumns(query: Query, table: string): Promise<Map<string, DbCol>> {
  const res = await query(
    `SELECT column_name, is_nullable, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const map = new Map<string, DbCol>();
  for (const r of res.rows) {
    map.set(r.column_name, {
      name: r.column_name,
      nullable: r.is_nullable === 'YES',
      family: pgFamily(r.data_type, r.udt_name),
    });
  }
  return map;
}

describe('schema drift: Drizzle schema.ts mirrors the migrated DB exactly (#7)', () => {
  it('every public table in the migrated DB is defined in schema.ts, and vice versa', async () => {
    const { query } = await freshDb();
    const res = await query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const dbTables = new Set<string>(res.rows.map((r) => r.table_name));
    const drizzleTables = new Set<string>(
      Object.values(schema).map((t) => getTableConfig(t as PgTable).name),
    );
    expect([...drizzleTables].sort()).toEqual([...dbTables].sort());
  });

  it.each(Object.entries(schema))('table %s matches column-for-column', async (_key, table) => {
    const { query } = await freshDb();
    const { name, columns } = getTableConfig(table as PgTable);
    const dbCols = await dbColumns(query, name);

    // Column-name set equality — the core 1:1 guarantee (catches a column on one side but not the other).
    const drizzleNames = columns.map((c) => c.name).sort();
    expect(drizzleNames, `${name}: column names`).toEqual([...dbCols.keys()].sort());

    // Per-column nullability + type family.
    for (const col of columns) {
      const db = dbCols.get(col.name)!;
      expect(col.notNull, `${name}.${col.name}: notNull (drizzle) ⇔ NOT NULL (db)`).toBe(!db.nullable);
      expect(drizzleFamily(col.getSQLType()), `${name}.${col.name}: type family`).toBe(db.family);
    }
  });
});
