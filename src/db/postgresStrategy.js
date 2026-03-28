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

    CREATE TABLE IF NOT EXISTS strategy_paper_outcomes (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entry_id BIGINT NOT NULL REFERENCES strategy_paper_signals(id) ON DELETE CASCADE,
      market_slug TEXT NOT NULL,
      seconds_left_at_eval NUMERIC NOT NULL,
      evaluation_method TEXT NOT NULL DEFAULT 'last_5s_mid',
      up_mid NUMERIC,
      down_mid NUMERIC,
      up_best_bid NUMERIC,
      up_best_ask NUMERIC,
      down_best_bid NUMERIC,
      down_best_ask NUMERIC,
      inferred_winner TEXT,
      outcome_code TEXT NOT NULL,
      entry_chosen_side TEXT,
      entry_correct BOOLEAN,
      pnl_simulated_usd NUMERIC,
      dry_run BOOLEAN NOT NULL DEFAULT true,
      UNIQUE(entry_id)
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_paper_outcomes_slug
      ON strategy_paper_outcomes (market_slug);
    CREATE INDEX IF NOT EXISTS idx_strategy_paper_outcomes_created
      ON strategy_paper_outcomes (created_at DESC);

    CREATE TABLE IF NOT EXISTS strategy_live_orders (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entry_id BIGINT NOT NULL REFERENCES strategy_paper_signals(id) ON DELETE CASCADE,
      market_slug TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      limit_price NUMERIC,
      size_shares NUMERIC,
      notional_usd NUMERIC,
      clob_order_id TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      raw_response JSONB,
      UNIQUE(entry_id)
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_live_orders_created
      ON strategy_live_orders (created_at DESC);
  `);
}

let schemaReadyGlobal = false;

export async function ensureStrategySchemaOnce(pool) {
  if (schemaReadyGlobal) return;
  const c = await pool.connect();
  try {
    await ensureStrategySchema(c);
    schemaReadyGlobal = true;
  } finally {
    c.release();
  }
}

export function resetStrategySchemaFlag() {
  schemaReadyGlobal = false;
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

export async function insertLiveOrder(client, row) {
  await client.query(
    `INSERT INTO strategy_live_orders (
      entry_id, market_slug, token_id, side, limit_price, size_shares, notional_usd,
      clob_order_id, status, error_message, raw_response
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (entry_id) DO NOTHING`,
    [
      row.entry_id,
      row.market_slug,
      row.token_id,
      row.side,
      row.limit_price ?? null,
      row.size_shares ?? null,
      row.notional_usd ?? null,
      row.clob_order_id ?? null,
      row.status,
      row.error_message ?? null,
      row.raw_response != null ? JSON.stringify(row.raw_response) : null
    ]
  );
}

export async function findPaperEntryBySlug(client, marketSlug) {
  const res = await client.query(
    `SELECT id, market_slug, chosen_side, entry_price, notional_usd, result_code, dry_run
     FROM strategy_paper_signals WHERE market_slug = $1 LIMIT 1`,
    [marketSlug]
  );
  return res.rows[0] ?? null;
}

export async function insertPaperOutcome(client, row) {
  const res = await client.query(
    `INSERT INTO strategy_paper_outcomes (
      entry_id, market_slug, seconds_left_at_eval, evaluation_method,
      up_mid, down_mid, up_best_bid, up_best_ask, down_best_bid, down_best_ask,
      inferred_winner, outcome_code, entry_chosen_side, entry_correct, pnl_simulated_usd, dry_run
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (entry_id) DO NOTHING
    RETURNING id`,
    [
      row.entry_id,
      row.market_slug,
      row.seconds_left_at_eval,
      row.evaluation_method ?? "last_5s_mid",
      row.up_mid ?? null,
      row.down_mid ?? null,
      row.up_best_bid ?? null,
      row.up_best_ask ?? null,
      row.down_best_bid ?? null,
      row.down_best_ask ?? null,
      row.inferred_winner ?? null,
      row.outcome_code,
      row.entry_chosen_side ?? null,
      row.entry_correct ?? null,
      row.pnl_simulated_usd ?? null,
      row.dry_run
    ]
  );
  if (res.rowCount > 0 && res.rows[0]?.id != null) {
    return { inserted: true, id: res.rows[0].id };
  }
  return { inserted: false };
}
