import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { CONFIG } from "../src/config.js";
import { capPaperCycleMaxSteps } from "../src/db/postgresReversalCycle.js";
import { applyEntrySidePolicy, decideLateWindowSide } from "../src/strategy/lateWindow.js";
import { isVariantLiveExecutionAllowed } from "../src/strategy/variants.js";

const main = CONFIG.strategy.variants.find((variant) => variant.key === "cheap_15m_tp35");
const shadow = CONFIG.strategy.variants.find((variant) => variant.key === "cheap_15m_tp35_down_shadow");

assert.ok(main, "main cheap_15m_tp35 variant must exist");
assert.ok(shadow, "DOWN shadow variant must exist");
assert.equal(main.entrySidePolicy, "UP_ONLY");
assert.equal(main.shadowOnly, false);
assert.equal(main.cycleMaxSteps, 1);
assert.equal(shadow.entrySidePolicy, "DOWN_ONLY");
assert.equal(shadow.shadowOnly, true);
assert.equal(shadow.cycleMaxSteps, 1);
assert.equal(isVariantLiveExecutionAllowed(main), false, "reversal lifecycle is paper-only");
assert.equal(isVariantLiveExecutionAllowed(shadow), false, "shadow must be structurally live-disabled");

const upDecision = { side: "UP", result: "UP", selectedEdge: 0.12 };
const downDecision = { side: "DOWN", result: "DOWN", selectedEdge: 0.14 };

assert.equal(applyEntrySidePolicy(upDecision, "UP_ONLY").side, "UP");
assert.equal(applyEntrySidePolicy(downDecision, "DOWN_ONLY").side, "DOWN");

const blockedDown = applyEntrySidePolicy(downDecision, "UP_ONLY");
assert.equal(blockedDown.side, null);
assert.equal(blockedDown.blockedSide, "DOWN");
assert.equal(blockedDown.result, "SKIP_ENTRY_SIDE_POLICY_DOWN");
assert.equal(blockedDown.selectedEdge, 0.14, "blocked decisions must preserve attribution fields");

const blockedUp = applyEntrySidePolicy(upDecision, "DOWN_ONLY");
assert.equal(blockedUp.side, null);
assert.equal(blockedUp.blockedSide, "UP");
assert.equal(blockedUp.result, "SKIP_ENTRY_SIDE_POLICY_UP");

const cheapDownDecision = decideLateWindowSide({
  decisionMode: "cheap_revert",
  minutesLeft: 12,
  entryMinutesLeft: 13.75,
  upMid: 0.70,
  downMid: 0.30,
  upBuy: 0.71,
  downBuy: 0.31,
  upBookImbalance: 0.9,
  downBookImbalance: 1.1,
  upSpread: 0.01,
  downSpread: 0.01,
  modelUp: 0.40,
  modelDown: 0.60,
  marketUp: 0.70,
  marketDown: 0.30,
  targetEntryPrice: 0.45,
  minEntryPrice: 0.01,
  minEdge: 0.05,
  minModelProb: 0.50,
  minBookImbalance: 0.8,
  maxSpreadToEdgeRatio: 0.5,
  epsilon: 0,
  ptbDelta: 10,
  regimeDetected: "TREND_DOWN"
});
assert.equal(cheapDownDecision.side, "DOWN", "fixture must produce a valid cheap DOWN candidate");
assert.equal(applyEntrySidePolicy(cheapDownDecision, main.entrySidePolicy).side, null);
assert.equal(applyEntrySidePolicy(cheapDownDecision, shadow.entrySidePolicy).side, "DOWN");

const fakeQueries = [];
const cappedSteps = await capPaperCycleMaxSteps({
  async query(sql, params) {
    fakeQueries.push({ sql, params });
    return { rows: [{ max_steps: 1 }] };
  }
}, { cycleId: 999, configuredMaxSteps: 1 });
assert.equal(cappedSteps, 1);
assert.match(fakeQueries[0].sql, /LEAST\(max_steps, \$2\)/);
assert.deepEqual(fakeQueries[0].params, [999, 1]);

const overrideProbe = spawnSync(process.execPath, [
  "--input-type=module",
  "-e",
  `import { CONFIG } from "./src/config.js";
   const main = CONFIG.strategy.variants.find(v => v.key === "cheap_15m_tp35");
   const shadow = CONFIG.strategy.variants.find(v => v.key === "cheap_15m_tp35_down_shadow");
   console.log(JSON.stringify({ main, shadow, liveStrategyKey: CONFIG.strategy.liveStrategyKey }));`
], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    STRATEGY_LIVE_STRATEGY_KEY: "cheap_15m_tp35",
    STRATEGY_VARIANTS_JSON: JSON.stringify([
      {
        key: "cheap_15m_tp35",
        entrySidePolicy: "BOTH",
        reversalEnabled: false,
        cycleMaxSteps: 4
      },
      {
        key: "cheap_15m_tp35_down_shadow",
        entrySidePolicy: "BOTH",
        shadowOnly: false,
        reversalEnabled: false,
        cycleMaxSteps: 4
      }
    ])
  }
});
assert.equal(overrideProbe.status, 0, overrideProbe.stderr);
const overrideConfig = JSON.parse(overrideProbe.stdout.trim());
assert.equal(overrideConfig.main.entrySidePolicy, "UP_ONLY", "main side contract must survive env override");
assert.equal(overrideConfig.main.reversalEnabled, true);
assert.equal(overrideConfig.main.cycleMaxSteps, 1);
assert.equal(overrideConfig.shadow.entrySidePolicy, "DOWN_ONLY");
assert.equal(overrideConfig.shadow.shadowOnly, true, "shadow suffix must remain paper-only under env override");
assert.equal(overrideConfig.shadow.reversalEnabled, true);
assert.equal(overrideConfig.shadow.cycleMaxSteps, 1);
assert.equal(overrideConfig.liveStrategyKey, "__live_disabled__", "reversal strategy must not become live primary");

console.log(JSON.stringify({
  ok: true,
  main: {
    key: main.key,
    entrySidePolicy: main.entrySidePolicy,
    shadowOnly: main.shadowOnly,
    cycleMaxSteps: main.cycleMaxSteps
  },
  shadow: {
    key: shadow.key,
    entrySidePolicy: shadow.entrySidePolicy,
    shadowOnly: shadow.shadowOnly,
    cycleMaxSteps: shadow.cycleMaxSteps
  },
  checks: {
    mainAllowsUp: true,
    mainBlocksDown: true,
    shadowAllowsDown: true,
    shadowBlocksUp: true,
    legacyCycleStepsCapped: true,
    noRecovery: true,
    reversalLiveBlocked: true,
    shadowOverrideFailClosed: true
  }
}, null, 2));
