import { CONFIG } from "../config.js";
import { midFromBook } from "../strategy/pricing.js";
import { decideLateWindowSide } from "../strategy/lateWindow.js";
import { getStrategyPool, ensureStrategySchemaOnce, insertPaperSignal, resetStrategySchemaFlag } from "../db/postgresStrategy.js";
import { resetOutcomeTrailForTests } from "./paperOutcome.js";
import { resetLiveClobClient } from "./liveClob.js";
import { tryPlaceLiveEntryOrder, shouldAttemptLiveOrder } from "./liveEntryOrder.js";

const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

let warnedNoDb = false;

/** slug -> último minutes_left visto (para disparar só ao entrar na janela) */
const slugMinutesLeftTrail = new Map();

export function resetStrategyDbStateForTests() {
  resetStrategySchemaFlag();
  resetOutcomeTrailForTests();
  resetLiveClobClient();
  warnedNoDb = false;
  slugMinutesLeftTrail.clear();
}

/**
 * Dispara uma única vez por mercado, no momento em que o tempo cruza para ≤ entryMinutesLeft (ex.: 2 min).
 */
function shouldFireStrategySnapshot(marketSlug, settlementLeftMin, entryMinutesLeft) {
  if (!marketSlug || settlementLeftMin == null || !Number.isFinite(Number(settlementLeftMin))) {
    return false;
  }
  const t = Number(settlementLeftMin);
  const w = Number(entryMinutesLeft);
  const prev = slugMinutesLeftTrail.has(marketSlug) ? slugMinutesLeftTrail.get(marketSlug) : null;

  if (t <= 0) {
    slugMinutesLeftTrail.set(marketSlug, t);
    return false;
  }
  if (t > w) {
    slugMinutesLeftTrail.set(marketSlug, t);
    return false;
  }

  slugMinutesLeftTrail.set(marketSlug, t);
  const justEntered = prev === null || prev > w;
  return justEntered;
}

/**
 * Avalia janela de 2 min (configurável) e grava no Postgres (dry run).
 * @returns {{ line: string | null, inserted?: boolean, error?: string }}
 */
export async function runPaperStrategyTick({ 
  poly, 
  settlementLeftMin,
  ptbDelta,
  rsiNow,
  macd,
  haNarrative
}) {
  const s = CONFIG.strategy;
  if (!s.enabled) {
    return { line: null };
  }
  if (!s.databaseUrl) {
    if (!warnedNoDb) {
      warnedNoDb = true;
      return { line: `${ANSI_YELLOW}Strategy: STRATEGY_ENABLED sem DATABASE_URL${ANSI_RESET}` };
    }
    return { line: null };
  }
  if (!poly?.ok || !poly.market) {
    return { line: null };
  }

  const marketSlug = String(poly.market.slug ?? "");
  if (!marketSlug) {
    return { line: null };
  }

  if (!shouldFireStrategySnapshot(marketSlug, settlementLeftMin, s.entryMinutesLeft)) {
    return { line: null };
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

  if (!decision.inWindow) {
    return { line: null };
  }

  const pool = getStrategyPool(s.databaseUrl);
  await ensureStrategySchemaOnce(pool);
  const client = await pool.connect();
  try {
    let entryPrice = null;
    let simulatedShares = null;
    if (decision.side === "UP" && upBuy != null && Number.isFinite(Number(upBuy)) && Number(upBuy) > 0) {
      entryPrice = Number(upBuy);
      simulatedShares = s.notionalUsd / entryPrice;
    } else if (decision.side === "DOWN" && downBuy != null && Number.isFinite(Number(downBuy)) && Number(downBuy) > 0) {
      entryPrice = Number(downBuy);
      simulatedShares = s.notionalUsd / entryPrice;
    }

    const endDate = poly.market.endDate ? new Date(poly.market.endDate) : null;
    const marketEndAt = endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : null;

    const insertResult = await insertPaperSignal(client, {
      market_slug: marketSlug,
      condition_id:
        poly.market.conditionId != null
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
      result_code: decision.result,
      chosen_side: decision.side,
      notional_usd: s.notionalUsd,
      entry_price: entryPrice,
      simulated_shares: simulatedShares,
      dry_run: s.dryRun
    });

    if (!insertResult.inserted) {
      return { line: null, inserted: false };
    }

    let liveOrderLine = null;
    if (
      shouldAttemptLiveOrder() &&
      (decision.side === "UP" || decision.side === "DOWN") &&
      entryPrice != null &&
      simulatedShares != null
    ) {
      const tokenId =
        decision.side === "UP" ? poly.tokens?.upTokenId : poly.tokens?.downTokenId;
      if (tokenId) {
        const live = await tryPlaceLiveEntryOrder({
          pgClient: client,
          entryId: insertResult.id,
          marketSlug,
          tokenId: String(tokenId),
          limitPrice: entryPrice,
          sizeShares: Number(Number(simulatedShares).toFixed(6)),
          notionalUsd: s.notionalUsd
        });
        liveOrderLine = live?.line
          ? `${live.ok ? ANSI_GREEN : ANSI_RED}${live.line}${ANSI_RESET}`
          : null;
      } else {
        liveOrderLine = `${ANSI_RED}CLOB: tokenId ausente${ANSI_RESET}`;
      }
    }

    const tag = s.dryRun ? "DRY" : "LIVE";
    if (decision.side === "UP" || decision.side === "DOWN") {
      const px = entryPrice != null ? entryPrice.toFixed(3) : "?";
      return {
        inserted: true,
        line: `${ANSI_GREEN}Paper ${tag}: ${decision.side} @~${px} ($${s.notionalUsd})${ANSI_RESET}`,
        liveOrderLine
      };
    }
    return {
      inserted: true,
      line: `${ANSI_GRAY}Paper ${tag}: ${decision.result} (UP ${upMid?.toFixed?.(3) ?? "-"} vs DOWN ${downMid?.toFixed?.(3) ?? "-"})${ANSI_RESET}`,
      liveOrderLine
    };
  } catch (e) {
    return { line: `${ANSI_RED}Strategy DB: ${e?.message ?? e}${ANSI_RESET}`, error: String(e?.message ?? e) };
  } finally {
    client.release();
  }
}
