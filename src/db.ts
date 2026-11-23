import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(here, "..", "db", "schema.sql");

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function makePool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 8 });
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = readFileSync(SCHEMA, "utf8");
  await pool.query(sql);
}

/** Run fn inside a single transaction; rolls back on any throw. */
export async function inTx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
