import pg from "pg";
import {
  EXIT_SHADOW_EXPERIMENT_KEY,
  EXIT_SHADOW_EXECUTION_MODEL_VERSION,
  EXIT_SHADOW_POLICIES,
  computeExitShadowCoverage,
  evaluateExitShadowPolicyPath,
  summarizeExitShadowPnl
} from "../src/strategy/exitShadow.js";

const { Pool } = pg;
const strategyKey = process.env.H1_COHORT_KEY || "cheap_1h_exec_v2";
const databaseUrl = process.env.DATABASE_URL || process.env.STRATEGY_DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL/STRATEGY_DATABASE_URL ausente");

const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
try {
  const entriesResult = await pool.query(
    `SELECT
       s.id,
       s.created_at,
       COALESCE(SUM(o.pnl_simulated_usd), 0)::float8 AS baseline_pnl,
       BOOL_OR(o.is_final_exit) AS is_closed,
       MAX(o.created_at) FILTER (WHERE o.is_final_exit) AS final_exit_at
     FROM strategy_paper_signals s
     LEFT JOIN strategy_paper_outcomes o ON o.entry_id = s.id
     WHERE s.strategy_key = $1
       AND s.entry_price IS NOT NULL
     GROUP BY s.id, s.created_at
     ORDER BY s.created_at`,
    [strategyKey]
  );
  const snapshotsResult = await pool.query(
    `SELECT sh.*
     FROM strategy_exit_shadow_snapshots sh
     WHERE sh.strategy_key = $1
       AND sh.experiment_key = $2
     ORDER BY sh.entry_id, sh.observed_at`,
    [strategyKey, EXIT_SHADOW_EXPERIMENT_KEY]
  );

  const snapshotsByEntry = new Map();
  for (const row of snapshotsResult.rows) {
    const normalized = {
      ...row,
      seconds_left: row.seconds_left == null ? null : Number(row.seconds_left),
      bid_price: row.bid_price == null ? null : Number(row.bid_price),
      executable_bid_price: row.executable_bid_price == null ? null : Number(row.executable_bid_price),
      bid_depth_shares: row.bid_depth_shares == null ? null : Number(row.bid_depth_shares),
      initial_notional_usd: Number(row.initial_notional_usd),
      next_level_index: Number(row.next_level_index),
      next_target_price: row.next_target_price == null ? null : Number(row.next_target_price),
      total_net_pnl_if_exit_usd:
        row.total_net_pnl_if_exit_usd == null ? null : Number(row.total_net_pnl_if_exit_usd)
    };
    const list = snapshotsByEntry.get(String(row.entry_id)) || [];
    list.push(normalized);
    snapshotsByEntry.set(String(row.entry_id), list);
  }

  const entries = entriesResult.rows.map((row) => {
    const snapshots = snapshotsByEntry.get(String(row.id)) || [];
    const coverage = computeExitShadowCoverage({
      entryCreatedAt: row.created_at,
      finalExitAt: row.final_exit_at,
      snapshots,
      maxDelaySeconds: 45
    });
    return {
      id: String(row.id),
      baselinePnl: Number(row.baseline_pnl),
      isClosed: Boolean(row.is_closed),
      snapshots,
      firstDelaySeconds: coverage.firstDelaySeconds,
      maxGapSeconds: coverage.maxGapSeconds,
      finalCoverageDelaySeconds: coverage.finalCoverageDelaySeconds,
      coverageComplete: coverage.complete
    };
  });

  const coveredClosedEntries = entries.filter((entry) => entry.isClosed && entry.coverageComplete);
  const baselineMetrics = summarizeExitShadowPnl(coveredClosedEntries.map((entry) => entry.baselinePnl));
  const policies = EXIT_SHADOW_POLICIES.map((policy) => {
    const triggered = [];
    const counterfactualPnl = [];
    let evaluableEntries = 0;
    let leftCensoredEntries = 0;
    let nonEvaluableEntries = 0;
    let missingExecutableBidEntries = 0;
    let insufficientLiquidityEntries = 0;
    for (const entry of coveredClosedEntries) {
      const evaluation = evaluateExitShadowPolicyPath(policy, entry.snapshots);
      if (evaluation.missingExecutableBidSnapshots > 0) missingExecutableBidEntries += 1;
      if (evaluation.insufficientLiquiditySnapshots > 0) insufficientLiquidityEntries += 1;
      if (evaluation.status === "left_censored") {
        leftCensoredEntries += 1;
        continue;
      }
      if (evaluation.status === "non_evaluable") {
        nonEvaluableEntries += 1;
        continue;
      }
      evaluableEntries += 1;
      if (!evaluation.trigger) {
        counterfactualPnl.push(entry.baselinePnl);
        continue;
      }
      const snapshot = evaluation.trigger;
      const shadowPnl = Number(snapshot.total_net_pnl_if_exit_usd);
      counterfactualPnl.push(shadowPnl);
      triggered.push({
        entryId: entry.id,
        baselinePnl: entry.baselinePnl,
        shadowPnl,
        observedAt: snapshot.observed_at,
        secondsLeft: snapshot.seconds_left,
        modeledExecutableBidPrice: snapshot.executable_bid_price
      });
    }
    const baselinePnl = triggered.reduce((sum, row) => sum + row.baselinePnl, 0);
    const shadowPnl = triggered.reduce((sum, row) => sum + row.shadowPnl, 0);
    return {
      key: policy.key,
      type: policy.type,
      coveredClosedEntries: coveredClosedEntries.length,
      evaluableEntries,
      nonEvaluableEntries,
      leftCensoredEntries,
      missingExecutableBidEntries,
      insufficientLiquidityEntries,
      triggeredEntries: triggered.length,
      baselinePnlOnTriggeredEntries: baselinePnl,
      shadowPnlOnTriggeredEntries: shadowPnl,
      deltaOnTriggeredEntries: shadowPnl - baselinePnl,
      counterfactualMetrics: summarizeExitShadowPnl(counterfactualPnl),
      triggers: triggered
    };
  });
  const minimumPolicyEvaluableEntries = policies.length
    ? Math.min(...policies.map((policy) => policy.evaluableEntries))
    : 0;

  const report = {
    experimentKey: EXIT_SHADOW_EXPERIMENT_KEY,
    strategyKey,
    status: minimumPolicyEvaluableEntries >= 30 ? "research_sample_available" : "awaiting_shadow_samples",
    generatedAt: new Date().toISOString(),
    snapshotContract: {
      modeledExecutableBid: true,
      venueVwapObserved: false,
      aggregateBidDepthRecorded: true,
      executionModelVersion: EXIT_SHADOW_EXECUTION_MODEL_VERSION,
      paperResultsAreNotVenueFills: true,
      feesIncluded: true,
      observationUnit: "baseline_entry_id",
      variantsIncreaseIndependentSampleSize: false,
      firstObservedCrossingRequiresPriorNonTriggeredSnapshot: true,
      leftCensoredEntriesExcludedFromPolicyMetrics: true,
      completeCoverageMaxInitialDelaySeconds: 45,
      completeCoverageMaxGapSeconds: 45,
      completeCoverageMaxFinalDelaySeconds: 45,
      minimumClosedCoverageEntries: 30,
      legacyBackfill: false
    },
    entries: {
      totalBaseline: entries.length,
      withSnapshots: entries.filter((entry) => entry.snapshots.length > 0).length,
      closedWithCompleteCoverage: coveredClosedEntries.length,
      minimumPolicyEvaluableEntries,
      snapshots: snapshotsResult.rowCount
    },
    baselineMetrics,
    policies
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
