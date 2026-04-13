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
const enteredMarketsByStrategy = new Map();
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
      grossProfitTargetUsd: variant?.grossProfitTargetUsd ?? null,
      forceExitMinutesLeft: variant?.forceExitMinutesLeft ?? null,
      minEdge: variant?.minEdge ?? null,
      minModelProb: variant?.minModelProb ?? null,
      minBookImbalance: variant?.minBookImbalance ?? null,
      maxSpreadToEdgeRatio: variant?.maxSpreadToEdgeRatio ?? null,
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
      marketSeriesSlug: variant?.marketSeriesSlug ?? null
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
    selected_book_imbalance: toFiniteNumber(effectiveDecision?.selectedBookImbalance),
    selected_spread: toFiniteNumber(effectiveDecision?.selectedSpread),
    ptb_delta_usd: toFiniteNumber(ptbDelta),
    oracle_price: toFiniteNumber(oraclePrice),
    binance_spot_price: toFiniteNumber(binanceSpotPrice),
    price_to_beat: toFiniteNumber(priceToBeat),
    vol_atr_usd: toFiniteNumber(volAtrUsd),
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
      grossProfitTargetUsd: CONFIG.strategy.grossProfitTargetUsd,
      forceExitMinutesLeft: CONFIG.strategy.forceExitMinutesLeft,
      minEdge: CONFIG.strategy.minEdge,
      minModelProb: CONFIG.strategy.minModelProb,
      minBookImbalance: CONFIG.strategy.minBookImbalance,
      maxSpreadToEdgeRatio: CONFIG.strategy.maxSpreadToEdgeRatio,
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
    entryId: null,
    entryPrice: null,
    forceExitMinutesLeft: null
  };
}

function clearSniperState(state) {
  Object.assign(state, defaultSniperState());
}

function clearTakeProfitState(state) {
  Object.assign(state, defaultTakeProfitState());
}

function armTakeProfitState(state, payload) {
  state.active = true;
  state.marketSlug = payload.marketSlug;
  state.side = payload.side;
  state.tokenId = payload.tokenId != null ? String(payload.tokenId) : null;
  state.targetPrice = payload.targetPrice;
  state.sizeShares = payload.sizeShares;
  state.notionalUsd = payload.notionalUsd;
  state.entryId = payload.entryId;
  state.entryPrice = payload.entryPrice;
  state.forceExitMinutesLeft = payload.forceExitMinutesLeft ?? null;
}

function isAnchoredSniperVariant(variant) {
  const mode = String(variant?.decisionMode || "sniper_v2").toLowerCase();
  return !variant?.contrarian && mode === "sniper_v2";
}

