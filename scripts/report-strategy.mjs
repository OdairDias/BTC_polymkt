import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

function parseArgs(argv) {
  const out = {
    hours: 24,
    strategy: null,
    json: false
  };

  for (const arg of argv) {
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg.startsWith("--hours=")) {
      const n = Number(arg.slice("--hours=".length));
      if (Number.isFinite(n) && n > 0) out.hours = Math.max(1, Math.floor(n));
      continue;
    }
    if (arg.startsWith("--strategy=")) {
      const key = String(arg.slice("--strategy=".length)).trim();
      out.strategy = key || null;
      continue;
    }
  }

  return out;
}

function fmtNumber(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

function fmtMoney(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(digits)}`;
}

function fmtPct01(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(digits)}%`;
}

function normalizeCell(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  return String(value);
}

function printTable({ title, rows, columns }) {
  if (title) {
    console.log(`\n=== ${title} ===`);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("(sem dados)");
    return;
  }

  const widths = columns.map((col) => {
    const headerWidth = col.label.length;
    const cellWidth = rows.reduce((max, row) => {
      const raw = typeof col.render === "function" ? col.render(row) : row[col.key];
      const text = normalizeCell(raw);
      return Math.max(max, text.length);
    }, 0);
    return Math.max(headerWidth, cellWidth);
  });

  const header = columns.map((col, i) => col.label.padEnd(widths[i])).join(" | ");
  const sep = columns.map((_, i) => "-".repeat(widths[i])).join("-+-");
  console.log(header);
  console.log(sep);

  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const raw = typeof col.render === "function" ? col.render(row) : row[col.key];
        const text = normalizeCell(raw);
        return text.padEnd(widths[i]);
      })
      .join(" | ");
    console.log(line);
  }
}

async function safeQuery(client, sql, params = []) {
  try {
    const res = await client.query(sql, params);
    return { ok: true, rows: res.rows };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), rows: [] };
  }
}

