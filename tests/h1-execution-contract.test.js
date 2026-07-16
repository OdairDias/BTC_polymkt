import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPaperExecutionPrice,
  computeTakerFeeUsd,
  finalizeExecutablePaperEntry,
  resolvePaperBuyReferencePrice
} from "../src/strategy/executionModel.js";
import { formatOfficialOutcomeLine } from "../src/automation/paperOutcome.js";
import { computeRealizedExitPnl, computeSimulatedPnl } from "../src/strategy/outcomeInfer.js";
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
