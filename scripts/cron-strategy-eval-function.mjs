import pg from "pg";

const { Pool } = pg;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

function fmtMoney(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(digits)}`;
}

function fmtPct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(digits)}%`;
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL ausente");
  }

  const hours = toPositiveInt(process.env.REPORT_WINDOW_HOURS ?? "6", 6);
  const strategyKeyRaw = String(process.env.REPORT_STRATEGY_KEY ?? "").trim();
  const strategyKey = strategyKeyRaw.length ? strategyKeyRaw : null;
  const nowIso = new Date().toISOString();

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000
  });

  const client = await pool.connect();
  try {
    const summaryRes = await client.query(
      `
      WITH signals AS (
        SELECT
          COUNT(*) FILTER (WHERE chosen_side IN ('UP', 'DOWN'))::int AS entries,
          COUNT(*) FILTER (WHERE result_code LIKE 'SKIP%')::int AS skips
        FROM strategy_paper_signals
        WHERE created_at >= NOW() - ($1::text || ' hours')::interval
          AND ($2::text IS NULL OR strategy_key = $2)
      ),
      outcomes AS (
        SELECT
          COUNT(*)::int AS outcomes_total,
          COUNT(*) FILTER (WHERE entry_correct IS TRUE)::int AS wins,
          COUNT(*) FILTER (WHERE entry_correct IS FALSE)::int AS losses,
          AVG(pnl_simulated_usd)::float8 AS avg_pnl,
          SUM(pnl_simulated_usd)::float8 AS total_pnl,
          SUM(CASE WHEN exit_reason = 'TAKE_PROFIT' THEN 1 ELSE 0 END)::int AS exits_take_profit,
          SUM(CASE WHEN exit_reason = 'GROSS_PROFIT' THEN 1 ELSE 0 END)::int AS exits_gross_profit,
          SUM(CASE WHEN exit_reason = 'TIME_STOP' THEN 1 ELSE 0 END)::int AS exits_time_stop
        FROM strategy_paper_outcomes
        WHERE created_at >= NOW() - ($1::text || ' hours')::interval
          AND ($2::text IS NULL OR strategy_key = $2)
      ),
      live AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'SUBMITTED')::int AS live_submitted,
          COUNT(*) FILTER (WHERE status = 'ERROR')::int AS live_errors
        FROM strategy_live_orders
        WHERE created_at >= NOW() - ($1::text || ' hours')::interval
          AND ($2::text IS NULL OR strategy_key = $2)
      )
      SELECT
        s.entries,
        s.skips,
        o.outcomes_total,
        o.wins,
        o.losses,
        o.avg_pnl,
        o.total_pnl,
        o.exits_take_profit,
        o.exits_gross_profit,
        o.exits_time_stop,
        l.live_submitted,
        l.live_errors
      FROM signals s
      CROSS JOIN outcomes o
      CROSS JOIN live l
      `,
      [String(hours), strategyKey]
    );

    const skipsRes = await client.query(
      `
      SELECT
        result_code,
        COUNT(*)::int AS qty
      FROM strategy_paper_signals
      WHERE created_at >= NOW() - ($1::text || ' hours')::interval
        AND result_code LIKE 'SKIP%'
        AND ($2::text IS NULL OR strategy_key = $2)
      GROUP BY result_code
      ORDER BY qty DESC
      LIMIT 5
      `,
      [String(hours), strategyKey]
    );

    const row = summaryRes.rows[0] ?? {};
    const entries = Number(row.entries ?? 0);
    const outcomesTotal = Number(row.outcomes_total ?? 0);
    const wins = Number(row.wins ?? 0);
    const losses = Number(row.losses ?? 0);
    const hitRate = outcomesTotal > 0 ? wins / outcomesTotal : null;

    const payload = {
      type: "strategy_auto_eval",
      generated_at: nowIso,
      window_hours: hours,
      strategy_key: strategyKey ?? "ALL",
      summary: {
        entries,
        skips: Number(row.skips ?? 0),
        outcomes_total: outcomesTotal,
        wins,
        losses,
        hit_rate: hitRate,
        avg_pnl_usd: row.avg_pnl == null ? null : Number(row.avg_pnl),
        total_pnl_usd: row.total_pnl == null ? null : Number(row.total_pnl),
        exits_take_profit: Number(row.exits_take_profit ?? 0),
        exits_gross_profit: Number(row.exits_gross_profit ?? 0),
        exits_time_stop: Number(row.exits_time_stop ?? 0),
        live_submitted: Number(row.live_submitted ?? 0),
        live_errors: Number(row.live_errors ?? 0)
      },
      top_skip_reasons: skipsRes.rows.map((r) => ({
        code: r.result_code,
        qty: Number(r.qty ?? 0)
      }))
    };

    console.log("[AUTO-EVAL] " + JSON.stringify(payload));
    console.log(
      `[AUTO-EVAL] window=${hours}h strategy=${payload.strategy_key} entries=${entries} outcomes=${outcomesTotal} hit=${fmtPct(hitRate)} total_pnl=${fmtMoney(payload.summary.total_pnl_usd)} live_errors=${payload.summary.live_errors}`
    );

    if (entries === 0) {
      console.warn("[AUTO-EVAL][WARN] Nenhuma entrada no periodo.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[AUTO-EVAL][ERROR]", err?.message ?? String(err));
  process.exit(1);
});
