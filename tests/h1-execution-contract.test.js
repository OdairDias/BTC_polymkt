import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPaperExecutionPrice,
  computeTakerFeeUsd,
  finalizeExecutablePaperEntry,
  resolvePaperBuyReferencePrice
} from "../src/strategy/executionModel.js";
import { formatOfficialOutcomeLine } from "../src/automation/paperOutcome.js";
import { shouldCapturePostStopObserver } from "../src/automation/paperStrategy.js";
import { insertExitShadowSnapshot } from "../src/db/postgresStrategy.js";
import { computeRealizedExitPnl, computeSimulatedPnl } from "../src/strategy/outcomeInfer.js";
import {
  buildExitShadowSnapshot,
  computeExitShadowCoverage,
  evaluateExitShadowPolicyPath,
  EXIT_SHADOW_POLICIES,
  findFirstObservedPolicyTrigger,
  summarizeExitShadowPnl
} from "../src/strategy/exitShadow.js";
import { createExitShadowWriter } from "../src/strategy/exitShadowWriter.js";
import { STRATEGY_VARIANTS, isVariantLiveExecutionAllowed } from "../src/strategy/variants.js";

test("paper BUY is anchored at the executable best ask", () => {
  assert.equal(resolvePaperBuyReferencePrice({ quotePrice: 0.31, bestAsk: 0.32 }), 0.32);
  assert.equal(resolvePaperBuyReferencePrice({ quotePrice: 0.34, bestAsk: 0.32 }), 0.34);
  assert.equal(resolvePaperBuyReferencePrice({ quotePrice: 0.31, bestAsk: null }), null);

  const reference = resolvePaperBuyReferencePrice({ quotePrice: 0.31, bestAsk: 0.32 });
  const fill = applyPaperExecutionPrice({
    action: "buy",
    referencePrice: reference,
    spread: 0.01,
    fillMode: "pessimistic",
    slippageBps: 25,
    spreadPenaltyFactor: 0.20
  });
  assert.ok(Math.abs(fill - 0.3228) < 1e-12);
  assert.ok(fill > 0.32);
});

test("paper entry caller fails closed when executable ask is unavailable", () => {
  const decision = { side: "UP", result: "ENTRY_OK" };
  const noAsk = finalizeExecutablePaperEntry({ decision, modeledEntryPrice: null });
  assert.equal(noAsk.entryPrice, null);
  assert.equal(noAsk.decision.side, null);
  assert.equal(noAsk.decision.result, "SKIP_NO_EXECUTABLE_ASK");

  const executable = finalizeExecutablePaperEntry({ decision, modeledEntryPrice: 0.3228 });
  assert.equal(executable.entryPrice, 0.3228);
  assert.equal(executable.decision.side, "UP");
});

test("crypto taker fee follows the official share-price formula", () => {
  assert.equal(computeTakerFeeUsd({ shares: 10, price: 0.5, feeRate: 0.07 }), 0.175);
  assert.equal(computeTakerFeeUsd({ shares: 10, price: 0.01, feeRate: 0.07 }), 0.00693);
  assert.equal(computeTakerFeeUsd({ shares: 10, price: 0.5, feeRate: 0 }), 0);
});

test("realized PnL uses exited shares and deducts entry plus exit taker fees", () => {
  const result = computeRealizedExitPnl({
    entryPrice: 0.3,
    exitPrice: 0.5,
    notionalUsd: 999,
    shares: 2,
    takerFeeRate: 0.07
  });

  assert.ok(Math.abs(result.grossPnl - 0.4) < 1e-12);
  assert.equal(result.entryFeeUsd, 0.0294);
  assert.equal(result.exitFeeUsd, 0.035);
  assert.equal(result.totalFeeUsd, 0.0644);
  assert.ok(Math.abs(result.pnl - 0.3356) < 1e-12);
  assert.equal(result.shares, 2);
});

test("official settlement deducts the entry taker fee from share-based PnL", () => {
  const result = computeSimulatedPnl({
    chosenSide: "UP",
    winnerSide: "UP",
    entryPrice: 0.3,
    notionalUsd: 999,
    shares: 2,
    takerFeeRate: 0.07
  });

  assert.ok(Math.abs(result.grossPnl - 1.4) < 1e-12);
  assert.equal(result.entryFeeUsd, 0.0294);
  assert.ok(Math.abs(result.pnl - 1.3706) < 1e-12);
  assert.equal(result.shares, 2);
});

test("official outcome formatting uses the computed accounting PnL", () => {
  const winner = formatOfficialOutcomeLine({
    strategyKey: "cheap_1h_exec_v2",
    winLabel: "UP",
    entryCorrect: true,
    pnl: 0.3356
  });
  assert.match(winner, /entrada OK/);
  assert.match(winner, /\$0\.34/);

  const loser = formatOfficialOutcomeLine({
    strategyKey: "cheap_1h_exec_v2",
    winLabel: "DOWN",
    entryCorrect: false,
    pnl: -0.7123
  });
  assert.match(loser, /entrada errou/);
  assert.match(loser, /\$-0\.71/);
});

