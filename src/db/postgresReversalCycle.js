const initializedUrls = new Set();

function safeJson(value) {
  return value != null ? JSON.stringify(value) : null;
}

export async function ensureReversalCycleSchemaOnce(pool) {
  const key = String(pool?.options?.connectionString || "default");
  if (initializedUrls.has(key)) return;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS strategy_paper_cycles (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        strategy_key TEXT NOT NULL,
        market_slug TEXT NOT NULL,
        signal_entry_id BIGINT REFERENCES strategy_paper_signals(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        max_steps INTEGER NOT NULL DEFAULT 1,
        active_side TEXT,
        base_notional_usd NUMERIC NOT NULL,
        accumulated_realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
        target_profit_usd NUMERIC NOT NULL DEFAULT 0,
        stop_loss_delta NUMERIC NOT NULL,
        take_profit_delta NUMERIC NOT NULL,
        max_notional_usd NUMERIC,
        force_exit_minutes_left NUMERIC,
        cycle_context_json JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_paper_cycles_strategy_status
        ON strategy_paper_cycles(strategy_key, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_strategy_paper_cycles_market
        ON strategy_paper_cycles(strategy_key, market_slug, created_at DESC);

      CREATE TABLE IF NOT EXISTS strategy_paper_cycle_legs (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at TIMESTAMPTZ,
        cycle_id BIGINT NOT NULL REFERENCES strategy_paper_cycles(id) ON DELETE CASCADE,
        step INTEGER NOT NULL,
        side TEXT NOT NULL,
        entry_price NUMERIC NOT NULL,
        exit_price NUMERIC,
        notional_usd NUMERIC NOT NULL,
        shares NUMERIC NOT NULL,
        stop_price NUMERIC NOT NULL,
        take_profit_price NUMERIC NOT NULL,
        status TEXT NOT NULL,
        exit_reason TEXT,
        realized_pnl_usd NUMERIC,
        parent_leg_id BIGINT REFERENCES strategy_paper_cycle_legs(id) ON DELETE SET NULL,
        entry_context_json JSONB,
        exit_context_json JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_paper_cycle_legs_cycle_step
        ON strategy_paper_cycle_legs(cycle_id, step);

      CREATE INDEX IF NOT EXISTS idx_strategy_paper_cycle_legs_cycle_status
        ON strategy_paper_cycle_legs(cycle_id, status, created_at DESC);
    `);
    initializedUrls.add(key);
  } finally {
    client.release();
  }
}

export async function findActivePaperCycle(client, { strategyKey = "default" }) {
  const res = await client.query(
    `SELECT
       c.id AS cycle_id,
       c.created_at,
       c.updated_at,
       c.strategy_key,
       c.market_slug,
       c.signal_entry_id,
       c.status AS cycle_status,
       c.current_step,
       c.max_steps,
       c.active_side,
       c.base_notional_usd,
       c.accumulated_realized_pnl_usd,
       c.target_profit_usd,
       c.stop_loss_delta,
       c.take_profit_delta,
       c.max_notional_usd,
       c.force_exit_minutes_left,
       c.cycle_context_json,
       l.id AS leg_id,
       l.step AS leg_step,
       l.side AS leg_side,
       l.entry_price AS leg_entry_price,
       l.notional_usd AS leg_notional_usd,
       l.shares AS leg_shares,
       l.stop_price AS leg_stop_price,
       l.take_profit_price AS leg_take_profit_price,
       l.parent_leg_id,
       l.entry_context_json AS leg_entry_context_json
     FROM strategy_paper_cycles c
     LEFT JOIN strategy_paper_cycle_legs l
       ON l.cycle_id = c.id
      AND l.status = 'OPEN'
     WHERE c.strategy_key = $1
       AND c.status = 'ACTIVE'
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [String(strategyKey || "default")]
  );
  return res.rows[0] ?? null;
}

export async function createPaperCycle(client, payload) {
  const res = await client.query(
    `INSERT INTO strategy_paper_cycles (
       strategy_key, market_slug, signal_entry_id, status, current_step, max_steps, active_side,
       base_notional_usd, accumulated_realized_pnl_usd, target_profit_usd,
       stop_loss_delta, take_profit_delta, max_notional_usd, force_exit_minutes_left, cycle_context_json
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb
     )
     RETURNING id`,
    [
      payload.strategy_key,
      payload.market_slug,
      payload.signal_entry_id ?? null,
      payload.status ?? 'ACTIVE',
      payload.current_step ?? 0,
      payload.max_steps,
      payload.active_side ?? null,
      payload.base_notional_usd,
      payload.accumulated_realized_pnl_usd ?? 0,
      payload.target_profit_usd ?? 0,
      payload.stop_loss_delta,
      payload.take_profit_delta,
      payload.max_notional_usd ?? null,
      payload.force_exit_minutes_left ?? null,
      safeJson(payload.cycle_context_json ?? null)
    ]
  );
  return res.rows[0]?.id ?? null;
}

export async function createPaperCycleLeg(client, payload) {
  const res = await client.query(
    `INSERT INTO strategy_paper_cycle_legs (
       cycle_id, step, side, entry_price, notional_usd, shares,
       stop_price, take_profit_price, status, parent_leg_id, entry_context_json
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb
     )
     RETURNING id`,
    [
      payload.cycle_id,
      payload.step,
      payload.side,
      payload.entry_price,
      payload.notional_usd,
      payload.shares,
      payload.stop_price,
      payload.take_profit_price,
      payload.status ?? 'OPEN',
      payload.parent_leg_id ?? null,
      safeJson(payload.entry_context_json ?? null)
    ]
  );

  const legId = res.rows[0]?.id ?? null;
  if (legId != null) {
    await client.query(
      `UPDATE strategy_paper_cycles
          SET updated_at = now(),
              current_step = $2,
              active_side = $3
        WHERE id = $1`,
      [payload.cycle_id, payload.step, payload.side]
    );
  }
  return legId;
}

export async function closePaperCycleLeg(client, payload) {
  const res = await client.query(
    `UPDATE strategy_paper_cycle_legs
        SET closed_at = now(),
            exit_price = $2,
            status = $3,
            exit_reason = $4,
            realized_pnl_usd = $5,
            exit_context_json = $6::jsonb
      WHERE id = $1
      RETURNING cycle_id`,
    [
      payload.leg_id,
      payload.exit_price ?? null,
      payload.status ?? 'CLOSED',
      payload.exit_reason ?? null,
      payload.realized_pnl_usd ?? null,
      safeJson(payload.exit_context_json ?? null)
    ]
  );

  const cycleId = res.rows[0]?.cycle_id ?? null;
  if (cycleId != null) {
    await client.query(
      `UPDATE strategy_paper_cycles
          SET updated_at = now(),
              accumulated_realized_pnl_usd = accumulated_realized_pnl_usd + $2,
              active_side = NULL
        WHERE id = $1`,
      [cycleId, Number(payload.realized_pnl_usd) || 0]
    );
  }
  return cycleId;
}

export async function markPaperCycleReversed(client, payload) {
  await client.query(
    `UPDATE strategy_paper_cycles
        SET updated_at = now(),
            current_step = $2,
            active_side = $3,
            status = 'ACTIVE'
      WHERE id = $1`,
    [payload.cycle_id, payload.current_step, payload.active_side]
  );
}

export async function completePaperCycle(client, payload) {
  await client.query(
    `UPDATE strategy_paper_cycles
        SET updated_at = now(),
            status = $2,
            active_side = NULL,
            cycle_context_json = COALESCE(cycle_context_json, '{}'::jsonb) || $3::jsonb
      WHERE id = $1`,
    [payload.cycle_id, payload.status, safeJson(payload.cycle_context_patch ?? {})]
  );
}
