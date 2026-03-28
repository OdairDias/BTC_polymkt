import pg from "pg";

const { Pool } = pg;

let pool = null;

export function getStrategyPool(databaseUrl) {
  if (!databaseUrl) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }
  return pool;
}

export async function closeStrategyPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function ensureStrategySchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS strategy_paper_signals (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      market_slug TEXT NOT NULL UNIQUE,
      condition_id TEXT,
      market_end_at TIMESTAMPTZ,
      minutes_left NUMERIC NOT NULL,
      up_mid NUMERIC,
      down_mid NUMERIC,
      up_buy NUMERIC,
      down_buy NUMERIC,
      up_best_bid NUMERIC,
      up_best_ask NUMERIC,
      down_best_bid NUMERIC,
      down_best_ask NUMERIC,
      result_code TEXT NOT NULL,
      chosen_side TEXT,
      notional_usd NUMERIC NOT NULL DEFAULT 1,
      entry_price NUMERIC,
      simulated_shares NUMERIC,
      dry_run BOOLEAN NOT NULL DEFAULT true
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_paper_signals_created
      ON strategy_paper_signals (created_at DESC);
  `);
}

/**
 * Uma linha por mercado (UNIQUE market_slug). Retorna { inserted: boolean, id? }
 */
export async function insertPaperSignal(client, row) {
  const res = await client.query(
    `INSERT INTO strategy_paper_signals (
      market_slug, condition_id, market_end_at, minutes_left,
      up_mid, down_mid, up_buy, down_buy,
      up_best_bid, up_best_ask, down_best_bid, down_best_ask,
      result_code, chosen_side, notional_usd, entry_price, simulated_shares, dry_run
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
    )
    ON CONFLICT (market_slug) DO NOTHING
    RETURNING id`,
    [
      row.market_slug,
      row.condition_id ?? null,
      row.market_end_at ?? null,
      row.minutes_left,
      row.up_mid ?? null,
      row.down_mid ?? null,
      row.up_buy ?? null,
      row.down_buy ?? null,
      row.up_best_bid ?? null,
      row.up_best_ask ?? null,
      row.down_best_bid ?? null,
      row.down_best_ask ?? null,
      row.result_code,
      row.chosen_side ?? null,
      row.notional_usd,
      row.entry_price ?? null,
      row.simulated_shares ?? null,
      row.dry_run
    ]
  );
  if (res.rowCount > 0 && res.rows[0]?.id != null) {
    return { inserted: true, id: res.rows[0].id };
  }
  return { inserted: false };
}