test("post-stop observer captures only an executable daily-loss-blocked candidate", () => {
  assert.equal(shouldCapturePostStopObserver({
    riskResultCode: "SKIP_RISK_DAILY_LOSS", side: "UP", entryPrice: 0.31, simulatedShares: 3.2
  }), true);
  assert.equal(shouldCapturePostStopObserver({
    riskResultCode: "SKIP_RISK_DAILY_LOSS", side: "UP", entryPrice: null, simulatedShares: 3.2
  }), false);
  assert.equal(shouldCapturePostStopObserver({
    riskResultCode: "SKIP_RISK_CONSECUTIVE_LOSSES", side: "UP", entryPrice: 0.31, simulatedShares: 3.2
  }), false);
  assert.equal(shouldCapturePostStopObserver({
    riskResultCode: "SKIP_RISK_DAILY_LOSS", side: null, entryPrice: 0.31, simulatedShares: 3.2
  }), false);
});

test("exit shadow snapshot is read-only and keeps executable accounting", () => {
  const state = {
    active: true,
    entryId: 99,
    marketSlug: "btc-hourly",
    side: "UP",
    entryPrice: 0.30,
    initialNotionalUsd: 0.72,
    sizeShares: 1.2,
    notionalUsd: 0.36,
    nextLevelIndex: 1,
    targetPrice: 0.45,
    highestBidSeen: 0.44
  };
  const before = structuredClone(state);
  const snapshot = buildExitShadowSnapshot({
    state,
    strategyKey: "cheap_1h_exec_v2",
    marketSlug: "btc-hourly",
    settlementLeftMin: 14.5,
    bidPrice: 0.25,
    executableBidPrice: 0.248,
    bidDepthShares: 12.5,
    hasLiquidity: true,
    realizedIfExit: {
      grossPnl: -0.0624,
      entryFeeUsd: 0.01,
      exitFeeUsd: 0.01,
      totalFeeUsd: 0.02,
      pnl: -0.0824
    },
    intervalSeconds: 15,
    observedAt: new Date("2026-07-17T00:00:14Z"),
    gitCommit: "abc123",
    configHash: "cfg"
  });

  assert.deepEqual(state, before);
  assert.equal(snapshot.entry_id, 99);
  assert.equal(snapshot.experiment_key, "h1_exit_shadow_v1");
  assert.equal(snapshot.snapshot_bucket, Math.floor(Date.parse("2026-07-17T00:00:14Z") / 15_000));
  assert.equal(snapshot.next_level_index, 1);
  assert.equal(snapshot.next_target_price, 0.45);
  assert.equal(snapshot.higher_priority_exit_due, false);
  assert.equal(snapshot.net_pnl_if_exit_usd, -0.0824);
  assert.equal(snapshot.bid_depth_shares, 12.5);
  assert.equal(snapshot.execution_model_version, "paper_best_bid_penalty_v1");
  assert.equal(snapshot.has_bid_liquidity, true);
});

test("shadow policies require an observed crossing and expose left censoring", () => {
  const timePolicy = EXIT_SHADOW_POLICIES.find((policy) => policy.key === "time_stop_15m");
  const stopPolicy = EXIT_SHADOW_POLICIES.find((policy) => policy.key === "max_loss_025");
  const snapshots = [
    {
      observed_at: "2026-07-17T00:00:00Z",
      seconds_left: 930,
      executable_bid_price: 0.30,
      has_bid_liquidity: true,
      initial_notional_usd: 0.72,
      total_net_pnl_if_exit_usd: -0.10,
      next_level_index: 0
    },
    {
      observed_at: "2026-07-17T00:00:15Z",
      seconds_left: 895,
      executable_bid_price: 0.22,
      has_bid_liquidity: true,
      initial_notional_usd: 0.72,
      total_net_pnl_if_exit_usd: -0.30,
      next_level_index: 0
    }
  ];

  assert.equal(findFirstObservedPolicyTrigger(timePolicy, snapshots), snapshots[1]);
  assert.equal(findFirstObservedPolicyTrigger(stopPolicy, snapshots), snapshots[1]);
  assert.equal(findFirstObservedPolicyTrigger(stopPolicy, [snapshots[1]]), null);
  assert.equal(evaluateExitShadowPolicyPath(stopPolicy, [snapshots[1]]).status, "left_censored");

  const noBook = [{ ...snapshots[0], executable_bid_price: null, has_bid_liquidity: false }];
  const nonEvaluable = evaluateExitShadowPolicyPath(stopPolicy, noBook);
  assert.equal(nonEvaluable.status, "non_evaluable");
  assert.equal(nonEvaluable.missingExecutableBidSnapshots, 1);
  assert.equal(nonEvaluable.insufficientLiquiditySnapshots, 1);

  const takeProfitSameTick = structuredClone(snapshots);
  takeProfitSameTick[1].bid_price = 0.40;
  takeProfitSameTick[1].next_target_price = 0.40;
  assert.equal(findFirstObservedPolicyTrigger(timePolicy, takeProfitSameTick), null);

  const trailingSameTick = structuredClone(snapshots);
  trailingSameTick[1].higher_priority_exit_due = true;
  assert.equal(findFirstObservedPolicyTrigger(timePolicy, trailingSameTick), null);
});

