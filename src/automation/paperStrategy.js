import { CONFIG } from "../config.js";
import { midFromBook } from "../strategy/pricing.js";
import { decideLateWindowSide } from "../strategy/lateWindow.js";
import { getStrategyPool, ensureStrategySchemaOnce, insertPaperSignal, resetStrategySchemaFlag, updatePaperSignalExecution } from "../db/postgresStrategy.js";
import { resetOutcomeTrailForTests } from "./paperOutcome.js";
import { resetLiveClobClient } from "./liveClob.js";
import { shouldAttemptLiveOrder, tryPlaceSniperFokOrder } from "./liveEntryOrder.js";
import { evaluateAsymmetryGuard, evaluateRiskStatsGuard } from "./riskGuards.js";

const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

let warnedNoDb = false;

const slugMinutesLeftTrailByStrategy = new Map();
const sniperStateByStrategy = new Map();
const lastPaperLineByStrategy = new Map();
const lastLiveLineByStrategy = new Map();

function getVariants() {
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
      maxEntryPrice: CONFIG.strategy.maxEntryPrice
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

function isAnchoredSniperVariant(variant) {
  const mode = String(variant?.decisionMode || "sniper_v2").toLowerCase();
  return !variant?.contrarian && mode === "sniper_v2";
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

export function resetStrategyDbStateForTests() {
  resetStrategySchemaFlag();
  resetOutcomeTrailForTests();
  resetLiveClobClient();
  warnedNoDb = false;
  slugMinutesLeftTrailByStrategy.clear();
  sniperStateByStrategy.clear();
  lastPaperLineByStrategy.clear();
  lastLiveLineByStrategy.clear();
}

export async function runPaperStrategyTick({
  poly,
  settlementLeftMin,
  ptbDelta,
  rsiNow,
  macd,
  haNarrative
}) {
  const s = CONFIG.strategy;
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

  const variants = getVariants();
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
      let localLiveLine = lastLiveLineByStrategy.get(key) ?? null;
      let localPaperLine = lastPaperLineByStrategy.get(key) ?? null;

      if (sniperState.active && sniperState.marketSlug === marketSlug) {
        const askPrice = sniperState.side === "UP" ? poly.prices?.up : poly.prices?.down;
        localLiveLine = `${ANSI_YELLOW}SNIPER: wait ${sniperState.side} @ <= ${sniperState.limitPrice.toFixed(2)} (ask ${askPrice != null ? askPrice.toFixed(3) : "-"})${ANSI_RESET}`;

        if (askPrice != null && Number.isFinite(Number(askPrice)) && Number(askPrice) <= sniperState.limitPrice) {
          const touchedEntryPrice = sniperState.limitPrice;
          const touchedShares = sniperState.notionalUsd / touchedEntryPrice;
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
          if (canLiveTrade) {
            try {
              const live = await tryPlaceSniperFokOrder({
                pgClient: client,
                entryId: sniperState.entryId,
                marketSlug: sniperState.marketSlug,
                tokenId: sniperState.tokenId,
                limitPrice: sniperState.limitPrice,
                notionalUsd: sniperState.notionalUsd
              });
              localLiveLine = live?.line ? `${live.ok ? ANSI_GREEN : ANSI_RED}${live.line}${ANSI_RESET}` : null;
            } catch (err) {
              localLiveLine = `${ANSI_RED}SNIPER ERRO: ${err.message}${ANSI_RESET}`;
            }
          } else if (shouldAttemptLiveOrder() && key !== CONFIG.strategy.liveStrategyKey) {
            localLiveLine = `${ANSI_GRAY}Live bloqueado para '${key}' (primary=${CONFIG.strategy.liveStrategyKey})${ANSI_RESET}`;
          } else {
            localLiveLine = `${ANSI_GRAY}SNIPER tocou preco, paper filled @ ${touchedEntryPrice.toFixed(2)}${ANSI_RESET}`;
          }
          localPaperLine = `${ANSI_GREEN}${s.dryRun ? "DRY" : "LIVE"} ${sniperState.side} @${touchedEntryPrice.toFixed(3)} ($${sniperState.notionalUsd})${ANSI_RESET}`;
          sniperState.active = false;
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
        sniperState.active = false;
        localLiveLine = null;
        localPaperLine = `${ANSI_GRAY}${s.dryRun ? "DRY" : "LIVE"} NO_FILL${ANSI_RESET}`;
      }

      if (!shouldFireStrategySnapshot(trail, marketSlug, settlementLeftMin, variant.entryMinutesLeft)) {
        sniperStateByStrategy.set(key, sniperState);
        lastLiveLineByStrategy.set(key, localLiveLine);
        lastPaperLineByStrategy.set(key, localPaperLine);
        continue;
      }

      const decision = decideLateWindowSide({
        decisionMode: variant.decisionMode,
        minutesLeft: settlementLeftMin,
        entryMinutesLeft: variant.entryMinutesLeft,
        upMid,
        downMid,
        epsilon: variant.priceEpsilon,
        ptbDelta,
        rsiNow,
        macd,
        haNarrative
      });

      if (!decision.inWindow) {
        sniperStateByStrategy.set(key, sniperState);
        lastLiveLineByStrategy.set(key, localLiveLine);
        lastPaperLineByStrategy.set(key, localPaperLine);
        continue;
      }

      let effectiveDecision = decision;

      // ── Lógica CONTRÁRIA: inverte a ponta após a decisão original ──────────
      // Se a variante é contrarian, entramos no lado oposto ao que o modelo recomenda.
      // Isso garante que o timing e sinal base são idênticos à estratégia original,
      // mas a aposta é na ponta contrária (para descobrir viés sistemático do modelo).
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
          // Contrarian usa SEMPRE o preço real do livro da ponta que entrou
          // (pois a ponta cara não tem âncora fixa — dependemos do book ao vivo)
          const sideBuy = effectiveDecision.side === "UP" ? upBuy : downBuy;
          if (sideBuy != null && Number.isFinite(Number(sideBuy)) && Number(sideBuy) > 0) {
            entryPrice = Number(sideBuy);
          } else {
            effectiveDecision = { ...effectiveDecision, side: null, result: "SKIP_NO_BUY_PRICE" };
          }
        } else {
          const mode = String(variant.decisionMode || "sniper_v2").toLowerCase();
          if (mode === "main_2m_mid") {
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
      }

      const endDate = poly.market.endDate ? new Date(poly.market.endDate) : null;
      const marketEndAt = endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : null;

      const paperResultCode = anchoredSniper && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")
        ? `ARMED_${effectiveDecision.side}`
        : effectiveDecision.result;
      const paperChosenSide = anchoredSniper ? null : effectiveDecision.side;
      const paperEntryPrice = anchoredSniper ? null : entryPrice;
      const paperSimulatedShares = anchoredSniper ? null : simulatedShares;

      const insertResult = await insertPaperSignal(client, {
        strategy_key: key,
        market_slug: marketSlug,
        condition_id: poly.market.conditionId != null ? String(poly.market.conditionId) : poly.market.condition_id != null ? String(poly.market.condition_id) : null,
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

      if (insertResult.inserted && anchoredSniper && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")) {
        const tokenId = effectiveDecision.side === "UP" ? poly.tokens?.upTokenId : poly.tokens?.downTokenId;
        if (tokenId) {
          sniperState.active = true;
          sniperState.marketSlug = marketSlug;
          sniperState.side = effectiveDecision.side;
          sniperState.tokenId = String(tokenId);
          sniperState.limitPrice = entryPrice;
          sniperState.notionalUsd = variant.notionalUsd;
          sniperState.entryId = insertResult.id;
          localLiveLine = `${ANSI_YELLOW}SNIPER ARMED: ${effectiveDecision.side} <= ${entryPrice.toFixed(2)}${ANSI_RESET}`;
        } else {
          localLiveLine = `${ANSI_RED}CLOB: tokenId ausente${ANSI_RESET}`;
        }
      } else if (insertResult.inserted) {
        localLiveLine = null;
      }

      const tag = s.dryRun ? "DRY" : "LIVE";
      if (anchoredSniper && (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")) {
        localPaperLine = `${ANSI_YELLOW}${tag} ARMED ${effectiveDecision.side} <= ${entryPrice?.toFixed(3) ?? "?"} ($${variant.notionalUsd})${ANSI_RESET}`;
      } else if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
        localPaperLine = `${ANSI_GREEN}${tag} ${effectiveDecision.side} @${entryPrice?.toFixed(3) ?? "?"} ($${variant.notionalUsd})${ANSI_RESET}`;
      } else {
        localPaperLine = `${ANSI_GRAY}${tag} ${effectiveDecision.result} (UP ${upMid?.toFixed?.(3) ?? "-"} vs DOWN ${downMid?.toFixed?.(3) ?? "-"})${ANSI_RESET}`;
      }

      sniperStateByStrategy.set(key, sniperState);
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
