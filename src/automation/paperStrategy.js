import { CONFIG } from "../config.js";
import { createHash } from "node:crypto";
import {
  ensureStrategySchemaOnce,
  ensurePaperSignal,
  findRecoverableLiveTakeProfitEntry,
  findRecoverablePaperTakeProfitEntry,
  getStrategyPool,
  insertPaperOutcome,
  resetStrategySchemaFlag,
  updatePaperSignalExecution
} from "../db/postgresStrategy.js";
import { decideLateWindowSide } from "../strategy/lateWindow.js";
import { computeRealizedExitPnl } from "../strategy/outcomeInfer.js";
import { applyPaperExecutionPrice, normalizePaperFillMode } from "../strategy/executionModel.js";
import { midFromBook } from "../strategy/pricing.js";
import { chooseStrategyNotional } from "../strategy/sizing.js";
import { resetLiveClobClient } from "./liveClob.js";
import {
  readLiveSellableShares,
  shouldAttemptLiveOrder,
  tryPlaceSniperFokOrder,
  tryPlaceTakeProfitExitOrder
} from "./liveEntryOrder.js";
import { resetOutcomeTrailForTests } from "./paperOutcome.js";
import { evaluateAsymmetryGuard, evaluateRiskStatsGuard } from "./riskGuards.js";

const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

let warnedNoDb = false;