test("shadow coverage rejects a missing terminal tail", () => {
  const entryCreatedAt = "2026-07-17T00:00:00Z";
  const snapshots = [
    { observed_at: "2026-07-17T00:00:10Z" },
    { observed_at: "2026-07-17T00:00:40Z" }
  ];
  const complete = computeExitShadowCoverage({
    entryCreatedAt,
    finalExitAt: "2026-07-17T00:00:50Z",
    snapshots
  });
  assert.equal(complete.complete, true);
  const censoredTail = computeExitShadowCoverage({
    entryCreatedAt,
    finalExitAt: "2026-07-17T00:03:20Z",
    snapshots
  });
  assert.equal(censoredTail.complete, false);
  assert.equal(censoredTail.finalCoverageDelaySeconds, 160);
});

test("shadow writer is bounded, asynchronous and isolated from baseline state", async () => {
  let releaseWrite;
  let writes = 0;
  const errors = [];
  const writer = createExitShadowWriter({
    maxQueue: 2,
    write: async () => {
      writes += 1;
      await new Promise((resolve) => { releaseWrite = resolve; });
    },
    onError: (error) => errors.push(error)
  });
  const baselineState = { active: true, sizeShares: 2.5 };
  const before = structuredClone(baselineState);
  const snapshot = { experiment_key: "h1_exit_shadow_v1", entry_id: 99, snapshot_bucket: 123 };
  assert.equal(writer.enqueue(snapshot), true);
  assert.deepEqual(baselineState, before);
  await Promise.resolve();
  assert.equal(writer.stats().draining, true);
  assert.equal(writes, 1);
  assert.equal(writer.enqueue(snapshot), true);
  releaseWrite();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(errors.length, 0);

  const rejectingWriter = createExitShadowWriter({
    write: async () => { throw new Error("shadow db unavailable"); },
    onError: (error) => errors.push(error)
  });
  assert.equal(rejectingWriter.enqueue({ ...snapshot, snapshot_bucket: 124 }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejectingWriter.stats().dropped, 1);
  assert.equal(errors.at(-1)?.message, "shadow db unavailable");

  let unblockFirst;
  let boundedWrites = 0;
  const boundedWriter = createExitShadowWriter({
    maxQueue: 1,
    write: async () => {
      boundedWrites += 1;
      if (boundedWrites === 1) await new Promise((resolve) => { unblockFirst = resolve; });
    },
    onError: (error) => errors.push(error)
  });
  assert.equal(boundedWriter.enqueue({ ...snapshot, snapshot_bucket: 200 }), true);
  await Promise.resolve();
  assert.equal(boundedWriter.enqueue({ ...snapshot, snapshot_bucket: 201 }), true);
  assert.equal(boundedWriter.enqueue({ ...snapshot, snapshot_bucket: 202 }), false);
  assert.equal(boundedWriter.stats().dropped, 1);
  unblockFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boundedWrites, 2);
});

test("shadow SQL preserves placeholders, experiment dedupe and execution provenance", async () => {
  let captured;
  const client = {
    query: async (sql, values) => {
      captured = { sql, values };
      return { rowCount: 1, rows: [{ id: 7 }] };
    }
  };
  const result = await insertExitShadowSnapshot(client, {
    entry_id: 99,
    experiment_key: "h1_exit_shadow_v1",
    strategy_key: "cheap_1h_exec_v2",
    market_slug: "btc-hourly",
    observed_at: new Date("2026-07-17T00:00:00Z"),
    snapshot_bucket: 123,
    interval_seconds: 15,
    side: "UP",
    seconds_left: 900,
    bid_price: 0.2,
    executable_bid_price: 0.198,
    bid_depth_shares: 50,
    execution_model_version: "paper_best_bid_penalty_v1",
    initial_notional_usd: 0.72,
    remaining_shares: 2.5,
    remaining_notional_usd: 0.72,
    next_level_index: 0,
    next_target_price: 0.4,
    higher_priority_exit_due: false,
    highest_bid_seen: 0.3,
    has_bid_liquidity: true,
    gross_pnl_if_exit_usd: -0.1,
    entry_fee_if_exit_usd: 0.01,
    exit_fee_if_exit_usd: 0.01,
    total_fee_if_exit_usd: 0.02,
    net_pnl_if_exit_usd: -0.12,
    git_commit: "abc123",
    config_hash: "cfg"
  });
  assert.deepEqual(result, { inserted: true, id: 7 });
  assert.equal(captured.values.length, 28);
  assert.match(captured.sql, /\$28/);
  assert.match(captured.sql, /ON CONFLICT \(entry_id, experiment_key, snapshot_bucket\) DO NOTHING/);
  assert.equal(captured.values[11], 50);
  assert.equal(captured.values[12], "paper_best_bid_penalty_v1");
});

