import pg from "pg";
import { ensureExitShadowSchema } from "../src/db/postgresStrategy.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || process.env.STRATEGY_DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL/STRATEGY_DATABASE_URL ausente");

const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await ensureExitShadowSchema(client);
  await client.query("COMMIT");
  const { rows } = await pool.query(
    `SELECT to_regclass('public.strategy_exit_shadow_snapshots')::text AS table_name`
  );
  console.log(JSON.stringify({ migration: "ok", table: rows[0]?.table_name || null }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
