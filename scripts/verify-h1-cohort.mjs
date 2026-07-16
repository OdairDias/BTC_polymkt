import pg from "pg";

const { Pool } = pg;
const strategyKey = process.env.H1_COHORT_KEY || "cheap_1h_exec_v2";
const databaseUrl = process.env.DATABASE_URL || process.env.STRATEGY_DATABASE_URL;

if (!databaseUrl) {
  console.error(JSON.stringify({ status: "error", error: "DATABASE_URL ausente" }));
  process.exit(2);
}

const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

try {
  const { rows } = await pool.query(
    `WITH entries AS (
       SELECT
         s.*,
         CASE WHEN s.chosen_side = 'UP' THEN s.up_best_ask ELSE s.down_best_ask END AS side_ask
       FROM strategy_paper_signals s
       WHERE s.strategy_key = $1
         AND s.result_code = 'ENTRY_SIMULATED'
     ), outcome_rollup AS (
       SELECT
         o.entry_id,
         COUNT(*) FILTER (WHERE o.is_final_exit) AS final_count,
         COALESCE(SUM(o.fraction_exited), 0) AS total_fraction,
         BOOL_OR(o.is_final_exit AND (ABS(COALESCE(o.remaining_shares, 0)) > 0.00000001 OR ABS(COALESCE(o.remaining_notional_usd, 0)) > 0.00000001)) AS final_has_remaining
       FROM strategy_paper_outcomes o
       JOIN entries e ON e.id = o.entry_id
       GROUP BY o.entry_id
     ), outcome_economics AS (
       SELECT
         COUNT(*) FILTER (WHERE o.entry_correct IS NOT NULL) AS priced_outcomes,
         COALESCE(SUM(o.gross_pnl_simulated_usd), 0) AS gross_pnl,
         COALESCE(SUM(o.total_fee_usd), 0) AS fees,
         COALESCE(SUM(o.pnl_simulated_usd), 0) AS net_pnl,
         COUNT(*) FILTER (
           WHERE o.pnl_simulated_usd IS NOT NULL
             AND (o.gross_pnl_simulated_usd IS NULL OR o.total_fee_usd IS NULL)
         ) AS missing_fee_accounting,
         COUNT(*) FILTER (
           WHERE o.pnl_simulated_usd IS NOT NULL
             AND ABS(o.pnl_simulated_usd - (o.gross_pnl_simulated_usd - o.total_fee_usd)) > 0.0000001
         ) AS pnl_accounting_violations,
         COUNT(*) FILTER (
           WHERE o.exited_early
             AND o.exit_price IS NOT NULL
             AND CASE
               WHEN e.chosen_side = 'UP' THEN o.up_best_bid IS NOT NULL AND o.exit_price > o.up_best_bid + 0.0000001
               ELSE o.down_best_bid IS NOT NULL AND o.exit_price > o.down_best_bid + 0.0000001
             END
         ) AS exit_above_bid
       FROM strategy_paper_outcomes o
       JOIN entries e ON e.id = o.entry_id
     )
     SELECT
       COUNT(*) AS entries,
       COUNT(*) FILTER (WHERE side_ask IS NULL) AS entries_missing_ask,
       COUNT(*) FILTER (WHERE side_ask IS NOT NULL AND entry_price < side_ask - 0.0000001) AS entries_below_ask,
       COUNT(*) FILTER (WHERE COALESCE(r.final_count, 0) = 0) AS open_entries,
       COUNT(*) FILTER (WHERE COALESCE(r.final_count, 0) > 1) AS duplicate_final_entries,
       COUNT(*) FILTER (WHERE COALESCE(r.total_fraction, 0) > 1.0000001) AS over_exited_entries,
       COUNT(*) FILTER (WHERE COALESCE(r.final_has_remaining, false)) AS final_with_remaining,
       COALESCE(MAX(x.priced_outcomes), 0) AS priced_outcomes,
       COALESCE(MAX(x.gross_pnl), 0) AS gross_pnl,
       COALESCE(MAX(x.fees), 0) AS fees,
       COALESCE(MAX(x.net_pnl), 0) AS net_pnl,
       COALESCE(MAX(x.missing_fee_accounting), 0) AS missing_fee_accounting,
       COALESCE(MAX(x.pnl_accounting_violations), 0) AS pnl_accounting_violations,
       COALESCE(MAX(x.exit_above_bid), 0) AS exit_above_bid,
       MIN(e.created_at) AS cohort_started_at,
       MAX(e.created_at) AS last_entry_at
     FROM entries e
     LEFT JOIN outcome_rollup r ON r.entry_id = e.id
     CROSS JOIN outcome_economics x`,
    [strategyKey]
  );

  const raw = rows[0] || {};
  const integerKeys = [
    "entries",
    "entries_missing_ask",
    "entries_below_ask",
    "open_entries",
    "duplicate_final_entries",
    "over_exited_entries",
    "final_with_remaining",
    "priced_outcomes",
    "missing_fee_accounting",
    "pnl_accounting_violations",
    "exit_above_bid"
  ];
  const numericKeys = ["gross_pnl", "fees", "net_pnl"];
  const report = { strategy_key: strategyKey };
  for (const key of integerKeys) report[key] = Number(raw[key] || 0);
  for (const key of numericKeys) report[key] = Number(raw[key] || 0);
  report.cohort_started_at = raw.cohort_started_at || null;
  report.last_entry_at = raw.last_entry_at || null;

  const violations = [
    "entries_missing_ask",
    "entries_below_ask",
    "duplicate_final_entries",
    "over_exited_entries",
    "final_with_remaining",
    "missing_fee_accounting",
    "pnl_accounting_violations",
    "exit_above_bid"
  ].filter((key) => report[key] > 0);

  report.status = violations.length ? "fail" : report.entries === 0 ? "awaiting_samples" : "pass";
  report.violations = violations;
  console.log(JSON.stringify(report, null, 2));
  if (violations.length) process.exitCode = 1;
} finally {
  await pool.end();
}