function getTakeProfitConfig(variant) {
  const takeProfitEnabled = Boolean(variant?.takeProfitEnabled);
  const price = Number(variant?.takeProfitPrice);
  const grossProfitTargetUsd = Number(variant?.grossProfitTargetUsd);
  const forceExitMinutesLeft = Number(variant?.forceExitMinutesLeft);
  const timeStopEnabled = Number.isFinite(forceExitMinutesLeft) && forceExitMinutesLeft > 0;
  const priceEnabled = takeProfitEnabled && Number.isFinite(price) && price > 0 && price < 1;
  const grossProfitEnabled = Number.isFinite(grossProfitTargetUsd) && grossProfitTargetUsd > 0;
  return {
    enabled: priceEnabled || grossProfitEnabled || timeStopEnabled,
    takeProfitEnabled: priceEnabled,
    price,
    grossProfitEnabled,
    grossProfitTargetUsd: grossProfitEnabled ? grossProfitTargetUsd : null,
    timeStopEnabled,
    forceExitMinutesLeft: timeStopEnabled ? forceExitMinutesLeft : null
  };
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
  enteredMarketsByStrategy.clear();
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
  rsiNow,
  macd,
  haNarrative,
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

      const sniperState = sniperStateByStrategy.get(key) ?? defaultSniperState();
      const paperTakeProfitState = paperTakeProfitStateByStrategy.get(key) ?? defaultTakeProfitState();
      const liveTakeProfitState = liveTakeProfitStateByStrategy.get(key) ?? defaultTakeProfitState();
      const enteredSet = enteredMarketsByStrategy.get(key) ?? new Set();
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
            armTakeProfitState(paperTakeProfitState, {
              marketSlug,
              side: recoverPaper.chosen_side,
              tokenId: recoverTokenId,
              targetPrice: takeProfit.price,
              sizeShares: Number(recoverPaper.simulated_shares),
              notionalUsd: Number(recoverPaper.notional_usd),
              entryId: recoverPaper.id,
              entryPrice: Number(recoverPaper.entry_price),
              forceExitMinutesLeft: takeProfit.forceExitMinutesLeft
            });
            enteredSet.add(marketSlug);
          }
        }

        if (shouldAttemptLiveOrder() && key === CONFIG.strategy.liveStrategyKey && !liveTakeProfitState.active) {
          const recoverLive = await findRecoverableLiveTakeProfitEntry(client, {
            strategyKey: key,
            marketSlug
          });
          if (recoverLive) {
            armTakeProfitState(liveTakeProfitState, {
              marketSlug,
              side: recoverLive.chosen_side,
              tokenId: recoverLive.token_id,
              targetPrice: takeProfit.price,
              sizeShares: Number(recoverLive.size_shares),
              notionalUsd: Number(recoverLive.notional_usd),
              entryId: recoverLive.entry_id,
              entryPrice: Number(recoverLive.entry_price),
              forceExitMinutesLeft: takeProfit.forceExitMinutesLeft
            });
            enteredSet.add(marketSlug);
            localLiveLine = `${ANSI_YELLOW}EXIT LIVE RECOVERED: ${recoverLive.chosen_side}${takeProfit.takeProfitEnabled ? ` @ ${takeProfit.price.toFixed(2)}` : ""}${ANSI_RESET}`;
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
            const hasLiquidity = hasEnoughBookLiquidity({
              side: paperTakeProfitState.side,
              poly,
              requiredShares: paperTakeProfitState.sizeShares,
              liquiditySide: "bid"
            });
            const targetPrice = toFiniteNumber(paperTakeProfitState.targetPrice);
            const executableTargetPrice = targetPrice != null
              ? applyPaperExitPrice({
                basePrice: targetPrice,
                side: paperTakeProfitState.side,
                poly,
                executionConfig: paperExecution
              })
              : null;
            const grossProfitTargetUsd = toFiniteNumber(takeProfit.grossProfitTargetUsd);
            const forceExitMinutesLeft = toFiniteNumber(paperTakeProfitState.forceExitMinutesLeft);
            const grossExit = computeGrossExitSnapshot({
              bidPrice: executableBidPrice,
              sizeShares: paperTakeProfitState.sizeShares,
              notionalUsd: paperTakeProfitState.notionalUsd
            });
            const timeStopDue =
              forceExitMinutesLeft != null &&
              settlementLeftMin != null &&
              Number.isFinite(Number(settlementLeftMin)) &&
              Number(settlementLeftMin) <= forceExitMinutesLeft;

            if (targetPrice != null && bidPrice != null && bidPrice >= targetPrice && hasLiquidity) {
              const realized = computeRealizedExitPnl({
                entryPrice: paperTakeProfitState.entryPrice,
                exitPrice: executableTargetPrice,
                notionalUsd: paperTakeProfitState.notionalUsd
              });
              await insertPaperOutcome(client, {
                entry_id: paperTakeProfitState.entryId,
                strategy_key: key,
                market_slug: marketSlug,
                seconds_left_at_eval: Math.max(0, Number(settlementLeftMin || 0) * 60),
                evaluation_method: "take_profit_hit",
                up_mid: upMid,
                down_mid: downMid,
                up_best_bid: upBook.bestBid ?? null,
                up_best_ask: upBook.bestAsk ?? null,
                down_best_bid: downBook.bestBid ?? null,
                down_best_ask: downBook.bestAsk ?? null,
                inferred_winner: paperTakeProfitState.side,
                official_winner: null,
                outcome_code: "EXIT_TAKE_PROFIT",
                official_resolution_status: null,
                official_resolution_source: null,
                official_resolved_at: null,
                official_outcome_prices_json: null,
                official_price_to_beat: null,
                official_price_at_close: null,
                entry_chosen_side: paperTakeProfitState.side,
                entry_correct: true,
                pnl_simulated_usd: realized.pnl,
                dry_run: s.dryRun,
                exit_price: executableTargetPrice,
                exit_reason: "TAKE_PROFIT",
                exited_early: true
              });
              localPaperLine = `${ANSI_GREEN}${tag} TP ${paperTakeProfitState.side} @${executableTargetPrice.toFixed(3)} (PnL ~$${(realized.pnl ?? 0).toFixed(2)})${ANSI_RESET}`;
              clearTakeProfitState(paperTakeProfitState);
            } else if (targetPrice != null && bidPrice != null && bidPrice >= targetPrice && !hasLiquidity) {
              localPaperLine = `${ANSI_GRAY}${tag} TP aguardando liquidez @ ${targetPrice.toFixed(2)}${ANSI_RESET}`;
            } else if (
              grossProfitTargetUsd != null &&
              grossExit.grossProfitUsd != null &&
              grossExit.grossProfitUsd >= grossProfitTargetUsd &&
              bidPrice != null &&
              hasLiquidity
            ) {
              const realized = computeRealizedExitPnl({
                entryPrice: paperTakeProfitState.entryPrice,
                exitPrice: executableBidPrice,
                notionalUsd: paperTakeProfitState.notionalUsd
              });
              await insertPaperOutcome(client, {
                entry_id: paperTakeProfitState.entryId,
                strategy_key: key,
                market_slug: marketSlug,
                seconds_left_at_eval: Math.max(0, Number(settlementLeftMin || 0) * 60),
                evaluation_method: "gross_profit_exit",
                up_mid: upMid,
                down_mid: downMid,
                up_best_bid: upBook.bestBid ?? null,
                up_best_ask: upBook.bestAsk ?? null,
                down_best_bid: downBook.bestBid ?? null,
                down_best_ask: downBook.bestAsk ?? null,
                inferred_winner: paperTakeProfitState.side,
                official_winner: null,
                outcome_code: "EXIT_GROSS_PROFIT",
                official_resolution_status: null,
                official_resolution_source: null,
                official_resolved_at: null,
                official_outcome_prices_json: null,
                official_price_to_beat: null,
                official_price_at_close: null,
                entry_chosen_side: paperTakeProfitState.side,
                entry_correct: true,
                pnl_simulated_usd: realized.pnl,
                dry_run: s.dryRun,
                exit_price: executableBidPrice,
                exit_reason: "GROSS_PROFIT",
                exited_early: true
              });
              localPaperLine = `${ANSI_GREEN}${tag} GROSS PROFIT ${paperTakeProfitState.side} @${executableBidPrice.toFixed(3)} (gross +$${grossExit.grossProfitUsd.toFixed(2)})${ANSI_RESET}`;
              clearTakeProfitState(paperTakeProfitState);
            } else if (
              grossProfitTargetUsd != null &&
              grossExit.grossProfitUsd != null &&
              grossExit.grossProfitUsd >= grossProfitTargetUsd &&
              executableBidPrice != null &&
              !hasLiquidity
            ) {
              localPaperLine = `${ANSI_GRAY}${tag} GROSS PROFIT tocou, mas sem liquidez suficiente no bid${ANSI_RESET}`;
            } else if (timeStopDue) {
              if (executableBidPrice != null && executableBidPrice > 0 && hasLiquidity) {
                const realized = computeRealizedExitPnl({
                  entryPrice: paperTakeProfitState.entryPrice,
                  exitPrice: executableBidPrice,
                  notionalUsd: paperTakeProfitState.notionalUsd
                });
                const entryCorrect =
                  realized.pnl > 0 ? true : realized.pnl < 0 ? false : null;
                await insertPaperOutcome(client, {
                  entry_id: paperTakeProfitState.entryId,
                  strategy_key: key,
                  market_slug: marketSlug,
                  seconds_left_at_eval: Math.max(0, Number(settlementLeftMin || 0) * 60),
                  evaluation_method: "time_stop_exit",
                  up_mid: upMid,
                  down_mid: downMid,
                  up_best_bid: upBook.bestBid ?? null,
                  up_best_ask: upBook.bestAsk ?? null,
                  down_best_bid: downBook.bestBid ?? null,
                  down_best_ask: downBook.bestAsk ?? null,
                  inferred_winner: null,
                  official_winner: null,
                  outcome_code: "EXIT_TIME_STOP",
                  official_resolution_status: null,
                  official_resolution_source: null,
                  official_resolved_at: null,
                  official_outcome_prices_json: null,
                  official_price_to_beat: null,
                  official_price_at_close: null,
                  entry_chosen_side: paperTakeProfitState.side,
                  entry_correct: entryCorrect,
                  pnl_simulated_usd: realized.pnl,
                  dry_run: s.dryRun,
                  exit_price: executableBidPrice,
                  exit_reason: "TIME_STOP",
                  exited_early: true
                });
                localPaperLine = `${ANSI_YELLOW}${tag} TIME STOP ${paperTakeProfitState.side} @${executableBidPrice.toFixed(3)} (PnL ~$${(realized.pnl ?? 0).toFixed(2)})${ANSI_RESET}`;
                clearTakeProfitState(paperTakeProfitState);
              } else {
                localPaperLine = `${ANSI_GRAY}${tag} TIME STOP aguardando bid/liquidez${ANSI_RESET}`;
              }
            }
          }
        }

        if (liveTakeProfitState.active) {
          if (liveTakeProfitState.marketSlug !== marketSlug) {
            clearTakeProfitState(liveTakeProfitState);
          } else {
            const bidPrice = toFiniteNumber(sideBestBid(poly, liveTakeProfitState.side));
            const targetPrice = toFiniteNumber(liveTakeProfitState.targetPrice);
            const grossProfitTargetUsd = toFiniteNumber(takeProfit.grossProfitTargetUsd);
            const forceExitMinutesLeft = toFiniteNumber(liveTakeProfitState.forceExitMinutesLeft);
            let effectiveExitShares = toFiniteNumber(liveTakeProfitState.sizeShares);
            if (liveTakeProfitState.tokenId != null) {
              try {
                const liveSellableShares = await readLiveSellableShares(liveTakeProfitState.tokenId);
                if (liveSellableShares != null && liveSellableShares > 0) {
                  effectiveExitShares =
                    effectiveExitShares != null && effectiveExitShares > 0
                      ? Math.min(effectiveExitShares, liveSellableShares)
                      : liveSellableShares;
                }
              } catch {
                // Fallback silencioso: se a leitura do saldo falhar, usamos o lote rastreado.
              }
            }
            const hasLiquidity = hasEnoughBookLiquidity({
              side: liveTakeProfitState.side,
              poly,
              requiredShares: effectiveExitShares,
              liquiditySide: "bid"
            });
            const grossExit = computeGrossExitSnapshot({
              bidPrice,
              sizeShares: effectiveExitShares,
              notionalUsd: liveTakeProfitState.notionalUsd
            });
            const timeStopDue =
              forceExitMinutesLeft != null &&
              settlementLeftMin != null &&
              Number.isFinite(Number(settlementLeftMin)) &&
              Number(settlementLeftMin) <= forceExitMinutesLeft;
            const targetText = targetPrice != null ? `TP >= ${targetPrice.toFixed(2)}` : "sem TP";
            const grossProfitText =
              grossProfitTargetUsd != null ? ` | gross >= $${grossProfitTargetUsd.toFixed(2)}` : "";
            const timeStopText = forceExitMinutesLeft != null ? ` | stop ${forceExitMinutesLeft.toFixed(2)}m` : "";
            localLiveLine = `${ANSI_YELLOW}EXIT monitor ${liveTakeProfitState.side} | ${targetText}${grossProfitText}${timeStopText} (bid ${bidPrice != null ? bidPrice.toFixed(3) : "-"})${ANSI_RESET}`;

            if (targetPrice != null && bidPrice != null && bidPrice >= targetPrice && hasLiquidity) {
              try {
                const liveExit = await tryPlaceTakeProfitExitOrder({
                  pgClient: client,
                  entryId: liveTakeProfitState.entryId,
                  strategyKey: key,
                  marketSlug,
                  tokenId: liveTakeProfitState.tokenId,
                  targetPrice,
                  triggerPrice: targetPrice,
                  sizeShares: effectiveExitShares,
                  notionalUsd: liveTakeProfitState.notionalUsd,
                  exitReason: "TAKE_PROFIT",
                  label: "TAKE PROFIT",
                  orderType: liveExitOrderType
                });
                localLiveLine = liveExit?.line ? `${liveExit.ok ? ANSI_GREEN : ANSI_RED}${liveExit.line}${ANSI_RESET}` : localLiveLine;
                if (liveExit?.ok) clearTakeProfitState(liveTakeProfitState);
              } catch (err) {
                localLiveLine = `${ANSI_RED}TP LIVE ERRO: ${err.message}${ANSI_RESET}`;
              }
            } else if (targetPrice != null && bidPrice != null && bidPrice >= targetPrice && !hasLiquidity) {
              localLiveLine = `${ANSI_GRAY}TP tocou preco, mas sem liquidez suficiente no bid${ANSI_RESET}`;
            } else if (
              grossProfitTargetUsd != null &&
              grossExit.grossProfitUsd != null &&
              grossExit.grossProfitUsd >= grossProfitTargetUsd &&
              bidPrice != null &&
              hasLiquidity
            ) {
              try {
                const liveExit = await tryPlaceTakeProfitExitOrder({
                  pgClient: client,
                  entryId: liveTakeProfitState.entryId,
                  strategyKey: key,
                  marketSlug,
                  tokenId: liveTakeProfitState.tokenId,
                  targetPrice: bidPrice,
                  triggerPrice: bidPrice,
                  sizeShares: effectiveExitShares,
                  notionalUsd: liveTakeProfitState.notionalUsd,
                  exitReason: "GROSS_PROFIT",
                  label: "GROSS PROFIT",
                  orderType: liveExitOrderType
                });
                localLiveLine = liveExit?.line ? `${liveExit.ok ? ANSI_GREEN : ANSI_RED}${liveExit.line}${ANSI_RESET}` : localLiveLine;
                if (liveExit?.ok) clearTakeProfitState(liveTakeProfitState);
              } catch (err) {
                localLiveLine = `${ANSI_RED}GROSS PROFIT LIVE ERRO: ${err.message}${ANSI_RESET}`;
              }
            } else if (
              grossProfitTargetUsd != null &&
              grossExit.grossProfitUsd != null &&
              grossExit.grossProfitUsd >= grossProfitTargetUsd &&
              bidPrice != null &&
              !hasLiquidity
            ) {
              localLiveLine = `${ANSI_GRAY}GROSS PROFIT tocou, mas sem liquidez suficiente no bid${ANSI_RESET}`;
            } else if (timeStopDue) {
              if (bidPrice != null && bidPrice > 0 && hasLiquidity) {
                try {
                  const liveExit = await tryPlaceTakeProfitExitOrder({
                    pgClient: client,
                    entryId: liveTakeProfitState.entryId,
                    strategyKey: key,
                    marketSlug,
                    tokenId: liveTakeProfitState.tokenId,
                    targetPrice: bidPrice,
                    triggerPrice: bidPrice,
                    sizeShares: effectiveExitShares,
                    notionalUsd: liveTakeProfitState.notionalUsd,
                    exitReason: "TIME_STOP",
                    label: "TIME STOP",
                    orderType: liveExitOrderType
                  });
                  localLiveLine = liveExit?.line ? `${liveExit.ok ? ANSI_GREEN : ANSI_RED}${liveExit.line}${ANSI_RESET}` : localLiveLine;
                  if (liveExit?.ok) clearTakeProfitState(liveTakeProfitState);
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
            armTakeProfitState(paperTakeProfitState, {
              marketSlug,
              side: sniperState.side,
              tokenId: sniperState.tokenId,
              targetPrice: takeProfit.price,
              sizeShares: touchedShares,
              notionalUsd: sniperState.notionalUsd,
              entryId: sniperState.entryId,
              entryPrice: touchedEntryPrice,
              forceExitMinutesLeft: takeProfit.forceExitMinutesLeft
            });

            if (liveEntry?.ok && canLiveTrade) {
              armTakeProfitState(liveTakeProfitState, {
                marketSlug,
                side: sniperState.side,
                tokenId: sniperState.tokenId,
                targetPrice: takeProfit.price,
                sizeShares: Number(liveEntry.sizeShares ?? touchedShares),
                notionalUsd: Number(liveEntry.notionalUsd ?? sniperState.notionalUsd),
                entryId: sniperState.entryId,
                entryPrice: Number(liveEntry.filledPrice ?? touchedEntryPrice),
                forceExitMinutesLeft: takeProfit.forceExitMinutesLeft
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
      const marketAlreadyActive =
        enteredSet.has(marketSlug) ||
        (paperTakeProfitState.active && paperTakeProfitState.marketSlug === marketSlug) ||
        (liveTakeProfitState.active && liveTakeProfitState.marketSlug === marketSlug);

      let shouldEval = false;
      if (isContinuous) {
        const t = settlementLeftMin;
        const w = variant.entryMinutesLeft;
        const c = variant.entryCloseMinutesLeft ?? 5.0; // Padrão 5 minutos caso não informado
        if (t != null && t <= w && t >= c && !marketAlreadyActive) {
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
        enteredMarketsByStrategy.set(key, enteredSet);
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
        volAtrUsd,
        sniperDeltaFloorUsd: variant.sniperDeltaFloorUsd,
        sniperDeltaAtrMult: variant.sniperDeltaAtrMult,
        epsilon: variant.priceEpsilon,
        ptbDelta,
        rsiNow,
        macd,
        haNarrative
      });

      if (!decision.inWindow) {
        sniperStateByStrategy.set(key, sniperState);
        paperTakeProfitStateByStrategy.set(key, paperTakeProfitState);
        liveTakeProfitStateByStrategy.set(key, liveTakeProfitState);
        lastLiveLineByStrategy.set(key, localLiveLine);
        lastPaperLineByStrategy.set(key, localPaperLine);
        enteredMarketsByStrategy.set(key, enteredSet);
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
        localPaperLine = `${ANSI_GRAY}${tag} MONITOR (${variant.decisionMode}): aguardando opp (${effectiveDecision.result})${ANSI_RESET}`;
        sniperStateByStrategy.set(key, sniperState);
        paperTakeProfitStateByStrategy.set(key, paperTakeProfitState);
        liveTakeProfitStateByStrategy.set(key, liveTakeProfitState);
        lastLiveLineByStrategy.set(key, localLiveLine);
        lastPaperLineByStrategy.set(key, localPaperLine);
        enteredMarketsByStrategy.set(key, enteredSet);
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
        selected_model_prob: effectiveDecision?.selectedModelProb ?? null,
        selected_market_prob: effectiveDecision?.selectedMarketProb ?? null,
        selected_edge: effectiveDecision?.selectedEdge ?? null,
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
          armTakeProfitState(paperTakeProfitState, {
            marketSlug,
            side: effectiveDecision.side,
            tokenId,
            targetPrice: takeProfit.price,
            sizeShares: simulatedShares,
            notionalUsd: activeNotionalUsd,
            entryId: signalId,
            entryPrice,
            forceExitMinutesLeft: takeProfit.forceExitMinutesLeft
          });
          enteredSet.add(marketSlug);
        }

        if (liveEntry?.ok && canLiveTrade) {
          enteredSet.add(marketSlug);
          if (takeProfit.enabled) {
            armTakeProfitState(liveTakeProfitState, {
              marketSlug,
              side: effectiveDecision.side,
              tokenId,
              targetPrice: takeProfit.price,
              sizeShares: Number(liveEntry.sizeShares ?? simulatedShares),
              notionalUsd: activeNotionalUsd,
              entryId: signalId,
              entryPrice: Number(liveEntry.filledPrice ?? entryPrice),
              forceExitMinutesLeft: takeProfit.forceExitMinutesLeft
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
