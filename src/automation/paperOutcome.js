import { CONFIG } from "../config.js";
import { midFromBook } from "../strategy/pricing.js";
import { inferMarketWinnerFromMids, computeSimulatedPnl } from "../strategy/outcomeInfer.js";
import {
  getStrategyPool,
  ensureStrategySchemaOnce,
  findPaperEntryBySlug,
  insertPaperOutcome
} from "../db/postgresStrategy.js";

const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

/** slug -> último seconds_left visto (dispara ao entrar na janela final) */
const outcomeSecondsTrail = new Map();

export function resetOutcomeTrailForTests() {
  outcomeSecondsTrail.clear();
}

/**
 * Primeira vez que o tempo cruza para ≤ lastSeconds (ex.: 5s) e > 0.
 */
function shouldFireOutcomeSnapshot(marketSlug, settlementLeftMin, lastSeconds) {
  if (!marketSlug || settlementLeftMin == null || !Number.isFinite(Number(settlementLeftMin))) {
    return false;
  }
  const sec = Number(settlementLeftMin) * 60;
  const w = Number(lastSeconds);
  const prev = outcomeSecondsTrail.has(marketSlug) ? outcomeSecondsTrail.get(marketSlug) : null;

  if (sec <= 0) {
    outcomeSecondsTrail.set(marketSlug, sec);
    return false;
  }
  if (sec > w) {
    outcomeSecondsTrail.set(marketSlug, sec);
    return false;
  }

  outcomeSecondsTrail.set(marketSlug, sec);
  const justEntered = prev === null || prev > w;
  return justEntered;
}

/**
 * Grava resultado inferido (mids na janela final) ligado ao trade em strategy_paper_signals.
 */
export async function runPaperOutcomeTick({ poly, settlementLeftMin }) {
  const s = CONFIG.strategy;
  if (!s.enabled || !s.databaseUrl) {
    return { line: null };
  }
  if (!poly?.ok || !poly.market) {
    return { line: null };
  }

  const marketSlug = String(poly.market.slug ?? "");
  if (!marketSlug) {
    return { line: null };
  }

  const lastSec = s.outcomeLastSeconds;
  if (!shouldFireOutcomeSnapshot(marketSlug, settlementLeftMin, lastSec)) {
    return { line: null };
  }

  const pool = getStrategyPool(s.databaseUrl);
  await ensureStrategySchemaOnce(pool);
  const client = await pool.connect();
  try {
    const entry = await findPaperEntryBySlug(client, marketSlug);
    if (!entry) {
      return { line: null };
    }

    const upBook = poly.orderbook?.up ?? {};
    const downBook = poly.orderbook?.down ?? {};
    const upBuy = poly.prices?.up ?? null;
    const downBuy = poly.prices?.down ?? null;

    const upMid = midFromBook(upBook, upBuy);
    const downMid = midFromBook(downBook, downBuy);

    const { winner, outcomeCode } = inferMarketWinnerFromMids(upMid, downMid, s.priceEpsilon);

    const finalCode =
      outcomeCode === "NO_DATA"
        ? "OUTCOME_NO_DATA"
        : outcomeCode === "TIE"
          ? "OUTCOME_TIE"
          : outcomeCode;

    let entryCorrect = null;
    let pnl = null;
    const chosen = entry.chosen_side;

    if (winner && (chosen === "UP" || chosen === "DOWN")) {
      const r = computeSimulatedPnl({
        chosenSide: chosen,
        winnerSide: winner,
        entryPrice: entry.entry_price,
        notionalUsd: entry.notional_usd
      });
      entryCorrect = r.entryCorrect;
      pnl = r.pnl;
    } else if (chosen === "UP" || chosen === "DOWN") {
      entryCorrect = null;
      pnl = null;
    }

    const secondsLeft = Number(settlementLeftMin) * 60;

    const { inserted } = await insertPaperOutcome(client, {
      entry_id: entry.id,
      market_slug: marketSlug,
      seconds_left_at_eval: secondsLeft,
      evaluation_method: "last_5s_mid",
      up_mid: upMid,
      down_mid: downMid,
      up_best_bid: upBook.bestBid ?? null,
      up_best_ask: upBook.bestAsk ?? null,
      down_best_bid: downBook.bestBid ?? null,
      down_best_ask: downBook.bestAsk ?? null,
      inferred_winner: winner,
      outcome_code: finalCode,
      entry_chosen_side: chosen,
      entry_correct: entryCorrect,
      pnl_simulated_usd: pnl,
      dry_run: s.dryRun
    });

    if (!inserted) {
      return { line: null };
    }

    const winLabel = winner ?? "?";
    if (entryCorrect === true && pnl != null) {
      return {
        inserted: true,
        line: `${ANSI_GREEN}Outcome: ${winLabel} won · entrada OK · PnL ~$${pnl.toFixed(2)}${ANSI_RESET}`
      };
    }
    if (entryCorrect === false && pnl != null) {
      return {
        inserted: true,
        line: `${ANSI_RED}Outcome: ${winLabel} won · entrada errou · PnL ~$${pnl.toFixed(2)}${ANSI_RESET}`
      };
    }
    return {
      inserted: true,
      line: `${ANSI_GRAY}Outcome: ${finalCode} (UP ${upMid?.toFixed?.(3) ?? "-"} / DOWN ${downMid?.toFixed?.(3) ?? "-"})${ANSI_RESET}`
    };
  } catch (e) {
    return { line: `${ANSI_RED}Outcome DB: ${e?.message ?? e}${ANSI_RESET}`, error: String(e?.message ?? e) };
  } finally {
    client.release();
  }
}