const slugMinutesLeftTrailByStrategy = new Map();
const sniperStateByStrategy = new Map();
const paperTakeProfitStateByStrategy = new Map();
const liveTakeProfitStateByStrategy = new Map();
const lastPaperLineByStrategy = new Map();
const lastLiveLineByStrategy = new Map();
const filledMarketsByStrategy = new Map();
const runtimeGitCommit =
  String(
    process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.GIT_COMMIT ||
      process.env.SOURCE_VERSION ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      ""
  ).trim() || "unknown";

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function hashConfigPayload(payload) {
  const stable = JSON.stringify(sortKeysDeep(payload));
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function buildVariantConfigHash(variant) {
  return hashConfigPayload({
    candleWindowMinutes: CONFIG.candleWindowMinutes,
    liveStrategyKey: CONFIG.strategy.liveStrategyKey,
    variant: {
      key: variant?.key ?? "default",
      decisionMode: variant?.decisionMode ?? "sniper_v2",
      contrarian: Boolean(variant?.contrarian),
      entryMinutesLeft: variant?.entryMinutesLeft ?? null,
      entryCloseMinutesLeft: variant?.entryCloseMinutesLeft ?? null,
      targetEntryPrice: variant?.targetEntryPrice ?? null,
      minEntryPrice: variant?.minEntryPrice ?? null,
      priceEpsilon: variant?.priceEpsilon ?? null,
      notionalUsd: variant?.notionalUsd ?? null,
      maxEntryPrice: variant?.maxEntryPrice ?? null,
      minPayoutMultiple: variant?.minPayoutMultiple ?? null,
      takeProfitEnabled: variant?.takeProfitEnabled ?? null,
      takeProfitPrice: variant?.takeProfitPrice ?? null,
      takeProfitLevels: variant?.takeProfitLevels ?? [],
      trailingStopEnabled: variant?.trailingStopEnabled ?? null,
      trailingStopActivationPrice: variant?.trailingStopActivationPrice ?? null,
      trailingStopDropCents: variant?.trailingStopDropCents ?? null,
      grossProfitTargetUsd: variant?.grossProfitTargetUsd ?? null,
      forceExitMinutesLeft: variant?.forceExitMinutesLeft ?? null,
      minEdge: variant?.minEdge ?? null,
      minModelProb: variant?.minModelProb ?? null,
      minBookImbalance: variant?.minBookImbalance ?? null,
      maxSpreadToEdgeRatio: variant?.maxSpreadToEdgeRatio ?? null,
      maxSumMids: variant?.maxSumMids ?? null,
      minSumMids: variant?.minSumMids ?? null,
      binaryDiscountBonus: variant?.binaryDiscountBonus ?? null,
      regimeGateEnabled: variant?.regimeGateEnabled ?? null,
      regimeTrendEdgeMultiplier: variant?.regimeTrendEdgeMultiplier ?? null,
      oracleLagBonusEnabled: variant?.oracleLagBonusEnabled ?? null,
      oracleLagBonusMinMs: variant?.oracleLagBonusMinMs ?? null,
      oracleLagBonusMinDelta: variant?.oracleLagBonusMinDelta ?? null,
      oracleLagBonusEdge: variant?.oracleLagBonusEdge ?? null,
      entryPriceTiers: variant?.entryPriceTiers ?? [],
      paperFillMode: variant?.paperFillMode ?? null,
      paperEntrySlippageBps: variant?.paperEntrySlippageBps ?? null,
      paperExitSlippageBps: variant?.paperExitSlippageBps ?? null,
      paperSpreadPenaltyFactor: variant?.paperSpreadPenaltyFactor ?? null,
      maxOracleLagMs: variant?.maxOracleLagMs ?? null,
      maxBinanceLagMs: variant?.maxBinanceLagMs ?? null,
      maxSnapshotAgeMs: variant?.maxSnapshotAgeMs ?? null,
      sniperDeltaFloorUsd: variant?.sniperDeltaFloorUsd ?? null,
      sniperDeltaAtrMult: variant?.sniperDeltaAtrMult ?? null,
      sizingMode: variant?.sizingMode ?? null,
      kellyFraction: variant?.kellyFraction ?? null,
      kellyMinNotionalUsd: variant?.kellyMinNotionalUsd ?? null,
      kellyMaxNotionalUsd: variant?.kellyMaxNotionalUsd ?? null,
      maxDailyLossUsd: variant?.maxDailyLossUsd ?? null,
      riskDayTimezone: variant?.riskDayTimezone ?? null,
      liveEntryOrderType: variant?.liveEntryOrderType ?? null,
      liveExitOrderType: variant?.liveExitOrderType ?? null,
      marketSlugPrefix: variant?.marketSlugPrefix ?? null,
      marketWindowMinutes: variant?.marketWindowMinutes ?? null,
      marketSeriesId: variant?.marketSeriesId ?? null,
      marketSeriesSlug: variant?.marketSeriesSlug ?? null,
      crossMarketWindowMinutes: variant?.crossMarketWindowMinutes ?? null,
      crossMarketSlugPrefix: variant?.crossMarketSlugPrefix ?? null,
      crossMarketSeriesId: variant?.crossMarketSeriesId ?? null,
      crossMarketSeriesSlug: variant?.crossMarketSeriesSlug ?? null,
      crossMarketMaxDivergence: variant?.crossMarketMaxDivergence ?? null,
      crossMarketEdgeBonus: variant?.crossMarketEdgeBonus ?? null,
      crossMarketRequired: variant?.crossMarketRequired ?? null
    }
  });
}

function buildEntryAttributionContext({
  variant,
  effectiveDecision,
  paperResultCode,
  settlementLeftMin,
  activeNotionalUsd,
  entryPrice,
  simulatedShares,
  upMid,
  downMid,
  upBuy,
  downBuy,
  upSpread,
  downSpread,
  upBookImbalance,
  downBookImbalance,
  modelUp,
  modelDown,
  marketUp,
  marketDown,
  ptbDelta,
  oraclePrice,
  binanceSpotPrice,
  priceToBeat,
  volAtrUsd,
  volAtrBaseMinutes,
  rsiNow,
  macd,
  haNarrative,
  dataHealth,
  sizingDetails
}) {
  return {
    decision_mode: variant?.decisionMode ?? "sniper_v2",
    decision_result: effectiveDecision?.result ?? null,
    entry_record_result_code: paperResultCode ?? null,
    side: effectiveDecision?.side ?? null,
    minutes_left: toFiniteNumber(settlementLeftMin),
    notional_usd: toFiniteNumber(activeNotionalUsd),
    entry_price: toFiniteNumber(entryPrice),
    simulated_shares: toFiniteNumber(simulatedShares),
    selected_model_prob: toFiniteNumber(effectiveDecision?.selectedModelProb),
    selected_market_prob: toFiniteNumber(effectiveDecision?.selectedMarketProb),
    selected_edge: toFiniteNumber(effectiveDecision?.selectedEdge),
    selected_base_edge: toFiniteNumber(effectiveDecision?.selectedBaseEdge),
    selected_book_imbalance: toFiniteNumber(effectiveDecision?.selectedBookImbalance),
    selected_spread: toFiniteNumber(effectiveDecision?.selectedSpread),
    binary_sum_mids: toFiniteNumber(effectiveDecision?.binarySumMids),
    binary_discount: toFiniteNumber(effectiveDecision?.binaryDiscount),
    binary_edge_bonus: toFiniteNumber(effectiveDecision?.binaryEdgeBonus),
    oracle_lag_bonus: toFiniteNumber(effectiveDecision?.oracleLagEdgeBonus),
    cross_market_consistency: toFiniteNumber(effectiveDecision?.crossMarketConsistency),
    cross_market_divergence: toFiniteNumber(effectiveDecision?.crossMarketDivergence),
    regime_detected: effectiveDecision?.regimeDetected ?? null,
    entry_tier: effectiveDecision?.entryTier ?? null,
    ptb_delta_usd: toFiniteNumber(ptbDelta),
    oracle_price: toFiniteNumber(oraclePrice),
    binance_spot_price: toFiniteNumber(binanceSpotPrice),
    price_to_beat: toFiniteNumber(priceToBeat),
    vol_atr_usd: toFiniteNumber(volAtrUsd),
    vol_atr_base_minutes: toFiniteNumber(volAtrBaseMinutes),
    model_up: toFiniteNumber(modelUp),
    model_down: toFiniteNumber(modelDown),
    market_up: toFiniteNumber(marketUp),
    market_down: toFiniteNumber(marketDown),
    up_mid: toFiniteNumber(upMid),
    down_mid: toFiniteNumber(downMid),
    up_buy: toFiniteNumber(upBuy),
    down_buy: toFiniteNumber(downBuy),
    up_spread: toFiniteNumber(upSpread),
    down_spread: toFiniteNumber(downSpread),
    up_book_imbalance: toFiniteNumber(upBookImbalance),
    down_book_imbalance: toFiniteNumber(downBookImbalance),
    rsi: toFiniteNumber(rsiNow),
    macd_hist: toFiniteNumber(macd?.hist),
    ha_narrative: haNarrative ?? null,
    data_health: {
      oracle_lag_ms: toFiniteNumber(dataHealth?.oracleLagMs),
      binance_lag_ms: toFiniteNumber(dataHealth?.binanceLagMs),
      snapshot_age_ms: toFiniteNumber(dataHealth?.snapshotAgeMs)
    },
    sizing: {
      mode: sizingDetails?.sizingMode ?? null,
      kelly_full: toFiniteNumber(sizingDetails?.kellyFull),
      kelly_applied: toFiniteNumber(sizingDetails?.kellyApplied),
      estimated_prob: toFiniteNumber(sizingDetails?.estimatedProb),
      market_prob: toFiniteNumber(sizingDetails?.marketProb)
    },
    exits: {
      take_profit_levels: Array.isArray(variant?.takeProfitLevels) ? variant.takeProfitLevels : [],
      trailing_stop_enabled: Boolean(variant?.trailingStopEnabled),
      trailing_stop_activation_price: toFiniteNumber(variant?.trailingStopActivationPrice),
      trailing_stop_drop_cents: toFiniteNumber(variant?.trailingStopDropCents)
    }
  };
}

function getVariants(variantSubset = null) {
  if (Array.isArray(variantSubset) && variantSubset.length) {
    return variantSubset.filter((v) => v && v.enabled !== false);
  }
  const configured = Array.isArray(CONFIG.strategy.variants) ? CONFIG.strategy.variants : [];
  if (configured.length) return configured.filter((v) => v && v.enabled !== false);
  return [
    {
      key: "default",
      label: "default",
      entryMinutesLeft: CONFIG.strategy.entryMinutesLeft,
      targetEntryPrice: CONFIG.strategy.targetEntryPrice,
      priceEpsilon: CONFIG.strategy.priceEpsilon,
      notionalUsd: CONFIG.strategy.notionalUsd,
      riskGuardsEnabled: CONFIG.strategy.riskGuardsEnabled,
      maxConsecutiveLosses: CONFIG.strategy.maxConsecutiveLosses,
      rollingLossHours: CONFIG.strategy.rollingLossHours,
      maxRollingLossUsd: CONFIG.strategy.maxRollingLossUsd,
      minPayoutMultiple: CONFIG.strategy.minPayoutMultiple,
      maxEntryPrice: CONFIG.strategy.maxEntryPrice,
      minEntryPrice: CONFIG.strategy.minEntryPrice,
      takeProfitEnabled: CONFIG.strategy.takeProfitEnabled,
      takeProfitPrice: CONFIG.strategy.takeProfitPrice,
      takeProfitLevels: CONFIG.strategy.takeProfitLevels,
      trailingStopEnabled: CONFIG.strategy.trailingStopEnabled,
      trailingStopActivationPrice: CONFIG.strategy.trailingStopActivationPrice,
      trailingStopDropCents: CONFIG.strategy.trailingStopDropCents,
      grossProfitTargetUsd: CONFIG.strategy.grossProfitTargetUsd,
      forceExitMinutesLeft: CONFIG.strategy.forceExitMinutesLeft,
      minEdge: CONFIG.strategy.minEdge,
      minModelProb: CONFIG.strategy.minModelProb,
      minBookImbalance: CONFIG.strategy.minBookImbalance,
      maxSpreadToEdgeRatio: CONFIG.strategy.maxSpreadToEdgeRatio,
      maxSumMids: CONFIG.strategy.maxSumMids,
      minSumMids: CONFIG.strategy.minSumMids,
      binaryDiscountBonus: CONFIG.strategy.binaryDiscountBonus,
      regimeGateEnabled: CONFIG.strategy.regimeGateEnabled,
      regimeTrendEdgeMultiplier: CONFIG.strategy.regimeTrendEdgeMultiplier,
      oracleLagBonusEnabled: CONFIG.strategy.oracleLagBonusEnabled,
      oracleLagBonusMinMs: CONFIG.strategy.oracleLagBonusMinMs,
      oracleLagBonusMinDelta: CONFIG.strategy.oracleLagBonusMinDelta,
      oracleLagBonusEdge: CONFIG.strategy.oracleLagBonusEdge,
      entryPriceTiers: CONFIG.strategy.entryPriceTiers,
      paperFillMode: CONFIG.strategy.paperFillMode,
      paperEntrySlippageBps: CONFIG.strategy.paperEntrySlippageBps,
      paperExitSlippageBps: CONFIG.strategy.paperExitSlippageBps,
      paperSpreadPenaltyFactor: CONFIG.strategy.paperSpreadPenaltyFactor,
      maxOracleLagMs: CONFIG.strategy.maxOracleLagMs,
      maxBinanceLagMs: CONFIG.strategy.maxBinanceLagMs,
      maxSnapshotAgeMs: CONFIG.strategy.maxSnapshotAgeMs,
      sniperDeltaFloorUsd: CONFIG.strategy.sniperDeltaFloorUsd,
      sniperDeltaAtrMult: CONFIG.strategy.sniperDeltaAtrMult,
      sizingMode: CONFIG.strategy.sizingMode,
      kellyFraction: CONFIG.strategy.kellyFraction,
      kellyMinNotionalUsd: CONFIG.strategy.kellyMinNotionalUsd,
      kellyMaxNotionalUsd: CONFIG.strategy.kellyMaxNotionalUsd,
      maxDailyLossUsd: CONFIG.strategy.maxDailyLossUsd,
      riskDayTimezone: CONFIG.strategy.riskDayTimezone
    }
  ];
}

function defaultSniperState() {
  return {
    active: false,
    marketSlug: null,
    side: null,
    tokenId: null,
    limitPrice: null,
    notionalUsd: null,
    entryId: null
  };
}

function defaultTakeProfitState() {
  return {
    active: false,
    marketSlug: null,
    side: null,
    tokenId: null,
    targetPrice: null,
    sizeShares: null,
    notionalUsd: null,
    initialSizeShares: null,
    initialNotionalUsd: null,
    entryId: null,
    entryPrice: null,
    forceExitMinutesLeft: null,
    takeProfitLevels: [],
    nextLevelIndex: 0,
    trailingStopEnabled: false,
    trailingStopActivationPrice: null,
    trailingStopDropCents: null,
    highestBidSeen: null,
    exitSequence: 0
  };
}

function clearSniperState(state) {
  Object.assign(state, defaultSniperState());
}

function clearTakeProfitState(state) {
  Object.assign(state, defaultTakeProfitState());
}

function normalizeTakeProfitLevels(levels, fallbackPrice = null) {
  const normalized = (Array.isArray(levels) ? levels : [])
    .map((level) => {
      const price = toFiniteNumber(level?.price);
      const fraction = toFiniteNumber(level?.fraction);
      if (price == null || price <= 0 || price >= 1) return null;
      if (fraction == null || fraction <= 0) return null;
      return {
        price,
        fraction
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.price - b.price);

  if (!normalized.length) {
    const price = toFiniteNumber(fallbackPrice);
    return price != null && price > 0 && price < 1
      ? [{ price, fraction: 1 }]
      : [];
  }

  const total = normalized.reduce((sum, level) => sum + level.fraction, 0);
  if (!Number.isFinite(total) || total <= 0) return [];

  return normalized.map((level, index) => {
    if (index === normalized.length - 1) {
      const accumulated = normalized
        .slice(0, -1)
        .reduce((sum, item) => sum + (item.fraction / total), 0);
      return {
        price: level.price,
        fraction: Math.max(0.0001, 1 - accumulated)
      };
    }
    return {
      price: level.price,
      fraction: level.fraction / total
    };
  });
}

function refreshTakeProfitTargetPrice(state) {
  state.targetPrice = state.takeProfitLevels[state.nextLevelIndex]?.price ?? null;
}

function armTakeProfitState(state, payload) {
  state.active = true;
  state.marketSlug = payload.marketSlug;
  state.side = payload.side;
  state.tokenId = payload.tokenId != null ? String(payload.tokenId) : null;
  const entryPrice = toFiniteNumber(payload.entryPrice);
  const minProfitCents = 0.01;
  let takeProfitLevels = normalizeTakeProfitLevels(payload.takeProfitLevels, payload.targetPrice);
  if (entryPrice != null && takeProfitLevels.length) {
    const minTarget = Math.min(0.99, entryPrice + minProfitCents);
    const filtered = takeProfitLevels.filter((level) => level.price >= minTarget);
    if (filtered.length) {
      // Re-normaliza fractions para somar 1 apos filtrar.
      takeProfitLevels = normalizeTakeProfitLevels(filtered, null);
    } else if (minTarget > 0 && minTarget < 1) {
      takeProfitLevels = [{ price: minTarget, fraction: 1 }];
    }
  }
  state.takeProfitLevels = takeProfitLevels;
  state.initialSizeShares = payload.initialSizeShares ?? payload.sizeShares;
  state.initialNotionalUsd = payload.initialNotionalUsd ?? payload.notionalUsd;
  state.sizeShares = payload.remainingShares ?? payload.sizeShares;
  state.notionalUsd = payload.remainingNotionalUsd ?? payload.notionalUsd;
  state.entryId = payload.entryId;
  state.entryPrice = entryPrice;
  state.forceExitMinutesLeft = payload.forceExitMinutesLeft ?? null;
  state.nextLevelIndex = Math.max(0, Math.floor(Number(payload.nextLevelIndex) || 0));
  state.trailingStopEnabled = Boolean(payload.trailingStopEnabled);
  state.trailingStopActivationPrice = payload.trailingStopActivationPrice ?? null;
  state.trailingStopDropCents = payload.trailingStopDropCents ?? null;
  state.highestBidSeen = payload.highestBidSeen ?? null;
  state.exitSequence = Math.max(0, Math.floor(Number(payload.exitSequence) || 0));
  refreshTakeProfitTargetPrice(state);
}

function isAnchoredSniperVariant(variant) {
  const mode = String(variant?.decisionMode || "sniper_v2").toLowerCase();
  return !variant?.contrarian && mode === "sniper_v2";
}

function getTakeProfitConfig(variant) {
  const takeProfitEnabled = Boolean(variant?.takeProfitEnabled);
  const price = Number(variant?.takeProfitPrice);
  const levels = normalizeTakeProfitLevels(variant?.takeProfitLevels, takeProfitEnabled ? price : null);
  const grossProfitTargetUsd = Number(variant?.grossProfitTargetUsd);
  const forceExitMinutesLeft = Number(variant?.forceExitMinutesLeft);
  const trailingStopActivationPrice = toFiniteNumber(variant?.trailingStopActivationPrice);
  const trailingStopDropCents = toFiniteNumber(variant?.trailingStopDropCents);
  const trailingStopEnabled =
    Boolean(variant?.trailingStopEnabled) &&
    trailingStopActivationPrice != null &&
    trailingStopDropCents != null &&
    trailingStopDropCents > 0;
  const timeStopEnabled = Number.isFinite(forceExitMinutesLeft) && forceExitMinutesLeft > 0;
  const priceEnabled = takeProfitEnabled && levels.length > 0;
  const grossProfitEnabled = Number.isFinite(grossProfitTargetUsd) && grossProfitTargetUsd > 0;
  return {
    enabled: priceEnabled || grossProfitEnabled || timeStopEnabled || trailingStopEnabled,
    takeProfitEnabled: priceEnabled,
    price: levels[0]?.price ?? (Number.isFinite(price) ? price : null),
    levels,
    grossProfitEnabled,
    grossProfitTargetUsd: grossProfitEnabled ? grossProfitTargetUsd : null,
    timeStopEnabled,
    forceExitMinutesLeft: timeStopEnabled ? forceExitMinutesLeft : null,
    trailingStopEnabled,
    trailingStopActivationPrice: trailingStopEnabled ? trailingStopActivationPrice : null,
    trailingStopDropCents: trailingStopEnabled ? trailingStopDropCents : null
  };
}

function computeLegExitSizing(state, fraction) {
  const remainingShares = toFiniteNumber(state?.sizeShares);
  const remainingNotionalUsd = toFiniteNumber(state?.notionalUsd);
  const initialShares = toFiniteNumber(state?.initialSizeShares);
  const initialNotionalUsd = toFiniteNumber(state?.initialNotionalUsd);
  const targetFraction = Math.max(0, toFiniteNumber(fraction) ?? 0);

  if (
    remainingShares == null ||
    remainingShares <= 0 ||
    remainingNotionalUsd == null ||
    remainingNotionalUsd <= 0 ||
    initialShares == null ||
    initialShares <= 0 ||
    initialNotionalUsd == null ||
    initialNotionalUsd <= 0 ||
    targetFraction <= 0
  ) {
    return { exitShares: null, exitNotionalUsd: null, fractionExited: null };
  }

  const plannedShares = initialShares * targetFraction;
  const plannedNotionalUsd = initialNotionalUsd * targetFraction;
  const exitShares = Math.min(remainingShares, plannedShares);
  const exitNotionalUsd = Math.min(remainingNotionalUsd, plannedNotionalUsd);
  return {
    exitShares,
    exitNotionalUsd,
    fractionExited: exitShares / initialShares
  };
}

function computeFullExitSizing(state) {
  const remainingShares = toFiniteNumber(state?.sizeShares);
  const remainingNotionalUsd = toFiniteNumber(state?.notionalUsd);
  const initialShares = toFiniteNumber(state?.initialSizeShares);
  if (
    remainingShares == null ||
    remainingShares <= 0 ||
    remainingNotionalUsd == null ||
    remainingNotionalUsd <= 0
  ) {
    return { exitShares: null, exitNotionalUsd: null, fractionExited: null };
  }
  return {
    exitShares: remainingShares,
    exitNotionalUsd: remainingNotionalUsd,
    fractionExited:
      initialShares != null && initialShares > 0 ? remainingShares / initialShares : null
  };
}

function updateTrailingHigh(state, bidPrice) {
  const bid = toFiniteNumber(bidPrice);
  const activation = toFiniteNumber(state?.trailingStopActivationPrice);
  if (!state?.trailingStopEnabled || bid == null || activation == null) return;
  if (bid < activation) return;
  if (state.highestBidSeen == null || bid > state.highestBidSeen) {
    state.highestBidSeen = bid;
  }
}

function isTrailingStopTriggered(state, bidPrice) {
  const bid = toFiniteNumber(bidPrice);
  const highestBidSeen = toFiniteNumber(state?.highestBidSeen);
  const drop = toFiniteNumber(state?.trailingStopDropCents);
  const activation = toFiniteNumber(state?.trailingStopActivationPrice);
  if (!state?.trailingStopEnabled || bid == null || highestBidSeen == null || drop == null || activation == null) {
    return false;
  }
  if (highestBidSeen < activation) return false;
  return bid <= highestBidSeen - drop;
}

function applyTakeProfitExitToState(state, {
  exitShares,
  exitNotionalUsd,
  advanceLevel = false
}) {
  const shares = toFiniteNumber(exitShares);
  const notionalUsd = toFiniteNumber(exitNotionalUsd);
  if (shares == null || shares <= 0 || notionalUsd == null || notionalUsd < 0) {
    return {
      remainingShares: toFiniteNumber(state?.sizeShares),
      remainingNotionalUsd: toFiniteNumber(state?.notionalUsd),
      isFinalExit: false,
      exitSequence: state?.exitSequence ?? 0
    };
  }

  const nextRemainingShares = Math.max(0, (toFiniteNumber(state.sizeShares) ?? 0) - shares);
  const nextRemainingNotionalUsd = Math.max(0, (toFiniteNumber(state.notionalUsd) ?? 0) - notionalUsd);
  state.sizeShares = nextRemainingShares;
  state.notionalUsd = nextRemainingNotionalUsd;
  const nextExitSequence = Math.max(0, Math.floor(Number(state.exitSequence) || 0)) + 1;
  state.exitSequence = nextExitSequence;
  if (advanceLevel) {
    state.nextLevelIndex += 1;
  }
  const isFinalExit = nextRemainingShares <= 0.000001 || nextRemainingNotionalUsd <= 0.000001;
  if (isFinalExit) {
    clearTakeProfitState(state);
  } else {
    refreshTakeProfitTargetPrice(state);
  }
  return {
    remainingShares: nextRemainingShares,
    remainingNotionalUsd: nextRemainingNotionalUsd,
    isFinalExit,
    exitSequence: nextExitSequence
  };
}

function hasOpenTrackedPosition(state, marketSlug) {
  return Boolean(state?.active && state.marketSlug === marketSlug);
}

async function recordPaperExitOutcome(client, {
  state,
  strategyKey,
  marketSlug,
  settlementLeftMin,
  upMid,
  downMid,
  upBook,
  downBook,
  dryRun,
  evaluationMethod,
  outcomeCode,
  inferredWinner,
  exitPrice,
  exitReason,
  realizedPnl,
  entryCorrect,
  exitSequence,
  fractionExited,
  sharesExited,
  notionalExitedUsd,
  remainingShares,
  remainingNotionalUsd,
  isFinalExit
}) {
  await insertPaperOutcome(client, {
    entry_id: state.entryId,
    strategy_key: strategyKey,
    market_slug: marketSlug,
    seconds_left_at_eval: Math.max(0, Number(settlementLeftMin || 0) * 60),
    evaluation_method: evaluationMethod,
    up_mid: upMid,
    down_mid: downMid,
    up_best_bid: upBook.bestBid ?? null,
    up_best_ask: upBook.bestAsk ?? null,
    down_best_bid: downBook.bestBid ?? null,
    down_best_ask: downBook.bestAsk ?? null,
    inferred_winner: inferredWinner,
    official_winner: null,
    outcome_code: outcomeCode,
    official_resolution_status: null,
    official_resolution_source: null,
    official_resolved_at: null,
    official_outcome_prices_json: null,
    official_price_to_beat: null,
    official_price_at_close: null,
    entry_chosen_side: state.side,
    entry_correct: entryCorrect,
    pnl_simulated_usd: realizedPnl,
    dry_run: dryRun,
    exit_price: exitPrice,
    exit_reason: exitReason,
    exited_early: true,
    exit_sequence: exitSequence,
    fraction_exited: fractionExited,
    shares_exited: sharesExited,
    notional_exited_usd: notionalExitedUsd,
    remaining_shares: remainingShares,
    remaining_notional_usd: remainingNotionalUsd,
    is_final_exit: isFinalExit
  });
}

function formatRemainingPosition(state) {
  const remainingShares = toFiniteNumber(state?.sizeShares);
  const initialShares = toFiniteNumber(state?.initialSizeShares);
  if (remainingShares == null || initialShares == null || initialShares <= 0) return "rem ?";
  const pct = (remainingShares / initialShares) * 100;
  return `rem ${pct.toFixed(0)}%`;
}

function hasEnoughBookLiquidity({ side, poly, requiredShares, liquiditySide = "ask" }) {
  const needed = Number(requiredShares);
  if (!Number.isFinite(needed) || needed <= 0) return false;
  const book = side === "UP" ? poly?.orderbook?.up : poly?.orderbook?.down;
  const depth = liquiditySide === "bid" ? Number(book?.bidLiquidity) : Number(book?.askLiquidity);
  return Number.isFinite(depth) && depth >= needed;
}

function shouldFireStrategySnapshot(trailMap, marketSlug, settlementLeftMin, entryMinutesLeft) {
  if (!marketSlug || settlementLeftMin == null || !Number.isFinite(Number(settlementLeftMin))) return false;
  const t = Number(settlementLeftMin);
  const w = Number(entryMinutesLeft);
  const prev = trailMap.has(marketSlug) ? trailMap.get(marketSlug) : null;
  if (t <= 0 || t > w) {
    trailMap.set(marketSlug, t);
    return false;
  }
  trailMap.set(marketSlug, t);
  return prev === null || prev > w;
}

function aggregateLines(lineMap) {
  const parts = [];
  for (const [key, value] of lineMap.entries()) {
    if (!value) continue;
    parts.push(`${key}: ${value}`);
  }
  return parts.length ? parts.join(" | ") : null;
}

function sideAskPrice(poly, side) {
  return side === "UP" ? poly?.prices?.up : poly?.prices?.down;
}

function sideBestBid(poly, side) {
  const book = side === "UP" ? poly?.orderbook?.up : poly?.orderbook?.down;
  return book?.bestBid ?? null;
}

function sideBook(poly, side) {
  return side === "UP" ? poly?.orderbook?.up : poly?.orderbook?.down;
}

function computeBookImbalance(book) {
  const bidLiq = toFiniteNumber(book?.bidLiquidity);
  const askLiq = toFiniteNumber(book?.askLiquidity);
  if (bidLiq == null || askLiq == null || askLiq <= 0) return null;
  return bidLiq / askLiq;
}

function computeBookSpread(book) {
  const spread = toFiniteNumber(book?.spread);
  if (spread != null && spread >= 0) return spread;
  const bestBid = toFiniteNumber(book?.bestBid);
  const bestAsk = toFiniteNumber(book?.bestAsk);
  if (bestBid == null || bestAsk == null) return null;
  const fallbackSpread = bestAsk - bestBid;
  return fallbackSpread >= 0 ? fallbackSpread : null;
}

function getPaperExecutionConfig(variant) {
  return {
    fillMode: normalizePaperFillMode(variant?.paperFillMode ?? CONFIG.strategy.paperFillMode, "pessimistic"),
    entrySlippageBps: Math.max(0, Number(variant?.paperEntrySlippageBps ?? CONFIG.strategy.paperEntrySlippageBps) || 0),
    exitSlippageBps: Math.max(0, Number(variant?.paperExitSlippageBps ?? CONFIG.strategy.paperExitSlippageBps) || 0),
    spreadPenaltyFactor: Math.max(0, Number(variant?.paperSpreadPenaltyFactor ?? CONFIG.strategy.paperSpreadPenaltyFactor) || 0)
  };
}

function applyPaperEntryPrice({ basePrice, side, poly, executionConfig }) {
  const spread = computeBookSpread(sideBook(poly, side));
  return applyPaperExecutionPrice({
    action: "buy",
    referencePrice: basePrice,
    spread,
    fillMode: executionConfig.fillMode,
    slippageBps: executionConfig.entrySlippageBps,
    spreadPenaltyFactor: executionConfig.spreadPenaltyFactor
  });
}

function applyPaperExitPrice({ basePrice, side, poly, executionConfig }) {
  const spread = computeBookSpread(sideBook(poly, side));
  return applyPaperExecutionPrice({
    action: "sell",
    referencePrice: basePrice,
    spread,
    fillMode: executionConfig.fillMode,
    slippageBps: executionConfig.exitSlippageBps,
    spreadPenaltyFactor: executionConfig.spreadPenaltyFactor
  });
}

function evaluateDataHealthGuard({ variant, dataHealth }) {
  const oracleLag = toFiniteNumber(dataHealth?.oracleLagMs);
  const binanceLag = toFiniteNumber(dataHealth?.binanceLagMs);
  const snapshotAge = toFiniteNumber(dataHealth?.snapshotAgeMs);

  const maxOracleLagMs = Number(variant?.maxOracleLagMs ?? CONFIG.strategy.maxOracleLagMs);
  const maxBinanceLagMs = Number(variant?.maxBinanceLagMs ?? CONFIG.strategy.maxBinanceLagMs);
  const maxSnapshotAgeMs = Number(variant?.maxSnapshotAgeMs ?? CONFIG.strategy.maxSnapshotAgeMs);

  if (Number.isFinite(maxOracleLagMs) && maxOracleLagMs > 0 && oracleLag != null && oracleLag > maxOracleLagMs) {
    return {
      allowed: false,
      resultCode: "SKIP_ORACLE_STALE",
      line: `DATA STALE: oracle lag ${Math.round(oracleLag)}ms > ${Math.round(maxOracleLagMs)}ms`
    };
  }
  if (Number.isFinite(maxBinanceLagMs) && maxBinanceLagMs > 0 && binanceLag != null && binanceLag > maxBinanceLagMs) {
    return {
      allowed: false,
      resultCode: "SKIP_BINANCE_STALE",
      line: `DATA STALE: binance lag ${Math.round(binanceLag)}ms > ${Math.round(maxBinanceLagMs)}ms`
    };
  }
  if (Number.isFinite(maxSnapshotAgeMs) && maxSnapshotAgeMs > 0 && snapshotAge != null && snapshotAge > maxSnapshotAgeMs) {
    return {
      allowed: false,
      resultCode: "SKIP_SNAPSHOT_STALE",
      line: `DATA STALE: snapshot age ${Math.round(snapshotAge)}ms > ${Math.round(maxSnapshotAgeMs)}ms`
    };
  }
  return { allowed: true, resultCode: null, line: null };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computeGrossExitSnapshot({ bidPrice, sizeShares, notionalUsd }) {
  const bid = toFiniteNumber(bidPrice);
  const shares = toFiniteNumber(sizeShares);
  const cost = toFiniteNumber(notionalUsd);
  if (bid == null || shares == null || shares <= 0 || cost == null || cost <= 0) {
    return { grossExitUsd: null, grossProfitUsd: null };
  }
  const grossExitUsd = bid * shares;
  return {
    grossExitUsd,
    grossProfitUsd: grossExitUsd - cost
  };
}

export function resetStrategyDbStateForTests() {
  resetStrategySchemaFlag();
  resetOutcomeTrailForTests();
  resetLiveClobClient();
  warnedNoDb = false;
  slugMinutesLeftTrailByStrategy.clear();
  sniperStateByStrategy.clear();
  paperTakeProfitStateByStrategy.clear();
  liveTakeProfitStateByStrategy.clear();
  lastPaperLineByStrategy.clear();
  lastLiveLineByStrategy.clear();
  filledMarketsByStrategy.clear();
}

export async function runPaperStrategyTick({
  poly,
  settlementLeftMin,
  dataHealth = null,
  ptbDelta,
  modelUp,
  modelDown,
  marketUp,
  marketDown,
  oraclePrice,
  binanceSpotPrice,
  priceToBeat,
  volAtrUsd,
  volAtrBaseMinutes = null,
  rsiNow,
  macd,
  haNarrative,
  regimeDetected = null,
  variantContexts = {},
  variants: variantSubset = null
}) {
  const s = CONFIG.strategy;
  const paperEnabled = Boolean(s.dryRun);
  if (!s.enabled) return { line: null };
  if (!s.databaseUrl) {
    if (!warnedNoDb) {
      warnedNoDb = true;
      return { line: `${ANSI_YELLOW}Strategy: STRATEGY_ENABLED sem DATABASE_URL${ANSI_RESET}` };
    }
    return { line: null };
  }
  if (!poly?.ok || !poly.market) {
    return {
      line: aggregateLines(lastPaperLineByStrategy),
      liveOrderLine: aggregateLines(lastLiveLineByStrategy)
    };
  }

  const marketSlug = String(poly.market.slug ?? "");
  if (!marketSlug) {
    return {
      line: aggregateLines(lastPaperLineByStrategy),
      liveOrderLine: aggregateLines(lastLiveLineByStrategy)
    };
  }

  const variants = getVariants(variantSubset);
  if (!variants.length) return { line: null };

  const upBook = poly.orderbook?.up ?? {};
  const downBook = poly.orderbook?.down ?? {};
  const upBuy = poly.prices?.up ?? null;
  const downBuy = poly.prices?.down ?? null;
  const upMid = midFromBook(upBook, upBuy);
  const downMid = midFromBook(downBook, downBuy);
  const upBookImbalance = computeBookImbalance(upBook);
  const downBookImbalance = computeBookImbalance(downBook);
  const upSpread = computeBookSpread(upBook);
  const downSpread = computeBookSpread(downBook);

  const pool = getStrategyPool(s.databaseUrl);
  await ensureStrategySchemaOnce(pool);
  const client = await pool.connect();

  try {
    for (const variant of variants) {
      const key = String(variant.key || "default");
      const trail = slugMinutesLeftTrailByStrategy.get(key) ?? new Map();
      slugMinutesLeftTrailByStrategy.set(key, trail);
      const filledSet = filledMarketsByStrategy.get(key) ?? new Set();

      const sniperState = sniperStateByStrategy.get(key) ?? defaultSniperState();
      const paperTakeProfitState = paperTakeProfitStateByStrategy.get(key) ?? defaultTakeProfitState();
      const liveTakeProfitState = liveTakeProfitStateByStrategy.get(key) ?? defaultTakeProfitState();
      const variantContext = variantContexts?.[key] ?? {};
      const tag = paperEnabled ? "DRY" : "LIVE";
      const takeProfit = getTakeProfitConfig(variant);
      const paperExecution = getPaperExecutionConfig(variant);
      const liveEntryOrderType = String(variant?.liveEntryOrderType || "FOK").toUpperCase();
      const liveExitOrderType = String(variant?.liveExitOrderType || liveEntryOrderType || "FOK").toUpperCase();
      let localLiveLine = lastLiveLineByStrategy.get(key) ?? null;
      let localPaperLine = lastPaperLineByStrategy.get(key) ?? null;

      if (!takeProfit.enabled) {
        clearTakeProfitState(paperTakeProfitState);
        clearTakeProfitState(liveTakeProfitState);
      } else {
        if (!paperEnabled) {
          clearTakeProfitState(paperTakeProfitState);
        } else if (!paperTakeProfitState.active) {
          const recoverPaper = await findRecoverablePaperTakeProfitEntry(client, {
            strategyKey: key,
            marketSlug
          });
          if (recoverPaper) {
            const recoverTokenId = recoverPaper.chosen_side === "UP" ? poly.tokens?.upTokenId : poly.tokens?.downTokenId;
            const remainingShares = toFiniteNumber(recoverPaper.remaining_shares ?? recoverPaper.simulated_shares);
            const remainingNotionalUsd = toFiniteNumber(recoverPaper.remaining_notional_usd ?? recoverPaper.notional_usd);
            if (remainingShares != null && remainingShares > 0 && remainingNotionalUsd != null && remainingNotionalUsd > 0) {
              armTakeProfitState(paperTakeProfitState, {
                marketSlug,
                side: recoverPaper.chosen_side,
                tokenId: recoverTokenId,
                targetPrice: takeProfit.price,
                takeProfitLevels: takeProfit.levels,
                sizeShares: Number(recoverPaper.simulated_shares),
                notionalUsd: Number(recoverPaper.notional_usd),
                remainingShares,
                remainingNotionalUsd,
                initialSizeShares: Number(recoverPaper.simulated_shares),
                initialNotionalUsd: Number(recoverPaper.notional_usd),
                entryId: recoverPaper.id,
                entryPrice: Number(recoverPaper.entry_price),
                forceExitMinutesLeft: takeProfit.forceExitMinutesLeft,
                nextLevelIndex: Number(recoverPaper.last_exit_sequence ?? 0),
                exitSequence: Number(recoverPaper.last_exit_sequence ?? 0),
                trailingStopEnabled: takeProfit.trailingStopEnabled,
                trailingStopActivationPrice: takeProfit.trailingStopActivationPrice,
                trailingStopDropCents: takeProfit.trailingStopDropCents
              });
              filledSet.add(marketSlug);
            }
          }
        }

        if (shouldAttemptLiveOrder() && key === CONFIG.strategy.liveStrategyKey && !liveTakeProfitState.active) {
          const recoverLive = await findRecoverableLiveTakeProfitEntry(client, {
            strategyKey: key,
            marketSlug
          });
          if (recoverLive) {
            const remainingShares = toFiniteNumber(recoverLive.remaining_shares ?? recoverLive.size_shares);
            const remainingNotionalUsd = toFiniteNumber(recoverLive.remaining_notional_usd ?? recoverLive.notional_usd);
            if (remainingShares != null && remainingShares > 0 && remainingNotionalUsd != null && remainingNotionalUsd > 0) {
              armTakeProfitState(liveTakeProfitState, {
                marketSlug,
                side: recoverLive.chosen_side,
                tokenId: recoverLive.token_id,
                targetPrice: takeProfit.price,
                takeProfitLevels: takeProfit.levels,
                sizeShares: Number(recoverLive.size_shares),
                notionalUsd: Number(recoverLive.notional_usd),
                remainingShares,
                remainingNotionalUsd,
                initialSizeShares: Number(recoverLive.size_shares),
                initialNotionalUsd: Number(recoverLive.notional_usd),
                entryId: recoverLive.entry_id,
                entryPrice: Number(recoverLive.entry_price),
                forceExitMinutesLeft: takeProfit.forceExitMinutesLeft,
                nextLevelIndex: Number(recoverLive.last_exit_sequence ?? 0),
                exitSequence: Number(recoverLive.last_exit_sequence ?? 0),
                trailingStopEnabled: takeProfit.trailingStopEnabled,
                trailingStopActivationPrice: takeProfit.trailingStopActivationPrice,
                trailingStopDropCents: takeProfit.trailingStopDropCents
              });
              filledSet.add(marketSlug);
              localLiveLine = `${ANSI_YELLOW}EXIT LIVE RECOVERED: ${recoverLive.chosen_side}${takeProfit.takeProfitEnabled ? ` @ ${takeProfit.price.toFixed(2)}` : ""}${ANSI_RESET}`;
            }
          }
        }

        if (paperEnabled && paperTakeProfitState.active) {
          if (paperTakeProfitState.marketSlug !== marketSlug) {
            clearTakeProfitState(paperTakeProfitState);
          } else {
            const bidPrice = toFiniteNumber(sideBestBid(poly, paperTakeProfitState.side));
            const executableBidPrice = bidPrice != null
              ? applyPaperExitPrice({
                basePrice: bidPrice,
                side: paperTakeProfitState.side,
                poly,
                executionConfig: paperExecution
              })
              : null;
            const grossProfitTargetUsd = toFiniteNumber(takeProfit.grossProfitTargetUsd);
            const grossProfitEnabled = grossProfitTargetUsd != null && grossProfitTargetUsd > 0;
            const forceExitMinutesLeft = toFiniteNumber(paperTakeProfitState.forceExitMinutesLeft);
            const timeStopDue =
              forceExitMinutesLeft != null &&
              settlementLeftMin != null &&
              Number.isFinite(Number(settlementLeftMin)) &&
              Number(settlementLeftMin) <= forceExitMinutesLeft;
            updateTrailingHigh(paperTakeProfitState, bidPrice);
            let handledPaperExit = false;
            const paperLevelMessages = [];

            while (paperTakeProfitState.active) {
              const nextLevel = paperTakeProfitState.takeProfitLevels[paperTakeProfitState.nextLevelIndex];
              if (!nextLevel || bidPrice == null || bidPrice < nextLevel.price) break;

              const levelState = { ...paperTakeProfitState };
              const leg = computeLegExitSizing(levelState, nextLevel.fraction);
              if (leg.exitShares == null || leg.exitNotionalUsd == null) break;
              const hasLevelLiquidity = hasEnoughBookLiquidity({
                side: levelState.side,
                poly,
                requiredShares: leg.exitShares,
                liquiditySide: "bid"
              });
              if (!hasLevelLiquidity) {
                localPaperLine = `${ANSI_GRAY}${tag} TP aguardando liquidez @ ${nextLevel.price.toFixed(2)}${ANSI_RESET}`;
                handledPaperExit = true;
                break;
              }

              const executableTargetPrice = applyPaperExitPrice({
                basePrice: nextLevel.price,
                side: levelState.side,
                poly,
                executionConfig: paperExecution
              });
              const realized = computeRealizedExitPnl({
                entryPrice: levelState.entryPrice,
                exitPrice: executableTargetPrice,
                notionalUsd: leg.exitNotionalUsd
              });
              const entryCorrect =
                realized.pnl > 0 ? true : realized.pnl < 0 ? false : null;
              const progress = applyTakeProfitExitToState(paperTakeProfitState, {
                exitShares: leg.exitShares,
                exitNotionalUsd: leg.exitNotionalUsd,
                advanceLevel: true
              });
              await recordPaperExitOutcome(client, {
                state: levelState,
                strategyKey: key,
                marketSlug,
                settlementLeftMin,
                upMid,
                downMid,
                upBook,
                downBook,
                dryRun: s.dryRun,
                evaluationMethod: "take_profit_hit",
                outcomeCode: progress.isFinalExit ? "EXIT_TAKE_PROFIT" : "EXIT_TAKE_PROFIT_PARTIAL",
                inferredWinner: levelState.side,
                exitPrice: executableTargetPrice,
                exitReason: "TAKE_PROFIT",
                realizedPnl: realized.pnl,
                entryCorrect,
                exitSequence: progress.exitSequence,
                fractionExited: leg.fractionExited,
                sharesExited: leg.exitShares,
                notionalExitedUsd: leg.exitNotionalUsd,
                remainingShares: progress.remainingShares,
                remainingNotionalUsd: progress.remainingNotionalUsd,
                isFinalExit: progress.isFinalExit
              });
              paperLevelMessages.push(
                `TP L${progress.exitSequence} ${levelState.side} @${executableTargetPrice.toFixed(3)} (PnL ~$${(realized.pnl ?? 0).toFixed(2)} | ${progress.isFinalExit ? "flat" : formatRemainingPosition({ sizeShares: progress.remainingShares, initialSizeShares: levelState.initialSizeShares })})`
              );
            }

            if (paperLevelMessages.length) {
              localPaperLine = `${ANSI_GREEN}${tag} ${paperLevelMessages.join(" | ")}${ANSI_RESET}`;
              handledPaperExit = true;
            }

            if (!handledPaperExit && paperTakeProfitState.active) {
              const fullExitSizing = computeFullExitSizing(paperTakeProfitState);
              const hasLiquidity = hasEnoughBookLiquidity({
                side: paperTakeProfitState.side,
                poly,
                requiredShares: fullExitSizing.exitShares,
                liquiditySide: "bid"
              });
              const grossExit = computeGrossExitSnapshot({
                bidPrice: executableBidPrice,
                sizeShares: fullExitSizing.exitShares,
                notionalUsd: fullExitSizing.exitNotionalUsd
              });

              if (
                grossProfitEnabled &&
                grossExit.grossProfitUsd != null &&
                grossExit.grossProfitUsd >= grossProfitTargetUsd &&
                executableBidPrice != null &&
                hasLiquidity
              ) {
                const exitState = { ...paperTakeProfitState };
                const realized = computeRealizedExitPnl({
                  entryPrice: exitState.entryPrice,
                  exitPrice: executableBidPrice,
                  notionalUsd: fullExitSizing.exitNotionalUsd
                });
                const entryCorrect = realized.pnl > 0 ? true : realized.pnl < 0 ? false : null;
                const progress = applyTakeProfitExitToState(paperTakeProfitState, {
                  exitShares: fullExitSizing.exitShares,
                  exitNotionalUsd: fullExitSizing.exitNotionalUsd,
                  advanceLevel: false
                });
                await recordPaperExitOutcome(client, {
                  state: exitState,
                  strategyKey: key,
                  marketSlug,
                  settlementLeftMin,
                  upMid,
                  downMid,
                  upBook,
                  downBook,
                  dryRun: s.dryRun,
                  evaluationMethod: "gross_profit_exit",
                  outcomeCode: "EXIT_GROSS_PROFIT",
                  inferredWinner: exitState.side,
                  exitPrice: executableBidPrice,
                  exitReason: "GROSS_PROFIT",
                  realizedPnl: realized.pnl,
                  entryCorrect,
                  exitSequence: progress.exitSequence,
                  fractionExited: fullExitSizing.fractionExited,
                  sharesExited: fullExitSizing.exitShares,
                  notionalExitedUsd: fullExitSizing.exitNotionalUsd,
                  remainingShares: progress.remainingShares,
                  remainingNotionalUsd: progress.remainingNotionalUsd,
                  isFinalExit: progress.isFinalExit
                });
                localPaperLine = `${ANSI_GREEN}${tag} GROSS PROFIT ${exitState.side} @${executableBidPrice.toFixed(3)} (gross +$${grossExit.grossProfitUsd.toFixed(2)})${ANSI_RESET}`;
              } else if (
                grossProfitEnabled &&
                grossExit.grossProfitUsd != null &&
                grossExit.grossProfitUsd >= grossProfitTargetUsd &&
                executableBidPrice != null &&
                !hasLiquidity
              ) {
                localPaperLine = `${ANSI_GRAY}${tag} GROSS PROFIT tocou, mas sem liquidez suficiente no bid${ANSI_RESET}`;
              } else if (isTrailingStopTriggered(paperTakeProfitState, bidPrice)) {
                if (executableBidPrice != null && executableBidPrice > 0 && hasLiquidity) {
                  const exitState = { ...paperTakeProfitState };
                  const realized = computeRealizedExitPnl({
                    entryPrice: exitState.entryPrice,
                    exitPrice: executableBidPrice,
                    notionalUsd: fullExitSizing.exitNotionalUsd
                  });
                  const entryCorrect = realized.pnl > 0 ? true : realized.pnl < 0 ? false : null;
                  const progress = applyTakeProfitExitToState(paperTakeProfitState, {
                    exitShares: fullExitSizing.exitShares,
                    exitNotionalUsd: fullExitSizing.exitNotionalUsd,
                    advanceLevel: false
                  });
                  await recordPaperExitOutcome(client, {
                    state: exitState,
                    strategyKey: key,
                    marketSlug,
                    settlementLeftMin,
                    upMid,
                    downMid,
                    upBook,
                    downBook,
                    dryRun: s.dryRun,
                    evaluationMethod: "trailing_stop_exit",
                    outcomeCode: "EXIT_TRAILING_STOP",
                    inferredWinner: null,
                    exitPrice: executableBidPrice,
                    exitReason: "TRAILING_STOP",
                    realizedPnl: realized.pnl,
                    entryCorrect,
                    exitSequence: progress.exitSequence,
                    fractionExited: fullExitSizing.fractionExited,
                    sharesExited: fullExitSizing.exitShares,
                    notionalExitedUsd: fullExitSizing.exitNotionalUsd,
                    remainingShares: progress.remainingShares,
                    remainingNotionalUsd: progress.remainingNotionalUsd,
                    isFinalExit: progress.isFinalExit
                  });
                  localPaperLine = `${ANSI_YELLOW}${tag} TRAIL STOP ${exitState.side} @${executableBidPrice.toFixed(3)} (PnL ~$${(realized.pnl ?? 0).toFixed(2)})${ANSI_RESET}`;
                } else {
                  localPaperLine = `${ANSI_GRAY}${tag} TRAIL STOP aguardando bid/liquidez${ANSI_RESET}`;
                }
              } else if (timeStopDue) {
                if (executableBidPrice != null && executableBidPrice > 0 && hasLiquidity) {
                  const exitState = { ...paperTakeProfitState };
                  const realized = computeRealizedExitPnl({
                    entryPrice: exitState.entryPrice,
                    exitPrice: executableBidPrice,
                    notionalUsd: fullExitSizing.exitNotionalUsd
                  });
                  const entryCorrect = realized.pnl > 0 ? true : realized.pnl < 0 ? false : null;
                  const progress = applyTakeProfitExitToState(paperTakeProfitState, {
                    exitShares: fullExitSizing.exitShares,
                    exitNotionalUsd: fullExitSizing.exitNotionalUsd,
                    advanceLevel: false
                  });
                  await recordPaperExitOutcome(client, {
                    state: exitState,
                    strategyKey: key,
                    marketSlug,
                    settlementLeftMin,
                    upMid,
                    downMid,
                    upBook,
                    downBook,
                    dryRun: s.dryRun,
                    evaluationMethod: "time_stop_exit",
                    outcomeCode: "EXIT_TIME_STOP",
                    inferredWinner: null,
                    exitPrice: executableBidPrice,
                    exitReason: "TIME_STOP",
                    realizedPnl: realized.pnl,
                    entryCorrect,
                    exitSequence: progress.exitSequence,
                    fractionExited: fullExitSizing.fractionExited,
                    sharesExited: fullExitSizing.exitShares,
                    notionalExitedUsd: fullExitSizing.exitNotionalUsd,
                    remainingShares: progress.remainingShares,
                    remainingNotionalUsd: progress.remainingNotionalUsd,
                    isFinalExit: progress.isFinalExit
                  });
                  localPaperLine = `${ANSI_YELLOW}${tag} TIME STOP ${exitState.side} @${executableBidPrice.toFixed(3)} (PnL ~$${(realized.pnl ?? 0).toFixed(2)})${ANSI_RESET}`;
                } else {
                  localPaperLine = `${ANSI_GRAY}${tag} TIME STOP aguardando bid/liquidez${ANSI_RESET}`;
                }
              }
            }
          }
        }

        if (liveTakeProfitState.active) {
          if (liveTakeProfitState.marketSlug !== marketSlug) {
            clearTakeProfitState(liveTakeProfitState);
          } else {
            const bidPrice = toFiniteNumber(sideBestBid(poly, liveTakeProfitState.side));
            const grossProfitTargetUsd = toFiniteNumber(takeProfit.grossProfitTargetUsd);
            const grossProfitEnabled = grossProfitTargetUsd != null && grossProfitTargetUsd > 0;
            const forceExitMinutesLeft = toFiniteNumber(liveTakeProfitState.forceExitMinutesLeft);
            let liveAvailableShares = toFiniteNumber(liveTakeProfitState.sizeShares);
            if (liveTakeProfitState.tokenId != null) {
              try {
                const liveSellableShares = await readLiveSellableShares(liveTakeProfitState.tokenId);
                if (liveSellableShares != null && liveSellableShares > 0) {
                  liveAvailableShares =
                    liveAvailableShares != null && liveAvailableShares > 0
                      ? Math.min(liveAvailableShares, liveSellableShares)
                      : liveSellableShares;
                }
              } catch {
                // Fallback silencioso: se a leitura do saldo falhar, usamos o lote rastreado.
              }
            }
            const timeStopDue =
              forceExitMinutesLeft != null &&
              settlementLeftMin != null &&
              Number.isFinite(Number(settlementLeftMin)) &&
              Number(settlementLeftMin) <= forceExitMinutesLeft;
            updateTrailingHigh(liveTakeProfitState, bidPrice);
            const targetPrice = toFiniteNumber(liveTakeProfitState.targetPrice);
            const targetText = targetPrice != null ? `TP >= ${targetPrice.toFixed(2)}` : "sem TP";
            const grossProfitText =
              grossProfitEnabled ? ` | gross >= $${grossProfitTargetUsd.toFixed(2)}` : "";
            const trailingText =
              liveTakeProfitState.trailingStopEnabled
                ? ` | trail ${Number(liveTakeProfitState.trailingStopActivationPrice ?? 0).toFixed(2)}-${Number(liveTakeProfitState.trailingStopDropCents ?? 0).toFixed(2)}`
                : "";
            const timeStopText = forceExitMinutesLeft != null ? ` | stop ${forceExitMinutesLeft.toFixed(2)}m` : "";
            localLiveLine = `${ANSI_YELLOW}EXIT monitor ${liveTakeProfitState.side} | ${targetText}${grossProfitText}${trailingText}${timeStopText} (bid ${bidPrice != null ? bidPrice.toFixed(3) : "-"})${ANSI_RESET}`;

            let handledLiveExit = false;
            const liveLevelMessages = [];
            while (liveTakeProfitState.active) {
              const nextLevel = liveTakeProfitState.takeProfitLevels[liveTakeProfitState.nextLevelIndex];
              if (!nextLevel || bidPrice == null || bidPrice < nextLevel.price) break;

              const levelState = { ...liveTakeProfitState };
              const leg = computeLegExitSizing(levelState, nextLevel.fraction);
              if (leg.exitShares == null || leg.exitNotionalUsd == null) break;

              const plannedShares = leg.exitShares;
              const effectiveLevelShares =
                liveAvailableShares != null && liveAvailableShares > 0
                  ? Math.min(plannedShares, liveAvailableShares)
                  : plannedShares;
              if (!Number.isFinite(effectiveLevelShares) || effectiveLevelShares < 0.01) {
                localLiveLine = `${ANSI_GRAY}TP tocou preco, mas sem saldo suficiente para vender${ANSI_RESET}`;
                handledLiveExit = true;
                break;
              }
              const liquidityOk = hasEnoughBookLiquidity({
                side: levelState.side,
                poly,
                requiredShares: effectiveLevelShares,
                liquiditySide: "bid"
              });
              if (!liquidityOk) {
                localLiveLine = `${ANSI_GRAY}TP tocou preco, mas sem liquidez suficiente no bid${ANSI_RESET}`;
                handledLiveExit = true;
                break;
              }

              const shareScale = plannedShares > 0 ? effectiveLevelShares / plannedShares : 1;
              const effectiveNotionalUsd = leg.exitNotionalUsd * shareScale;
              const effectiveFractionExited = leg.fractionExited != null ? leg.fractionExited * shareScale : null;
              try {
                const liveExit = await tryPlaceTakeProfitExitOrder({
                  pgClient: client,
                  entryId: levelState.entryId,
                  strategyKey: key,
                  marketSlug,
                  tokenId: levelState.tokenId,
                  targetPrice: nextLevel.price,
                  triggerPrice: nextLevel.price,
                  sizeShares: effectiveLevelShares,
                  notionalUsd: effectiveNotionalUsd,
                  exitReason: "TAKE_PROFIT",
                  label: "TAKE PROFIT",
                  exitSequence: levelState.exitSequence + 1,
                  fractionExited: effectiveFractionExited,
                  remainingShares: Math.max(0, (toFiniteNumber(levelState.sizeShares) ?? 0) - effectiveLevelShares),
                  isFinalExit: Math.max(0, (toFiniteNumber(levelState.sizeShares) ?? 0) - effectiveLevelShares) <= 0.000001,
                  orderType: liveExitOrderType
                });
                if (!liveExit?.ok) {
                  localLiveLine = liveExit?.line ? `${ANSI_RED}${liveExit.line}${ANSI_RESET}` : localLiveLine;
                  handledLiveExit = true;
                  break;
                }
                const progress = applyTakeProfitExitToState(liveTakeProfitState, {
                  exitShares: effectiveLevelShares,
                  exitNotionalUsd: effectiveNotionalUsd,
                  advanceLevel: shareScale >= 0.999
                });
                liveAvailableShares =
                  liveAvailableShares != null ? Math.max(0, liveAvailableShares - effectiveLevelShares) : liveAvailableShares;
                liveLevelMessages.push(
                  `TP L${progress.exitSequence} ${levelState.side} @${Number(liveExit.filledPrice ?? nextLevel.price).toFixed(3)} (${progress.isFinalExit ? "flat" : formatRemainingPosition({ sizeShares: progress.remainingShares, initialSizeShares: levelState.initialSizeShares })})`
                );
              } catch (err) {
                localLiveLine = `${ANSI_RED}TP LIVE ERRO: ${err.message}${ANSI_RESET}`;
                handledLiveExit = true;
                break;
              }
            }

            if (liveLevelMessages.length) {
              localLiveLine = `${ANSI_GREEN}${liveLevelMessages.join(" | ")}${ANSI_RESET}`;
              handledLiveExit = true;
            }

            if (!handledLiveExit && liveTakeProfitState.active) {
              const fullExitSizing = computeFullExitSizing(liveTakeProfitState);
              const effectiveExitShares =
                liveAvailableShares != null && liveAvailableShares > 0
                  ? Math.min(fullExitSizing.exitShares, liveAvailableShares)
                  : fullExitSizing.exitShares;
              const hasLiquidity = hasEnoughBookLiquidity({
                side: liveTakeProfitState.side,
                poly,
                requiredShares: effectiveExitShares,
                liquiditySide: "bid"
              });
              const shareScale =
                fullExitSizing.exitShares != null && fullExitSizing.exitShares > 0
                  ? effectiveExitShares / fullExitSizing.exitShares
                  : 1;
              const effectiveNotionalUsd = (fullExitSizing.exitNotionalUsd ?? 0) * shareScale;
              const effectiveFractionExited =
                fullExitSizing.fractionExited != null ? fullExitSizing.fractionExited * shareScale : null;
              const grossExit = computeGrossExitSnapshot({
                bidPrice,
                sizeShares: effectiveExitShares,
                notionalUsd: effectiveNotionalUsd
              });

              if (
                grossProfitEnabled &&
                grossExit.grossProfitUsd != null &&
                grossExit.grossProfitUsd >= grossProfitTargetUsd &&
                bidPrice != null &&
                hasLiquidity
              ) {
                try {
                  const exitState = { ...liveTakeProfitState };
                  const liveExit = await tryPlaceTakeProfitExitOrder({
                    pgClient: client,
                    entryId: exitState.entryId,
                    strategyKey: key,
                    marketSlug,
                    tokenId: exitState.tokenId,
                    targetPrice: bidPrice,
                    triggerPrice: bidPrice,
                    sizeShares: effectiveExitShares,
                    notionalUsd: effectiveNotionalUsd,
                    exitReason: "GROSS_PROFIT",
                    label: "GROSS PROFIT",
                    exitSequence: exitState.exitSequence + 1,
                    fractionExited: effectiveFractionExited,
                    remainingShares: Math.max(0, (toFiniteNumber(exitState.sizeShares) ?? 0) - effectiveExitShares),
                    isFinalExit: Math.max(0, (toFiniteNumber(exitState.sizeShares) ?? 0) - effectiveExitShares) <= 0.000001,
                    orderType: liveExitOrderType
                  });
                  localLiveLine = liveExit?.line ? `${liveExit.ok ? ANSI_GREEN : ANSI_RED}${liveExit.line}${ANSI_RESET}` : localLiveLine;
                  if (liveExit?.ok) {
                    applyTakeProfitExitToState(liveTakeProfitState, {
                      exitShares: effectiveExitShares,
                      exitNotionalUsd: effectiveNotionalUsd,
                      advanceLevel: false
                    });
                  }
                } catch (err) {
                  localLiveLine = `${ANSI_RED}GROSS PROFIT LIVE ERRO: ${err.message}${ANSI_RESET}`;
                }
              } else if (
                grossProfitEnabled &&
                grossExit.grossProfitUsd != null &&
                grossExit.grossProfitUsd >= grossProfitTargetUsd &&
                bidPrice != null &&
                !hasLiquidity
              ) {
                localLiveLine = `${ANSI_GRAY}GROSS PROFIT tocou, mas sem liquidez suficiente no bid${ANSI_RESET}`;
              } else if (isTrailingStopTriggered(liveTakeProfitState, bidPrice)) {
                if (bidPrice != null && bidPrice > 0 && hasLiquidity) {
                  try {
                    const exitState = { ...liveTakeProfitState };
                    const liveExit = await tryPlaceTakeProfitExitOrder({
                      pgClient: client,
                      entryId: exitState.entryId,
                      strategyKey: key,
                      marketSlug,
                      tokenId: exitState.tokenId,
                      targetPrice: bidPrice,
                      triggerPrice: bidPrice,
                      sizeShares: effectiveExitShares,
                      notionalUsd: effectiveNotionalUsd,
                      exitReason: "TRAILING_STOP",
                      label: "TRAIL STOP",
                      exitSequence: exitState.exitSequence + 1,
                      fractionExited: effectiveFractionExited,
                      remainingShares: Math.max(0, (toFiniteNumber(exitState.sizeShares) ?? 0) - effectiveExitShares),
                      isFinalExit: Math.max(0, (toFiniteNumber(exitState.sizeShares) ?? 0) - effectiveExitShares) <= 0.000001,
                      orderType: liveExitOrderType
                    });
                    localLiveLine = liveExit?.line ? `${liveExit.ok ? ANSI_GREEN : ANSI_RED}${liveExit.line}${ANSI_RESET}` : localLiveLine;
                    if (liveExit?.ok) {
                      applyTakeProfitExitToState(liveTakeProfitState, {
                        exitShares: effectiveExitShares,
                        exitNotionalUsd: effectiveNotionalUsd,
                        advanceLevel: false
                      });
                    }
                  } catch (err) {
                    localLiveLine = `${ANSI_RED}TRAIL STOP LIVE ERRO: ${err.message}${ANSI_RESET}`;
                  }
                } else {
                  localLiveLine = `${ANSI_GRAY}TRAIL STOP aguardando bid/liquidez${ANSI_RESET}`;
                }
              } else if (timeStopDue) {
                if (bidPrice != null && bidPrice > 0 && hasLiquidity) {
                  try {
                    const exitState = { ...liveTakeProfitState };
                    const liveExit = await tryPlaceTakeProfitExitOrder({
                      pgClient: client,
                      entryId: exitState.entryId,
                      strategyKey: key,
                      marketSlug,
                      tokenId: exitState.tokenId,
                      targetPrice: bidPrice,
                      triggerPrice: bidPrice,
                      sizeShares: effectiveExitShares,
                      notionalUsd: effectiveNotionalUsd,
                      exitReason: "TIME_STOP",
                      label: "TIME STOP",
                      exitSequence: exitState.exitSequence + 1,
                      fractionExited: effectiveFractionExited,
                      remainingShares: Math.max(0, (toFiniteNumber(exitState.sizeShares) ?? 0) - effectiveExitShares),
                      isFinalExit: Math.max(0, (toFiniteNumber(exitState.sizeShares) ?? 0) - effectiveExitShares) <= 0.000001,
                      orderType: liveExitOrderType
                    });
                    localLiveLine = liveExit?.line ? `${liveExit.ok ? ANSI_GREEN : ANSI_RED}${liveExit.line}${ANSI_RESET}` : localLiveLine;
                    if (liveExit?.ok) {
                      applyTakeProfitExitToState(liveTakeProfitState, {
                        exitShares: effectiveExitShares,
                        exitNotionalUsd: effectiveNotionalUsd,
                        advanceLevel: false
                      });
                    }
                  } catch (err) {
                    localLiveLine = `${ANSI_RED}TIME STOP LIVE ERRO: ${err.message}${ANSI_RESET}`;
                  }
                } else {
                  localLiveLine = `${ANSI_GRAY}TIME STOP aguardando bid/liquidez${ANSI_RESET}`;
                }
              }
            }
          }
        }
      }

      if (sniperState.active && sniperState.marketSlug === marketSlug) {
        const askPrice = sideAskPrice(poly, sniperState.side);
        const touchedShares = sniperState.notionalUsd / sniperState.limitPrice;
        const hasLiquidity = hasEnoughBookLiquidity({
          side: sniperState.side,
          poly,
          requiredShares: touchedShares,
          liquiditySide: "ask"
        });

        localLiveLine = `${ANSI_YELLOW}SNIPER: wait ${sniperState.side} @ <= ${sniperState.limitPrice.toFixed(2)} (ask ${askPrice != null ? askPrice.toFixed(3) : "-"})${ANSI_RESET}`;

        if (askPrice != null && Number.isFinite(Number(askPrice)) && Number(askPrice) <= sniperState.limitPrice && hasLiquidity) {
          const touchedEntryPrice = sniperState.limitPrice;
          if (sniperState.entryId != null) {
            await updatePaperSignalExecution(client, {
              id: sniperState.entryId,
              result_code: sniperState.side,
              chosen_side: sniperState.side,
              entry_price: touchedEntryPrice,
              simulated_shares: touchedShares,
              up_buy: upBuy,
              down_buy: downBuy,
              up_mid: upMid,
              down_mid: downMid,
              up_best_bid: upBook.bestBid ?? null,
              up_best_ask: upBook.bestAsk ?? null,
              down_best_bid: downBook.bestBid ?? null,
              down_best_ask: downBook.bestAsk ?? null
            });
          }

          const canLiveTrade = shouldAttemptLiveOrder() && key === CONFIG.strategy.liveStrategyKey;
          let liveEntry = null;

          if (canLiveTrade) {
            try {
              liveEntry = await tryPlaceSniperFokOrder({
                pgClient: client,
                entryId: sniperState.entryId,
                strategyKey: key,
                marketSlug: sniperState.marketSlug,
                tokenId: sniperState.tokenId,
                limitPrice: sniperState.limitPrice,
                notionalUsd: sniperState.notionalUsd,
                orderType: liveEntryOrderType
              });
              localLiveLine = liveEntry?.line
                ? `${liveEntry.ok ? ANSI_GREEN : liveEntry.skipped ? ANSI_GRAY : ANSI_RED}${liveEntry.line}${ANSI_RESET}`
                : null;
            } catch (err) {
              localLiveLine = `${ANSI_RED}SNIPER ERRO: ${err.message}${ANSI_RESET}`;
            }
          } else if (shouldAttemptLiveOrder() && key !== CONFIG.strategy.liveStrategyKey) {
            localLiveLine = `${ANSI_GRAY}Live bloqueado para '${key}' (primary=${CONFIG.strategy.liveStrategyKey})${ANSI_RESET}`;
          } else {
            localLiveLine = `${ANSI_GRAY}SNIPER tocou preco, paper filled @ ${touchedEntryPrice.toFixed(2)}${ANSI_RESET}`;
          }

          if (takeProfit.enabled) {
            filledSet.add(marketSlug);
            armTakeProfitState(paperTakeProfitState, {
              marketSlug,
              side: sniperState.side,
              tokenId: sniperState.tokenId,
              targetPrice: takeProfit.price,
              takeProfitLevels: takeProfit.levels,
              sizeShares: touchedShares,
              notionalUsd: sniperState.notionalUsd,
              initialSizeShares: touchedShares,
              initialNotionalUsd: sniperState.notionalUsd,
              entryId: sniperState.entryId,
              entryPrice: touchedEntryPrice,
              forceExitMinutesLeft: takeProfit.forceExitMinutesLeft,
              trailingStopEnabled: takeProfit.trailingStopEnabled,
              trailingStopActivationPrice: takeProfit.trailingStopActivationPrice,
              trailingStopDropCents: takeProfit.trailingStopDropCents
            });

            if (liveEntry?.ok && canLiveTrade) {
              filledSet.add(marketSlug);
              armTakeProfitState(liveTakeProfitState, {
                marketSlug,
                side: sniperState.side,
                tokenId: sniperState.tokenId,
                targetPrice: takeProfit.price,
                takeProfitLevels: takeProfit.levels,
                sizeShares: Number(liveEntry.sizeShares ?? touchedShares),
                notionalUsd: Number(liveEntry.notionalUsd ?? sniperState.notionalUsd),
                initialSizeShares: Number(liveEntry.sizeShares ?? touchedShares),
                initialNotionalUsd: Number(liveEntry.notionalUsd ?? sniperState.notionalUsd),
                entryId: sniperState.entryId,
                entryPrice: Number(liveEntry.filledPrice ?? touchedEntryPrice),
                forceExitMinutesLeft: takeProfit.forceExitMinutesLeft,
                trailingStopEnabled: takeProfit.trailingStopEnabled,
                trailingStopActivationPrice: takeProfit.trailingStopActivationPrice,
                trailingStopDropCents: takeProfit.trailingStopDropCents
              });
            }
          }

          localPaperLine = `${ANSI_GREEN}${tag} ${sniperState.side} @${touchedEntryPrice.toFixed(3)} ($${sniperState.notionalUsd})${ANSI_RESET}`;
          clearSniperState(sniperState);
        } else if (askPrice != null && Number.isFinite(Number(askPrice)) && Number(askPrice) <= sniperState.limitPrice && !hasLiquidity) {
          localLiveLine = `${ANSI_GRAY}SNIPER tocou preco, mas sem liquidez suficiente no book${ANSI_RESET}`;
        }
      } else if (sniperState.active && sniperState.marketSlug !== marketSlug) {
        if (sniperState.entryId != null) {
          await updatePaperSignalExecution(client, {
            id: sniperState.entryId,
            result_code: "NO_FILL",
            chosen_side: null,
            entry_price: null,
            simulated_shares: null
          });
        }
        clearSniperState(sniperState);
        localLiveLine = null;
        localPaperLine = `${ANSI_GRAY}${tag} NO_FILL${ANSI_RESET}`;
      }

      const isContinuous = variant.decisionMode === "cheap_revert";
      const hasOpenPosition =
        hasOpenTrackedPosition(paperTakeProfitState, marketSlug) ||
        hasOpenTrackedPosition(liveTakeProfitState, marketSlug) ||
        (sniperState.active && sniperState.marketSlug === marketSlug);
      const hasEnteredMarket = filledSet.has(marketSlug);

      let shouldEval = false;
      if (isContinuous) {
        const t = settlementLeftMin;
        const w = variant.entryMinutesLeft;
        const c = variant.entryCloseMinutesLeft ?? 5.0; // Padrão 5 minutos caso não informado
        if (t != null && t <= w && t >= c && !hasOpenPosition && !hasEnteredMarket) {
          shouldEval = true;
        }
      } else {
        shouldEval = shouldFireStrategySnapshot(trail, marketSlug, settlementLeftMin, variant.entryMinutesLeft);
      }

      if (!shouldEval) {
        sniperStateByStrategy.set(key, sniperState);
        paperTakeProfitStateByStrategy.set(key, paperTakeProfitState);
        liveTakeProfitStateByStrategy.set(key, liveTakeProfitState);
        lastLiveLineByStrategy.set(key, localLiveLine);
        lastPaperLineByStrategy.set(key, localPaperLine);
        filledMarketsByStrategy.set(key, filledSet);
        continue;
      }

      const decision = decideLateWindowSide({
        decisionMode: variant.decisionMode,
        minutesLeft: settlementLeftMin,
        entryMinutesLeft: variant.entryMinutesLeft,
        upMid,
        downMid,
        upBuy,
        downBuy,
        upBookImbalance,
        downBookImbalance,
        upSpread,
        downSpread,
        modelUp,
        modelDown,
        marketUp,
        marketDown,
        targetEntryPrice: variant.targetEntryPrice,
        minEntryPrice: variant.minEntryPrice,
        minEdge: variant.minEdge,
        minModelProb: variant.minModelProb,
        minBookImbalance: variant.minBookImbalance,
        maxSpreadToEdgeRatio: variant.maxSpreadToEdgeRatio,
        entryPriceTiers: variant.entryPriceTiers,
        maxSumMids: variant.maxSumMids,
        minSumMids: variant.minSumMids,
        binaryDiscountBonus: variant.binaryDiscountBonus,
        volAtrUsd,
        sniperDeltaFloorUsd: variant.sniperDeltaFloorUsd,
        sniperDeltaAtrMult: variant.sniperDeltaAtrMult,
        epsilon: variant.priceEpsilon,
        ptbDelta,
        rsiNow,
        macd,
        haNarrative,
        regimeDetected,
        regimeGateEnabled: variant.regimeGateEnabled,
        regimeTrendEdgeMultiplier: variant.regimeTrendEdgeMultiplier,
        oracleLagMs: dataHealth?.oracleLagMs,
        oracleLagBonusEnabled: variant.oracleLagBonusEnabled,
        oracleLagBonusMinMs: variant.oracleLagBonusMinMs,
        oracleLagBonusMinDelta: variant.oracleLagBonusMinDelta,
        oracleLagBonusEdge: variant.oracleLagBonusEdge,
        crossMarketUpMid: variantContext?.crossMarketUpMid ?? null,
        crossMarketDownMid: variantContext?.crossMarketDownMid ?? null,
        crossMarketMaxDivergence: variant.crossMarketMaxDivergence,
        crossMarketEdgeBonus: variant.crossMarketEdgeBonus,
        crossMarketRequired: variant.crossMarketRequired
      });

      if (!decision.inWindow) {
        sniperStateByStrategy.set(key, sniperState);
        paperTakeProfitStateByStrategy.set(key, paperTakeProfitState);
        liveTakeProfitStateByStrategy.set(key, liveTakeProfitState);
        lastLiveLineByStrategy.set(key, localLiveLine);
        lastPaperLineByStrategy.set(key, localPaperLine);
        filledMarketsByStrategy.set(key, filledSet);
        continue;
      }

      let effectiveDecision = decision;

      if (variant.contrarian && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")) {
        const flippedSide = effectiveDecision.side === "UP" ? "DOWN" : "UP";
        effectiveDecision = {
          ...effectiveDecision,
          side: flippedSide,
          result: `CONTRA_${effectiveDecision.result ?? effectiveDecision.side}`
        };
      }

      const anchoredSniper = isAnchoredSniperVariant(variant);
      let entryPrice = null;
      let simulatedShares = null;
      let activeNotionalUsd = Math.max(0.01, Number(variant.notionalUsd) || 1);
      let sizingDetails = null;

      if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
        if (variant.contrarian) {
          const sideBuy = effectiveDecision.side === "UP" ? upBuy : downBuy;
          if (sideBuy != null && Number.isFinite(Number(sideBuy)) && Number(sideBuy) > 0) {
            entryPrice = Number(sideBuy);
          } else {
            effectiveDecision = { ...effectiveDecision, side: null, result: "SKIP_NO_BUY_PRICE" };
          }
        } else {
          const mode = String(variant.decisionMode || "sniper_v2").toLowerCase();
          if (mode === "main_2m_mid" || mode === "cheap_revert") {
            const sideBuy = effectiveDecision.side === "UP" ? upBuy : downBuy;
            if (sideBuy != null && Number.isFinite(Number(sideBuy)) && Number(sideBuy) > 0) {
              entryPrice = Number(sideBuy);
            } else {
              effectiveDecision = { ...effectiveDecision, side: null, result: "SKIP_NO_BUY_PRICE" };
            }
          } else {
            entryPrice = variant.targetEntryPrice;
          }
        }
      }

      if (paperEnabled && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") && entryPrice != null) {
        const modeledEntryPrice = applyPaperEntryPrice({
          basePrice: entryPrice,
          side: effectiveDecision.side,
          poly,
          executionConfig: paperExecution
        });
        if (modeledEntryPrice != null) {
          entryPrice = modeledEntryPrice;
        }
      }

      if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
        const dataHealthCheck = evaluateDataHealthGuard({ variant, dataHealth });
        if (!dataHealthCheck.allowed) {
          effectiveDecision = { ...effectiveDecision, side: null, result: dataHealthCheck.resultCode };
          localLiveLine = `${ANSI_GRAY}${dataHealthCheck.line}${ANSI_RESET}`;
        }
      }

      if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
        const asym = evaluateAsymmetryGuard({
          entryPrice,
          maxEntryPrice: variant.maxEntryPrice,
          minPayoutMultiple: variant.minPayoutMultiple
        });
        if (!asym.allowed) {
          effectiveDecision = { ...effectiveDecision, side: null, result: asym.resultCode };
          localLiveLine = `${ANSI_GRAY}${asym.line}${ANSI_RESET}`;
        }
      }

      if (variant.riskGuardsEnabled && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")) {
        const risk = await evaluateRiskStatsGuard({
          pgClient: client,
          strategyKey: key,
          maxConsecutiveLosses: variant.maxConsecutiveLosses,
          rollingLossHours: variant.rollingLossHours,
          maxRollingLossUsd: variant.maxRollingLossUsd,
          maxDailyLossUsd: variant.maxDailyLossUsd,
          riskDayTimezone: variant.riskDayTimezone
        });
        if (!risk.allowed) {
          effectiveDecision = { ...effectiveDecision, side: null, result: risk.resultCode };
          localLiveLine = `${ANSI_GRAY}${risk.line}${ANSI_RESET}`;
        }
      }

      if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
        sizingDetails = chooseStrategyNotional({
          variantNotionalUsd: variant.notionalUsd,
          sizingMode: variant.sizingMode,
          side: effectiveDecision.side,
          selectedModelProb: effectiveDecision?.selectedModelProb ?? null,
          selectedMarketProb: effectiveDecision?.selectedMarketProb ?? null,
          modelUp,
          modelDown,
          marketUp,
          marketDown,
          entryPrice,
          kellyFraction: variant.kellyFraction,
          kellyMinNotionalUsd: variant.kellyMinNotionalUsd,
          kellyMaxNotionalUsd: variant.kellyMaxNotionalUsd
        });
        const nextNotional = Number(sizingDetails?.notionalUsd);
        if (Number.isFinite(nextNotional) && nextNotional > 0) {
          activeNotionalUsd = nextNotional;
        }
      }

      if ((effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") && !anchoredSniper) {
        simulatedShares = activeNotionalUsd / entryPrice;
        if (!hasEnoughBookLiquidity({
          side: effectiveDecision.side,
          poly,
          requiredShares: simulatedShares,
          liquiditySide: "ask"
        })) {
          effectiveDecision = { ...effectiveDecision, side: null, result: "SKIP_NO_LIQUIDITY" };
          simulatedShares = null;
          entryPrice = null;
        }
      }

      if (isContinuous && !effectiveDecision.side) {
        // Em monitoramento contínuo, se não gerou entrada (ex: SKIP_TOO_EXPENSIVE), não registramos no DB.
        // Apenas atualizamos a linha do console para mostrar que estamos aguardando o preço.
        localLiveLine = localLiveLine || null; // mantem asymetria/warnings
        const upBuyN = Number(upBuy);
        const downBuyN = Number(downBuy);
        const cheapObserved =
          Number.isFinite(upBuyN) && Number.isFinite(downBuyN)
            ? Math.min(upBuyN, downBuyN)
            : null;
        const monitorDetails = [
          cheapObserved != null ? `cheap=${cheapObserved.toFixed(2)}` : null,
          Number.isFinite(Number(effectiveDecision?.selectedModelProb))
            ? `model=${Number(effectiveDecision.selectedModelProb).toFixed(3)}`
            : null,
          Number.isFinite(Number(effectiveDecision?.selectedEdge))
            ? `edge=${Number(effectiveDecision.selectedEdge).toFixed(3)}`
            : null,
          Number.isFinite(Number(effectiveDecision?.maxEntryPrice))
            ? `maxEntry=${Number(effectiveDecision.maxEntryPrice).toFixed(2)}`
            : null,
          Number.isFinite(Number(effectiveDecision?.requiredModelProb))
            ? `reqModel=${Number(effectiveDecision.requiredModelProb).toFixed(3)}`
            : null,
          Number.isFinite(Number(effectiveDecision?.requiredEdge))
            ? `reqEdge=${Number(effectiveDecision.requiredEdge).toFixed(3)}`
            : null,
          Number.isFinite(Number(effectiveDecision?.selectedBookImbalance))
            ? `book=${Number(effectiveDecision.selectedBookImbalance).toFixed(2)}`
            : null,
          Number.isFinite(Number(effectiveDecision?.requiredBookImbalance))
            ? `reqBook=${Number(effectiveDecision.requiredBookImbalance).toFixed(2)}`
            : null,
          Number.isFinite(Number(effectiveDecision?.crossMarketDivergence))
            ? `xDiv=${Number(effectiveDecision.crossMarketDivergence).toFixed(3)}`
            : null
        ].filter(Boolean).join(" | ");
        const reasonText = monitorDetails
          ? `${effectiveDecision.result}; ${monitorDetails}`
          : effectiveDecision.result;
        localPaperLine = `${ANSI_GRAY}${tag} MONITOR (${variant.decisionMode}): aguardando opp (${reasonText})${ANSI_RESET}`;
        sniperStateByStrategy.set(key, sniperState);
        paperTakeProfitStateByStrategy.set(key, paperTakeProfitState);
        liveTakeProfitStateByStrategy.set(key, liveTakeProfitState);
        lastLiveLineByStrategy.set(key, localLiveLine);
        lastPaperLineByStrategy.set(key, localPaperLine);
        filledMarketsByStrategy.set(key, filledSet);
        continue;
      }

      const endDate = poly.market.endDate ? new Date(poly.market.endDate) : null;
      const marketEndAt = endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : null;

      const paperResultCode =
        anchoredSniper && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")
          ? `ARMED_${effectiveDecision.side}`
          : effectiveDecision.result;
      const paperChosenSide = anchoredSniper ? null : effectiveDecision.side;
      const paperEntryPrice = anchoredSniper ? null : entryPrice;
      const paperSimulatedShares = anchoredSniper ? null : simulatedShares;
      const configHash = buildVariantConfigHash(variant);
      const entryAttributionContext = buildEntryAttributionContext({
        variant,
        effectiveDecision,
        paperResultCode,
        settlementLeftMin,
        activeNotionalUsd,
        entryPrice: paperEntryPrice,
        simulatedShares: paperSimulatedShares,
        upMid,
        downMid,
        upBuy,
        downBuy,
        upSpread,
        downSpread,
        upBookImbalance,
        downBookImbalance,
        modelUp,
        modelDown,
        marketUp,
        marketDown,
        ptbDelta,
        oraclePrice,
        binanceSpotPrice,
        priceToBeat,
        volAtrUsd,
        volAtrBaseMinutes,
        rsiNow,
        macd,
        haNarrative,
        dataHealth,
        sizingDetails
      });

      const signalRecord = await ensurePaperSignal(client, {
        strategy_key: key,
        market_slug: marketSlug,
        condition_id: poly.market.conditionId != null
          ? String(poly.market.conditionId)
          : poly.market.condition_id != null
            ? String(poly.market.condition_id)
            : null,
        market_end_at: marketEndAt,
        minutes_left: settlementLeftMin,
        up_mid: upMid,
        down_mid: downMid,
        up_buy: upBuy,
        down_buy: downBuy,
        up_best_bid: upBook.bestBid ?? null,
        up_best_ask: upBook.bestAsk ?? null,
        down_best_bid: downBook.bestBid ?? null,
        down_best_ask: downBook.bestAsk ?? null,
        result_code: paperResultCode,
        chosen_side: paperChosenSide,
        notional_usd: activeNotionalUsd,
        entry_price: paperEntryPrice,
        simulated_shares: paperSimulatedShares,
        dry_run: s.dryRun,
        oracle_price: oraclePrice ?? null,
        binance_spot_price: binanceSpotPrice ?? null,
        price_to_beat: priceToBeat ?? null,
        ptb_delta_usd: ptbDelta ?? null,
        model_prob_up: modelUp ?? null,
        market_prob_up: marketUp ?? null,
        edge_up:
          Number.isFinite(Number(modelUp)) && Number.isFinite(Number(marketUp))
            ? Number(modelUp) - Number(marketUp)
            : null,
        vol_atr_usd: volAtrUsd ?? null,
        vol_atr_base_minutes: volAtrBaseMinutes ?? null,
        selected_model_prob: effectiveDecision?.selectedModelProb ?? null,
        selected_market_prob: effectiveDecision?.selectedMarketProb ?? null,
        selected_edge: effectiveDecision?.selectedEdge ?? null,
        selected_base_edge: effectiveDecision?.selectedBaseEdge ?? null,
        book_imbalance:
          effectiveDecision?.selectedBookImbalance ??
          ((effectiveDecision?.side === "UP" || effectiveDecision?.side === "DOWN")
            ? computeBookImbalance(sideBook(poly, effectiveDecision.side))
            : null),
        selected_spread:
          effectiveDecision?.selectedSpread ??
          ((effectiveDecision?.side === "UP" || effectiveDecision?.side === "DOWN")
            ? computeBookSpread(sideBook(poly, effectiveDecision.side))
            : null),
        binary_sum_mids: effectiveDecision?.binarySumMids ?? null,
        binary_discount: effectiveDecision?.binaryDiscount ?? null,
        oracle_lag_bonus: effectiveDecision?.oracleLagEdgeBonus ?? null,
        cross_market_consistency: effectiveDecision?.crossMarketConsistency ?? null,
        cross_market_divergence: effectiveDecision?.crossMarketDivergence ?? null,
        regime_detected: effectiveDecision?.regimeDetected ?? null,
        entry_reason_code: effectiveDecision?.result ?? null,
        entry_context_json: entryAttributionContext,
        config_hash: configHash,
        git_commit: runtimeGitCommit
      });
      const signalId = signalRecord.id;
      let liveEntry = null;
      let canLiveTrade = false;

      if (signalId != null && anchoredSniper && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")) {
        const tokenId = effectiveDecision.side === "UP" ? poly.tokens?.upTokenId : poly.tokens?.downTokenId;
        if (tokenId) {
          sniperState.active = true;
          sniperState.marketSlug = marketSlug;
          sniperState.side = effectiveDecision.side;
          sniperState.tokenId = String(tokenId);
          sniperState.limitPrice = entryPrice;
          sniperState.notionalUsd = activeNotionalUsd;
          sniperState.entryId = signalId;
          localLiveLine = `${ANSI_YELLOW}SNIPER ARMED: ${effectiveDecision.side} <= ${entryPrice.toFixed(2)}${ANSI_RESET}`;
        } else {
          localLiveLine = `${ANSI_RED}CLOB: tokenId ausente${ANSI_RESET}`;
        }
      } else if (signalId != null && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")) {
        const tokenId = effectiveDecision.side === "UP" ? poly.tokens?.upTokenId : poly.tokens?.downTokenId;
        canLiveTrade = shouldAttemptLiveOrder() && key === CONFIG.strategy.liveStrategyKey;

        if (canLiveTrade && tokenId) {
          try {
            liveEntry = await tryPlaceSniperFokOrder({
              pgClient: client,
              entryId: signalId,
              strategyKey: key,
              marketSlug,
              tokenId,
              limitPrice: entryPrice,
              notionalUsd: activeNotionalUsd,
              orderType: liveEntryOrderType,
              maxAcceptablePrice: variant.maxEntryPrice
            });
            localLiveLine = liveEntry?.line
              ? `${liveEntry.ok ? ANSI_GREEN : liveEntry.skipped ? ANSI_GRAY : ANSI_RED}${liveEntry.line}${ANSI_RESET}`
              : null;
          } catch (err) {
            localLiveLine = `${ANSI_RED}LIVE ENTRY ERRO: ${err.message}${ANSI_RESET}`;
          }
        } else if (shouldAttemptLiveOrder() && key !== CONFIG.strategy.liveStrategyKey) {
          localLiveLine = `${ANSI_GRAY}Live bloqueado para '${key}' (primary=${CONFIG.strategy.liveStrategyKey})${ANSI_RESET}`;
        } else if (shouldAttemptLiveOrder() && !tokenId) {
          localLiveLine = `${ANSI_RED}CLOB: tokenId ausente${ANSI_RESET}`;
        } else {
          localLiveLine = null;
        }

        if (paperEnabled && takeProfit.enabled) {
          filledSet.add(marketSlug);
          armTakeProfitState(paperTakeProfitState, {
            marketSlug,
            side: effectiveDecision.side,
            tokenId,
            targetPrice: takeProfit.price,
            takeProfitLevels: takeProfit.levels,
            sizeShares: simulatedShares,
            notionalUsd: activeNotionalUsd,
            initialSizeShares: simulatedShares,
            initialNotionalUsd: activeNotionalUsd,
            entryId: signalId,
            entryPrice,
            forceExitMinutesLeft: takeProfit.forceExitMinutesLeft,
            trailingStopEnabled: takeProfit.trailingStopEnabled,
            trailingStopActivationPrice: takeProfit.trailingStopActivationPrice,
            trailingStopDropCents: takeProfit.trailingStopDropCents
          });
        }

        if (liveEntry?.ok && canLiveTrade) {
          filledSet.add(marketSlug);
          if (takeProfit.enabled) {
            armTakeProfitState(liveTakeProfitState, {
              marketSlug,
              side: effectiveDecision.side,
              tokenId,
              targetPrice: takeProfit.price,
              takeProfitLevels: takeProfit.levels,
              sizeShares: Number(liveEntry.sizeShares ?? simulatedShares),
              notionalUsd: Number(liveEntry.notionalUsd ?? activeNotionalUsd),
              initialSizeShares: Number(liveEntry.sizeShares ?? simulatedShares),
              initialNotionalUsd: Number(liveEntry.notionalUsd ?? activeNotionalUsd),
              entryId: signalId,
              entryPrice: Number(liveEntry.filledPrice ?? entryPrice),
              forceExitMinutesLeft: takeProfit.forceExitMinutesLeft,
              trailingStopEnabled: takeProfit.trailingStopEnabled,
              trailingStopActivationPrice: takeProfit.trailingStopActivationPrice,
              trailingStopDropCents: takeProfit.trailingStopDropCents
            });
          }
        }
      } else if (signalId != null) {
        localLiveLine = null;
      }

      if (anchoredSniper && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")) {
        localPaperLine = `${ANSI_YELLOW}${tag} ARMED ${effectiveDecision.side} <= ${entryPrice?.toFixed(3) ?? "?"} ($${activeNotionalUsd.toFixed(2)})${ANSI_RESET}`;
      } else if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
        if (paperEnabled) {
          localPaperLine = `${ANSI_GREEN}${tag} ${effectiveDecision.side} @${entryPrice?.toFixed(3) ?? "?"} ($${activeNotionalUsd.toFixed(2)})${ANSI_RESET}`;
        } else if (liveEntry?.ok) {
          localPaperLine = `${ANSI_GREEN}LIVE ENTRY ${effectiveDecision.side} @${Number(liveEntry.filledPrice ?? entryPrice)?.toFixed?.(3) ?? "?"} ($${activeNotionalUsd.toFixed(2)})${ANSI_RESET}`;
        } else if (canLiveTrade) {
          localPaperLine = `${ANSI_YELLOW}LIVE SIGNAL ${effectiveDecision.side} @${entryPrice?.toFixed(3) ?? "?"} ($${activeNotionalUsd.toFixed(2)})${ANSI_RESET}`;
        } else {
          localPaperLine = `${ANSI_GRAY}SIGNAL ${effectiveDecision.side} @${entryPrice?.toFixed(3) ?? "?"} ($${activeNotionalUsd.toFixed(2)})${ANSI_RESET}`;
        }
      } else {
        localPaperLine = `${ANSI_GRAY}${tag} ${effectiveDecision.result} (UP ${upMid?.toFixed?.(3) ?? "-"} vs DOWN ${downMid?.toFixed?.(3) ?? "-"})${ANSI_RESET}`;
      }

      sniperStateByStrategy.set(key, sniperState);
      paperTakeProfitStateByStrategy.set(key, paperTakeProfitState);
      liveTakeProfitStateByStrategy.set(key, liveTakeProfitState);
      lastLiveLineByStrategy.set(key, localLiveLine);
      lastPaperLineByStrategy.set(key, localPaperLine);
      filledMarketsByStrategy.set(key, filledSet);
    }

    return {
      inserted: true,
      line: aggregateLines(lastPaperLineByStrategy),
      liveOrderLine: aggregateLines(lastLiveLineByStrategy)
    };
  } catch (e) {
    return { line: `${ANSI_RED}Strategy DB: ${e?.message ?? e}${ANSI_RESET}`, error: String(e?.message ?? e) };
  } finally {
    client.release();
  }
}
