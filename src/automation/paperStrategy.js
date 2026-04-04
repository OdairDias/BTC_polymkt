import { CONFIG } from "../config.js";
import { midFromBook } from "../strategy/pricing.js";
import { decideLateWindowSide } from "../strategy/lateWindow.js";
import { getStrategyPool, ensureStrategySchemaOnce, insertPaperSignal, resetStrategySchemaFlag } from "../db/postgresStrategy.js";
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

/** slug -> último minutes_left visto (para disparar só ao entrar na janela) */
const slugMinutesLeftTrail = new Map();

let sniperState = {
  active: false,
  marketSlug: null,
  side: null,
  tokenId: null,
  limitPrice: null,
  notionalUsd: null,
  entryId: null
};

let lastPaperLine = null;
let lastLiveOrderLine = null;

export function resetStrategyDbStateForTests() {
  resetStrategySchemaFlag();
  resetOutcomeTrailForTests();
  resetLiveClobClient();
  warnedNoDb = false;
  slugMinutesLeftTrail.clear();
  sniperState.active = false;
  lastPaperLine = null;
  lastLiveOrderLine = null;
}

function shouldFireStrategySnapshot(marketSlug, settlementLeftMin, entryMinutesLeft) {
  if (!marketSlug || settlementLeftMin == null || !Number.isFinite(Number(settlementLeftMin))) return false;
  const t = Number(settlementLeftMin);
  const w = Number(entryMinutesLeft);
  const prev = slugMinutesLeftTrail.has(marketSlug) ? slugMinutesLeftTrail.get(marketSlug) : null;
  if (t <= 0 || t > w) {
    slugMinutesLeftTrail.set(marketSlug, t);
    return false;
  }
  slugMinutesLeftTrail.set(marketSlug, t);
  return prev === null || prev > w;
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
  if (!poly?.ok || !poly.market) return { line: lastPaperLine, liveOrderLine: lastLiveOrderLine };

  const marketSlug = String(poly.market.slug ?? "");
  if (!marketSlug) return { line: lastPaperLine, liveOrderLine: lastLiveOrderLine };

  // --- 1. SNIPER TAPE READING CHECK ---
  if (sniperState.active && sniperState.marketSlug === marketSlug) {
    const askPrice = sniperState.side === "UP" ? poly.prices?.up : poly.prices?.down;
    
    // Status visual
    lastLiveOrderLine = `${ANSI_YELLOW}SNIPER TAPE READING: Aguardando ${sniperState.side} @ <= ${sniperState.limitPrice.toFixed(2)} (Ask atual: ${askPrice != null ? askPrice.toFixed(3) : "-"}) ${ANSI_RESET}`;

    if (askPrice != null && Number.isFinite(Number(askPrice)) && Number(askPrice) <= sniperState.limitPrice) {
      if (shouldAttemptLiveOrder()) {
        const pool = getStrategyPool(s.databaseUrl);
        const client = await pool.connect();
        try {
          const live = await tryPlaceSniperFokOrder({
            pgClient: client,
            entryId: sniperState.entryId,
            marketSlug: sniperState.marketSlug,
            tokenId: sniperState.tokenId,
            limitPrice: sniperState.limitPrice,
            notionalUsd: sniperState.notionalUsd
          });
          lastLiveOrderLine = live?.line ? `${live.ok ? ANSI_GREEN : ANSI_RED}${live.line}${ANSI_RESET}` : null;
          sniperState.active = false; // Disparou, finish
        } catch (err) {
          lastLiveOrderLine = `${ANSI_RED}SNIPER ERRO: ${err.message}${ANSI_RESET}`;
          sniperState.active = false;
        } finally {
          client.release();
        }
      } else {
        lastLiveOrderLine = `${ANSI_GRAY}SNIPER atingiu preco @ ${askPrice.toFixed(2)} mas Live Armed = false${ANSI_RESET}`;
        sniperState.active = false;
      }
    }
  } else if (sniperState.active && sniperState.marketSlug !== marketSlug) {
    // Mercado mudou
    sniperState.active = false;
    lastLiveOrderLine = null;
    lastPaperLine = null;
  }

  // --- 2. SNAPSHOT DECISION TRIGGER ---
  if (!shouldFireStrategySnapshot(marketSlug, settlementLeftMin, s.entryMinutesLeft)) {
    return { line: lastPaperLine, liveOrderLine: lastLiveOrderLine };
  }

  const upBook = poly.orderbook?.up ?? {};
  const downBook = poly.orderbook?.down ?? {};
  const upBuy = poly.prices?.up ?? null;
  const downBuy = poly.prices?.down ?? null;
  const upMid = midFromBook(upBook, upBuy);
  const downMid = midFromBook(downBook, downBuy);

  const decision = decideLateWindowSide({
    minutesLeft: settlementLeftMin,
    entryMinutesLeft: s.entryMinutesLeft,
    upMid,
    downMid,
    epsilon: s.priceEpsilon,
    ptbDelta,
    rsiNow,
    macd,
    haNarrative
  });

  if (!decision.inWindow) return { line: lastPaperLine, liveOrderLine: lastLiveOrderLine };

  const pool = getStrategyPool(s.databaseUrl);
  await ensureStrategySchemaOnce(pool);
  const client = await pool.connect();
  try {
    let effectiveDecision = decision;
    if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
      const asym = evaluateAsymmetryGuard({
        entryPrice: s.targetEntryPrice,
        maxEntryPrice: s.maxEntryPrice,
        minPayoutMultiple: s.minPayoutMultiple
      });
      if (!asym.allowed) {
        effectiveDecision = { ...effectiveDecision, side: null, result: asym.resultCode };
        lastLiveOrderLine = `${ANSI_GRAY}${asym.line}${ANSI_RESET}`;
      }
    }

    if (
      s.riskGuardsEnabled &&
      (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN")
    ) {
      const risk = await evaluateRiskStatsGuard({
        pgClient: client,
        maxConsecutiveLosses: s.maxConsecutiveLosses,
        rollingLossHours: s.rollingLossHours,
        maxRollingLossUsd: s.maxRollingLossUsd
      });
      if (!risk.allowed) {
        effectiveDecision = { ...effectiveDecision, side: null, result: risk.resultCode };
        lastLiveOrderLine = `${ANSI_GRAY}${risk.line}${ANSI_RESET}`;
      }
    }

    let entryPrice = null;
    let simulatedShares = null;
    if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
      entryPrice = s.targetEntryPrice;
      simulatedShares = s.notionalUsd / entryPrice;
    }

    const endDate = poly.market.endDate ? new Date(poly.market.endDate) : null;
    const marketEndAt = endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : null;

    const insertResult = await insertPaperSignal(client, {
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
      result_code: effectiveDecision.result,
      chosen_side: effectiveDecision.side,
      notional_usd: s.notionalUsd,
      entry_price: entryPrice,
      simulated_shares: simulatedShares,
      dry_run: s.dryRun
    });

    if (!insertResult.inserted) return { line: lastPaperLine, inserted: false, liveOrderLine: lastLiveOrderLine };

    if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
      if (entryPrice != null && simulatedShares != null) {
        const tokenId = effectiveDecision.side === "UP" ? poly.tokens?.upTokenId : poly.tokens?.downTokenId;
        if (tokenId) {
          sniperState = {
            active: true,
            marketSlug,
            side: effectiveDecision.side,
            tokenId: String(tokenId),
            limitPrice: entryPrice,
            notionalUsd: s.notionalUsd,
            entryId: insertResult.id
          };
          lastLiveOrderLine = `${ANSI_YELLOW}SNIPER TAPE READING ARMED: ${effectiveDecision.side} alvo <= ${entryPrice.toFixed(2)}${ANSI_RESET}`;
        } else {
          lastLiveOrderLine = `${ANSI_RED}CLOB: tokenId ausente, impossivel armar Sniper${ANSI_RESET}`;
        }
      }
    } else {
      lastLiveOrderLine = null;
    }

    const tag = s.dryRun ? "DRY" : "LIVE";
    if (effectiveDecision.side === "UP" || effectiveDecision.side === "DOWN") {
      const px = entryPrice != null ? entryPrice.toFixed(3) : "?";
      lastPaperLine = `${ANSI_GREEN}Paper ${tag}: ${effectiveDecision.side} target~${px} ($${s.notionalUsd})${ANSI_RESET}`;
    } else {
      lastPaperLine = `${ANSI_GRAY}Paper ${tag}: ${effectiveDecision.result} (UP ${upMid?.toFixed?.(3) ?? "-"} vs DOWN ${downMid?.toFixed?.(3) ?? "-"})${ANSI_RESET}`;
    }

    return { inserted: true, line: lastPaperLine, liveOrderLine: lastLiveOrderLine };
  } catch (e) {
    return { line: `${ANSI_RED}Strategy DB: ${e?.message ?? e}${ANSI_RESET}`, error: String(e?.message ?? e) };
  } finally {
    client.release();
  }
}