function intervalLabel(hours) {
  return `ultimas ${hours}h`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL || "";

  if (!databaseUrl) {
    console.error("ERRO: DATABASE_URL ausente.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 10_000
  });

  const client = await pool.connect();
  try {
    const hours = String(args.hours);
    const strategyFilter = args.strategy;

    const summaryRes = await safeQuery(
      client,
      `
      SELECT
        o.strategy_key,
        COUNT(*)::int AS outcomes_total,
        COUNT(*) FILTER (WHERE o.entry_correct IS NOT NULL)::int AS scored_trades,
        AVG(o.pnl_simulated_usd) FILTER (WHERE o.pnl_simulated_usd IS NOT NULL)::float8 AS ev_per_trade,
        SUM(o.pnl_simulated_usd) FILTER (WHERE o.pnl_simulated_usd IS NOT NULL)::float8 AS total_pnl,
        AVG(
          CASE
            WHEN o.entry_correct IS TRUE THEN 1.0
            WHEN o.entry_correct IS FALSE THEN 0.0
            ELSE NULL
          END
        )::float8 AS hit_rate,
        SUM(CASE WHEN o.exit_reason = 'TAKE_PROFIT' THEN 1 ELSE 0 END)::int AS exits_take_profit,
        SUM(CASE WHEN o.exit_reason = 'GROSS_PROFIT' THEN 1 ELSE 0 END)::int AS exits_gross_profit,
        SUM(CASE WHEN o.exit_reason = 'TIME_STOP' THEN 1 ELSE 0 END)::int AS exits_time_stop
      FROM strategy_paper_outcomes o
      WHERE o.created_at >= NOW() - ($1::text || ' hours')::interval
        AND ($2::text IS NULL OR o.strategy_key = $2)
      GROUP BY o.strategy_key
      ORDER BY total_pnl DESC NULLS LAST
      `,
      [hours, strategyFilter]
    );

    const brierRes = await safeQuery(
      client,
      `
      WITH scored AS (
        SELECT
          s.strategy_key,
          COALESCE(
            s.selected_model_prob,
            CASE
              WHEN s.chosen_side = 'UP' THEN s.model_prob_up
              WHEN s.chosen_side = 'DOWN' AND s.model_prob_up IS NOT NULL THEN 1 - s.model_prob_up
              ELSE NULL
            END
          )::float8 AS predicted_prob,
          CASE
            WHEN o.entry_correct IS TRUE THEN 1.0
            WHEN o.entry_correct IS FALSE THEN 0.0
            ELSE NULL
          END::float8 AS y
        FROM strategy_paper_signals s
        JOIN strategy_paper_outcomes o ON o.entry_id = s.id
        WHERE s.created_at >= NOW() - ($1::text || ' hours')::interval
          AND ($2::text IS NULL OR s.strategy_key = $2)
      )
      SELECT
        strategy_key,
        COUNT(*)::int AS trades,
        AVG(POWER(predicted_prob - y, 2))::float8 AS brier_score,
        AVG(predicted_prob)::float8 AS avg_predicted_prob,
        AVG(y)::float8 AS realized_win_rate
      FROM scored
      WHERE predicted_prob IS NOT NULL AND y IS NOT NULL
      GROUP BY strategy_key
      ORDER BY brier_score ASC
      `,
      [hours, strategyFilter]
    );

    const edgeDecilesRes = await safeQuery(
      client,
      `
      WITH base AS (
        SELECT
          s.strategy_key,
          COALESCE(
            s.selected_edge,
            CASE
              WHEN s.chosen_side = 'UP' THEN s.edge_up
              WHEN s.chosen_side = 'DOWN' AND s.edge_up IS NOT NULL THEN -s.edge_up
              ELSE NULL
            END
          )::float8 AS edge_value,
          o.pnl_simulated_usd::float8 AS pnl,
          CASE
            WHEN o.entry_correct IS TRUE THEN 1.0
            WHEN o.entry_correct IS FALSE THEN 0.0
            ELSE NULL
          END::float8 AS hit
        FROM strategy_paper_signals s
        JOIN strategy_paper_outcomes o ON o.entry_id = s.id
        WHERE s.created_at >= NOW() - ($1::text || ' hours')::interval
          AND ($2::text IS NULL OR s.strategy_key = $2)
      ),
      ranked AS (
        SELECT
          strategy_key,
          edge_value,
          pnl,
          hit,
          NTILE(10) OVER (PARTITION BY strategy_key ORDER BY edge_value DESC) AS decile
        FROM base
        WHERE edge_value IS NOT NULL AND pnl IS NOT NULL
      )
      SELECT
        strategy_key,
        decile,
        COUNT(*)::int AS trades,
        AVG(edge_value)::float8 AS avg_edge,
        AVG(pnl)::float8 AS avg_pnl,
        AVG(hit)::float8 AS hit_rate
      FROM ranked
      GROUP BY strategy_key, decile
      ORDER BY strategy_key, decile
      `,
      [hours, strategyFilter]
    );

    const skipReasonsRes = await safeQuery(
      client,
      `
      SELECT
        s.strategy_key,
        s.result_code,
        COUNT(*)::int AS qty
      FROM strategy_paper_signals s
      WHERE s.created_at >= NOW() - ($1::text || ' hours')::interval
        AND s.result_code LIKE 'SKIP%'
        AND ($2::text IS NULL OR s.strategy_key = $2)
      GROUP BY s.strategy_key, s.result_code
      ORDER BY qty DESC
      LIMIT 30
      `,
      [hours, strategyFilter]
    );

    const liveRes = await safeQuery(
      client,
      `
      WITH base AS (
        SELECT
          s.strategy_key,
          s.id AS entry_id,
          s.entry_price::float8 AS paper_entry_price,
          l.status AS live_entry_status,
          l.limit_price::float8 AS live_entry_price,
          ex.status AS live_exit_status,
          ex.exit_price::float8 AS live_exit_price,
          ex.size_shares::float8 AS live_exit_shares,
          ex.notional_usd::float8 AS live_exit_notional
        FROM strategy_paper_signals s
        LEFT JOIN strategy_live_orders l
          ON l.entry_id = s.id
         AND l.side = 'BUY'
        LEFT JOIN LATERAL (
          SELECT e.*
          FROM strategy_live_exits e
          WHERE e.entry_id = s.id
          ORDER BY e.created_at DESC
          LIMIT 1
        ) ex ON TRUE
        WHERE s.created_at >= NOW() - ($1::text || ' hours')::interval
          AND ($2::text IS NULL OR s.strategy_key = $2)
      )
      SELECT
        strategy_key,
        COUNT(*)::int AS paper_signals,
        COUNT(*) FILTER (WHERE live_entry_status IS NOT NULL)::int AS live_entries_seen,
        COUNT(*) FILTER (WHERE live_entry_status = 'SUBMITTED')::int AS live_entries_submitted,
        COUNT(*) FILTER (WHERE live_entry_status = 'ERROR')::int AS live_entries_error,
        AVG((live_entry_price - paper_entry_price)) FILTER (
          WHERE paper_entry_price IS NOT NULL AND live_entry_price IS NOT NULL
        )::float8 AS avg_entry_slippage_abs,
        AVG((live_entry_price - paper_entry_price) / NULLIF(paper_entry_price, 0)) FILTER (
          WHERE paper_entry_price IS NOT NULL AND live_entry_price IS NOT NULL
        )::float8 AS avg_entry_slippage_pct,
        COUNT(*) FILTER (WHERE live_exit_status = 'EXECUTED')::int AS live_exits_executed,
        AVG((live_exit_price * live_exit_shares) - live_exit_notional) FILTER (
          WHERE live_exit_status = 'EXECUTED'
            AND live_exit_price IS NOT NULL
            AND live_exit_shares IS NOT NULL
            AND live_exit_notional IS NOT NULL
        )::float8 AS avg_live_realized_pnl,
        SUM((live_exit_price * live_exit_shares) - live_exit_notional) FILTER (
          WHERE live_exit_status = 'EXECUTED'
            AND live_exit_price IS NOT NULL
            AND live_exit_shares IS NOT NULL
            AND live_exit_notional IS NOT NULL
        )::float8 AS total_live_realized_pnl
      FROM base
      GROUP BY strategy_key
      ORDER BY strategy_key
      `,
      [hours, strategyFilter]
    );

    const payload = {
      meta: {
        window_hours: args.hours,
        strategy_filter: strategyFilter,
        generated_at: new Date().toISOString()
      },
      summary: summaryRes.rows,
      brier: brierRes.rows,
      edge_deciles: edgeDecilesRes.rows,
      skip_reasons: skipReasonsRes.rows,
      paper_vs_live: liveRes.rows,
      errors: {
        summary: summaryRes.ok ? null : summaryRes.error,
        brier: brierRes.ok ? null : brierRes.error,
        edge_deciles: edgeDecilesRes.ok ? null : edgeDecilesRes.error,
        skip_reasons: skipReasonsRes.ok ? null : skipReasonsRes.error,
        paper_vs_live: liveRes.ok ? null : liveRes.error
      }
    };

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log("Relatorio de estrategia Polymarket");
    console.log(`Janela: ${intervalLabel(args.hours)}`);
    console.log(`Filtro de estrategia: ${strategyFilter ?? "todas"}`);

    if (!summaryRes.ok) {
      console.log(`\n[WARN] Falha no resumo: ${summaryRes.error}`);
    } else {
      printTable({
        title: "Resumo Geral",
        rows: summaryRes.rows,
        columns: [
          { key: "strategy_key", label: "strategy" },
          { key: "scored_trades", label: "trades" },
          { key: "hit_rate", label: "hit_rate", render: (r) => fmtPct01(r.hit_rate, 2) },
          { key: "ev_per_trade", label: "ev_trade", render: (r) => fmtMoney(r.ev_per_trade, 4) },
          { key: "total_pnl", label: "total_pnl", render: (r) => fmtMoney(r.total_pnl, 4) },
          { key: "exits_take_profit", label: "tp" },
          { key: "exits_gross_profit", label: "gross" },
          { key: "exits_time_stop", label: "time" }
        ]
      });
    }

    if (!brierRes.ok) {
      console.log(`\n[WARN] Falha no Brier: ${brierRes.error}`);
    } else {
      printTable({
        title: "Calibracao (Brier)",
        rows: brierRes.rows,
        columns: [
          { key: "strategy_key", label: "strategy" },
          { key: "trades", label: "trades" },
          { key: "brier_score", label: "brier", render: (r) => fmtNumber(r.brier_score, 6) },
          { key: "avg_predicted_prob", label: "avg_pred", render: (r) => fmtPct01(r.avg_predicted_prob, 2) },
          { key: "realized_win_rate", label: "realized", render: (r) => fmtPct01(r.realized_win_rate, 2) }
        ]
      });
    }

    if (!edgeDecilesRes.ok) {
      console.log(`\n[WARN] Falha no decil de edge: ${edgeDecilesRes.error}`);
    } else {
      printTable({
        title: "Decis de Edge (1=maior edge)",
        rows: edgeDecilesRes.rows,
        columns: [
          { key: "strategy_key", label: "strategy" },
          { key: "decile", label: "decil" },
          { key: "trades", label: "trades" },
          { key: "avg_edge", label: "avg_edge", render: (r) => fmtNumber(r.avg_edge, 5) },
          { key: "avg_pnl", label: "avg_pnl", render: (r) => fmtMoney(r.avg_pnl, 5) },
          { key: "hit_rate", label: "hit_rate", render: (r) => fmtPct01(r.hit_rate, 2) }
        ]
      });
    }

    if (!skipReasonsRes.ok) {
      console.log(`\n[WARN] Falha nos SKIPs: ${skipReasonsRes.error}`);
    } else {
      printTable({
        title: "Top SKIP reasons",
        rows: skipReasonsRes.rows,
        columns: [
          { key: "strategy_key", label: "strategy" },
          { key: "result_code", label: "result_code" },
          { key: "qty", label: "qty" }
        ]
      });
    }

    if (!liveRes.ok) {
      console.log(`\n[WARN] Falha no comparativo paper/live: ${liveRes.error}`);
    } else {
      printTable({
        title: "Paper vs Live",
        rows: liveRes.rows,
        columns: [
          { key: "strategy_key", label: "strategy" },
          { key: "paper_signals", label: "signals" },
          { key: "live_entries_seen", label: "live_seen" },
          { key: "live_entries_submitted", label: "submitted" },
          { key: "live_entries_error", label: "entry_err" },
          { key: "avg_entry_slippage_abs", label: "slip_abs", render: (r) => fmtNumber(r.avg_entry_slippage_abs, 5) },
          { key: "avg_entry_slippage_pct", label: "slip_pct", render: (r) => fmtPct01(r.avg_entry_slippage_pct, 3) },
          { key: "live_exits_executed", label: "exits" },
          { key: "avg_live_realized_pnl", label: "avg_live_pnl", render: (r) => fmtMoney(r.avg_live_realized_pnl, 5) },
          { key: "total_live_realized_pnl", label: "tot_live_pnl", render: (r) => fmtMoney(r.total_live_realized_pnl, 5) }
        ]
      });
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});

