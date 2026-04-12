import { CONFIG } from "../config.js";
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
import { midFromBook } from "../strategy/pricing.js";
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
      forceExitMinutesLeft: CONFIG.strategy.forceExitMinutesLeft
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
  ptbDelta,
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
            const hasLiquidity = hasEnoughBookLiquidity({
              side: paperTakeProfitState.side,
              poly,
              requiredShares: paperTakeProfitState.sizeShares,
              liquiditySide: "bid"
            });
            const targetPrice = toFiniteNumber(paperTakeProfitState.targetPrice);
            const grossProfitTargetUsd = toFiniteNumber(takeProfit.grossProfitTargetUsd);
            const forceExitMinutesLeft = toFiniteNumber(paperTakeProfitState.forceExitMinutesLeft);
            const grossExit = computeGrossExitSnapshot({
              bidPrice,
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
                exitPrice: targetPrice,
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
                exit_price: targetPrice,
                exit_reason: "TAKE_PROFIT",
                exited_early: true
              });
              localPaperLine = `${ANSI_GREEN}${tag} TP ${paperTakeProfitState.side} @${targetPrice.toFixed(3)} (PnL ~$${(realized.pnl ?? 0).toFixed(2)})${ANSI_RESET}`;
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
                exitPrice: bidPrice,
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
                exit_price: bidPrice,
                exit_reason: "GROSS_PROFIT",
                exited_early: true
              });
              localPaperLine = `${ANSI_GREEN}${tag} GROSS PROFIT ${paperTakeProfitState.side} @${bidPrice.toFixed(3)} (gross +$${grossExit.grossProfitUsd.toFixed(2)})${ANSI_RESET}`;
              clearTakeProfitState(paperTakeProfitState);
            } else if (
              grossProfitTargetUsd != null &&
              grossExit.grossProfitUsd != null &&
              grossExit.grossProfitUsd >= grossProfitTargetUsd &&
              bidPrice != null &&
              !hasLiquidity
            ) {
              localPaperLine = `${ANSI_GRAY}${tag} GROSS PROFIT tocou, mas sem liquidez suficiente no bid${ANSI_RESET}`;
            } else if (timeStopDue) {
              if (bidPrice != null && bidPrice > 0 && hasLiquidity) {
                const realized = computeRealizedExitPnl({
                  entryPrice: paperTakeProfitState.entryPrice,
                  exitPrice: bidPrice,
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
                  exit_price: bidPrice,
                  exit_reason: "TIME_STOP",
                  exited_early: true
                });
                localPaperLine = `${ANSI_YELLOW}${tag} TIME STOP ${paperTakeProfitState.side} @${bidPrice.toFixed(3)} (PnL ~$${(realized.pnl ?? 0).toFixed(2)})${ANSI_RESET}`;
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
                notionalUsd: sniperState.notionalUsd,
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
        targetEntryPrice: variant.targetEntryPrice,
        minEntryPrice: variant.minEntryPrice,
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
          maxRollingLossUsd: variant.maxRollingLossUsd
        });
        if (!risk.allowed) {
          effectiveDecision = { ...effectiveDecision, side: null, result: risk.resultCode };
          localLiveLine = `${ANSI_GRAY}${risk.line}${ANSI_RESET}`;
        }
      }

      if ((effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") && !anchoredSniper) {
        simulatedShares = variant.notionalUsd / entryPrice;
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
        notional_usd: variant.notionalUsd,
        entry_price: paperEntryPrice,
        simulated_shares: paperSimulatedShares,
        dry_run: s.dryRun
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
          sniperState.notionalUsd = variant.notionalUsd;
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
              notionalUsd: variant.notionalUsd,
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
            notionalUsd: variant.notionalUsd,
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
              notionalUsd: variant.notionalUsd,
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
        localPaperLine = `${ANSI_YELLOW}${tag} ARMED ${effectiveDecision.side} <= ${entryPrice?.toFixed(3) ?? "?"} ($${variant.notionalUsd})${ANSI_RESET}`;
      } else if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
        if (paperEnabled) {
          localPaperLine = `${ANSI_GREEN}${tag} ${effectiveDecision.side} @${entryPrice?.toFixed(3) ?? "?"} ($${variant.notionalUsd})${ANSI_RESET}`;
        } else if (liveEntry?.ok) {
          localPaperLine = `${ANSI_GREEN}LIVE ENTRY ${effectiveDecision.side} @${Number(liveEntry.filledPrice ?? entryPrice)?.toFixed?.(3) ?? "?"} ($${variant.notionalUsd})${ANSI_RESET}`;
        } else if (canLiveTrade) {
          localPaperLine = `${ANSI_YELLOW}LIVE SIGNAL ${effectiveDecision.side} @${entryPrice?.toFixed(3) ?? "?"} ($${variant.notionalUsd})${ANSI_RESET}`;
        } else {
          localPaperLine = `${ANSI_GRAY}SIGNAL ${effectiveDecision.side} @${entryPrice?.toFixed(3) ?? "?"} ($${variant.notionalUsd})${ANSI_RESET}`;
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