test("shadow PnL summary preserves per-entry economics", () => {
  const metrics = summarizeExitShadowPnl([0.3, -0.6, 0.2, -0.1]);
  assert.equal(metrics.entries, 4);
  assert.equal(metrics.wins, 2);
  assert.equal(metrics.losses, 2);
  assert.ok(Math.abs(metrics.netPnl - (-0.2)) < 1e-12);
  assert.ok(Math.abs(metrics.expectancy - (-0.05)) < 1e-12);
  assert.ok(Math.abs(metrics.averageWin - 0.25) < 1e-12);
  assert.ok(Math.abs(metrics.averageLoss - (-0.35)) < 1e-12);
  assert.ok(Math.abs(metrics.profitFactor - (0.5 / 0.7)) < 1e-12);
  assert.ok(Math.abs(metrics.maxDrawdown - 0.6) < 1e-12);
  assert.equal(metrics.worstTrade, -0.6);
});

test("only the refined H1 cohort is enabled", () => {
  const enabled = STRATEGY_VARIANTS.filter((variant) => variant.enabled !== false).map((variant) => variant.key);
  assert.deepEqual(enabled, ["cheap_1h_exec_v2"]);

  const h1 = STRATEGY_VARIANTS.find((variant) => variant.key === "cheap_1h_exec_v2");
  assert.equal(h1.shadowOnly, true);
  assert.equal(isVariantLiveExecutionAllowed(h1), false);
  assert.equal(h1.paperFillMode, "pessimistic");
  assert.equal(h1.paperEntrySlippageBps, 25);
  assert.equal(h1.paperExitSlippageBps, 35);
  assert.equal(h1.paperSpreadPenaltyFactor, 0.20);
  assert.equal(h1.paperTakerFeeRate, 0.07);
  assert.equal(h1.exitShadowEnabled, true);
  assert.equal(h1.exitShadowIntervalSeconds, 15);
  assert.equal(h1.marketWindowMinutes, 60);
  assert.equal(h1.marketSeriesId, "10114");
  assert.equal(h1.marketSeriesSlug, "btc-up-or-down-hourly");
  assert.equal(h1.crossMarketWindowMinutes, 15);
  assert.equal(h1.crossMarketSeriesId, "10192");
  assert.equal(h1.crossMarketSeriesSlug, "btc-up-or-down-15m");
});

test("resolved config rejects legacy M15/M5 overrides and keeps H1 paper-only", async () => {
  const keys = ["STRATEGY_VARIANTS_JSON", "STRATEGY_LIVE_STRATEGY_KEY", "STRATEGY_DRY_RUN", "STRATEGY_LIVE_ARMED"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.STRATEGY_VARIANTS_JSON = JSON.stringify([
      { key: "cheap_15m_tp35", enabled: true, shadowOnly: false },
      { key: "cheap_5m_full_shadow", enabled: true, shadowOnly: false },
      {
        key: "cheap_1h_exec_v2",
        enabled: true,
        shadowOnly: false,
        marketSeriesId: "10192",
        marketSeriesSlug: "btc-up-or-down-15m"
      }
    ]);
    process.env.STRATEGY_LIVE_STRATEGY_KEY = "cheap_1h_exec_v2";
    process.env.STRATEGY_DRY_RUN = "false";
    process.env.STRATEGY_LIVE_ARMED = "true";

    const { CONFIG } = await import(`../src/config.js?h1-allowlist=${Date.now()}`);
    assert.deepEqual(CONFIG.strategy.variants.map((variant) => variant.key), ["cheap_1h_exec_v2"]);
    const h1 = CONFIG.strategy.variants[0];
    assert.equal(h1.shadowOnly, true);
    assert.equal(h1.exitShadowEnabled, true);
    assert.equal(h1.exitShadowIntervalSeconds, 15);
    assert.equal(h1.marketSeriesId, "10114");
    assert.equal(h1.marketSeriesSlug, "btc-up-or-down-hourly");
    assert.equal(CONFIG.strategy.liveStrategyKey, "__live_disabled__");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
