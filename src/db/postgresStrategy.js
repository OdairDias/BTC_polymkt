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
      strategy_key TEXT NOT NULL DEFAULT 'default',
      market_slug TEXT NOT NULL,
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
      dry_run BOOLEAN NOT NULL DEFAULT true,
      UNIQUE(strategy_key, market_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_paper_signals_created
      ON strategy_paper_signals (created_at DESC);

    CREATE TABLE IF NOT EXISTS strategy_paper_outcomes (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entry_id BIGINT NOT NULL REFERENCES strategy_paper_signals(id) ON DELETE CASCADE,
      strategy_key TEXT NOT NULL DEFAULT 'default',
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
      official_winner TEXT,
      outcome_code TEXT NOT NULL,
      official_resolution_status TEXT,
      official_resolution_source TEXT,
      official_resolved_at TIMESTAMPTZ,
      official_outcome_prices_json JSONB,
      official_price_to_beat NUMERIC,
      official_price_at_close NUMERIC,
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
      strategy_key TEXT NOT NULL DEFAULT 'default',
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

    ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_winner TEXT;
    ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_resolution_status TEXT;
    ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_resolution_source TEXT;
    ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_resolved_at TIMESTAMPTZ;
    ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_outcome_prices_json JSONB;
    ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_price_to_beat NUMERIC;
    ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_price_at_close NUMERIC;
    ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS strategy_key TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS strategy_key TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE strategy_live_orders ADD COLUMN IF NOT EXISTS strategy_key TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE strategy_paper_signals DROP CONSTRAINT IF EXISTS strategy_paper_signals_market_slug_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_paper_signals_strategy_slug
      ON strategy_paper_signals(strategy_key, market_slug);
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
 * EstatÃ­sticas de risco a partir de outcomes fechados.
 * Usa janela rolante (em horas) + streak de perdas consecutivas mais recentes.
 */
export async function fetchOutcomeRiskStats(client, { strategyKey = "default", rollingHours = 24, streakSampleSize = 200 } = {}) {
  const safeRollingHours = Math.max(1, Number(rollingHours) || 24);
  const safeSample = Math.max(20, Math.floor(Number(streakSampleSize) || 200));
  const key = String(strategyKey || "default");

  const rollingRes = await client.query(
    `SELECT COALESCE(SUM(pnl_simulated_usd), 0)::float8 AS rolling_pnl
     FROM strategy_paper_outcomes
     WHERE entry_correct IS NOT NULL
       AND strategy_key = $2
       AND created_at >= NOW() - ($1::text || ' hours')::interval`,
    [String(safeRollingHours), key]
  );

  const streakRes = await client.query(
    `SELECT entry_correct
     FROM strategy_paper_outcomes
     WHERE entry_correct IS NOT NULL
       AND strategy_key = $2
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeSample, key]
  );

  let consecutiveLosses = 0;
  for (const row of streakRes.rows) {
    if (row.entry_correct === false) {
      consecutiveLosses += 1;
      continue;
    }
    break;
  }

  return {
    rollingPnlUsd: Number(rollingRes.rows?.[0]?.rolling_pnl ?? 0),
    consecutiveLosses,
    observedOutcomes: streakRes.rowCount
  };
}

/**
 * Uma linha por mercado (UNIQUE market_slug). Retorna { inserted: boolean, id? }
 */
export async function insertPaperSignal(client, row) {
  const res = await client.query(
    `INSERT INTO strategy_paper_signals (
      strategy_key, market_slug, condition_id, market_end_at, minutes_left,
      up_mid, down_mid, up_buy, down_buy,
      up_best_bid, up_best_ask, down_best_bid, down_best_ask,
      result_code, chosen_side, notional_usd, entry_price, simulated_shares, dry_run
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
    )
    ON CONFLICT (strategy_key, market_slug) DO NOTHING
    RETURNING id`,
    [
      row.strategy_key ?? "default",
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

export async function updatePaperSignalExecution(client, row) {
  const res = await client.query(
    `UPDATE strategy_paper_signals
     SET
       result_code = COALESCE($2, result_code),
       chosen_side = $3,
       entry_price = $4,
       simulated_shares = $5,
       up_buy = COALESCE($6, up_buy),
       down_buy = COALESCE($7, down_buy),
       up_mid = COALESCE($8, up_mid),
       down_mid = COALESCE($9, down_mid),
       up_best_bid = COALESCE($10, up_best_bid),
       up_best_ask = COALESCE($11, up_best_ask),
       down_best_bid = COALESCE($12, down_best_bid),
       down_best_ask = COALESCE($13, down_best_ask)
     WHERE id = $1
     RETURNING id`,
    [
      row.id,
      row.result_code ?? null,
      row.chosen_side ?? null,
      row.entry_price ?? null,
      row.simulated_shares ?? null,
      row.up_buy ?? null,
      row.down_buy ?? null,
      row.up_mid ?? null,
      row.down_mid ?? null,
      row.up_best_bid ?? null,
      row.up_best_ask ?? null,
      row.down_best_bid ?? null,
      row.down_best_ask ?? null
    ]
  );
  return { updated: res.rowCount > 0 };
}

export async function insertLiveOrder(client, row) {
  await client.query(
    `INSERT INTO strategy_live_orders (
      entry_id, strategy_key, market_slug, token_id, side, limit_price, size_shares, notional_usd,
      clob_order_id, status, error_message, raw_response
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    ON CONFLICT (entry_id) DO NOTHING`,
    [
      row.entry_id,
      row.strategy_key ?? "default",
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
    `SELECT id, strategy_key, market_slug, chosen_side, entry_price, notional_usd, result_code, dry_run
     FROM strategy_paper_signals WHERE market_slug = $1 ORDER BY created_at DESC LIMIT 1`,
    [marketSlug]
  );
  return res.rows[0] ?? null;
}

export async function findPendingPaperEntries(client, limit = 20) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 20));
  const res = await client.query(
    `SELECT
       s.id,
       s.strategy_key,
       s.market_slug,
       s.chosen_side,
       s.entry_price,
       s.notional_usd,
       s.market_end_at
     FROM strategy_paper_signals s
     LEFT JOIN strategy_paper_outcomes o ON o.entry_id = s.id
     WHERE o.entry_id IS NULL
       AND s.market_end_at IS NOT NULL
       AND s.market_end_at <= NOW()
       AND s.market_end_at >= NOW() - interval '48 hours'
     ORDER BY s.market_end_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return res.rows ?? [];
}

export async function insertPaperOutcome(client, row) {
  const res = await client.query(
    `INSERT INTO strategy_paper_outcomes (
      entry_id, strategy_key, market_slug, seconds_left_at_eval, evaluation_method,
      up_mid, down_mid, up_best_bid, up_best_ask, down_best_bid, down_best_ask,
      inferred_winner, official_winner, outcome_code, official_resolution_status, official_resolution_source,
      official_resolved_at, official_outcome_prices_json, official_price_to_beat, official_price_at_close,
      entry_chosen_side, entry_correct, pnl_simulated_usd, dry_run
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24)
    ON CONFLICT (entry_id) DO NOTHING
    RETURNING id`,
    [
      row.entry_id,
      row.strategy_key ?? "default",
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
      row.official_winner ?? null,
      row.outcome_code,
      row.official_resolution_status ?? null,
      row.official_resolution_source ?? null,
      row.official_resolved_at ?? null,
      row.official_outcome_prices_json != null ? JSON.stringify(row.official_outcome_prices_json) : null,
      row.official_price_to_beat ?? null,
      row.official_price_at_close ?? null,
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

export async function getStrategyPerformanceReport(client) {
  const res = await client.query(`
    SELECT
      strategy_key,
      COUNT(*) as total_entries,
      SUM(CASE WHEN entry_correct = true THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN entry_correct = false THEN 1 ELSE 0 END) as losses,
      SUM(COALESCE(pnl_simulated_usd, 0)) as total_pnl
    FROM strategy_paper_outcomes
    WHERE entry_correct IS NOT NULL
      AND evaluation_method = 'gamma_resolved'
      AND strategy_key != 'default'
    GROUP BY strategy_key
    ORDER BY total_pnl DESC
  `);
  
  return res.rows.map(r => ({
    strategy: r.strategy_key,
    entries: Number(r.total_entries),
    wins: Number(r.wins),
    losses: Number(r.losses),
    pnl: Number(r.total_pnl)
  }));
}
