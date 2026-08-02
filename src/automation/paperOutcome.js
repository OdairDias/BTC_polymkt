import { CONFIG } from "../config.js";
import { computeSimulatedPnl } from "../strategy/outcomeInfer.js";
import { fetchMarketBySlug, extractResolvedOutcomeFromMarket } from "../data/polymarket.js";
import {
  getStrategyPool,
  ensureStrategySchemaOnce,
  findPendingPaperEntries,
  insertPaperOutcome
} from "../db/postgresStrategy.js";

const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";
const STALE_MISSING_MARKET_GRACE_MS = 2 * 60 * 60 * 1000;

function toTimestampMs(value) {
  if (!value) return null;
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : null;
}

export function shouldFinalizeMissingMarketEntry(entry, { nowMs = Date.now(), graceMs = STALE_MISSING_MARKET_GRACE_MS } = {}) {
  const marketEndMs = toTimestampMs(entry?.market_end_at);
  if (marketEndMs == null) return false;
  return nowMs >= marketEndMs + Math.max(0, Number(graceMs) || 0);
}

export function resetOutcomeTrailForTests() {
  // Mantido por compatibilidade com testes antigos.
}

export function formatOfficialOutcomeLine({ strategyKey, winLabel, entryCorrect, pnl, extraPrice = "" }) {
  if (entryCorrect === true && pnl != null) {
    return `${ANSI_GREEN}[${strategyKey}] Outcome oficial: ${winLabel} won · entrada OK · PnL ~$${Number(pnl).toFixed(2)}${extraPrice}${ANSI_RESET}`;
  }
  if (entryCorrect === false && pnl != null) {
    return `${ANSI_RED}[${strategyKey}] Outcome oficial: ${winLabel} won · entrada errou · PnL ~$${Number(pnl).toFixed(2)}${extraPrice}${ANSI_RESET}`;
  }
  return `${ANSI_GRAY}[${strategyKey}] Outcome oficial: ${winLabel}${extraPrice}${ANSI_RESET}`;
}

/**
 * Grava resultado oficial da Gamma API para entradas pendentes jÃ¡ encerradas.
 * NÃ£o infere mais vencedor por mids nos Ãºltimos segundos.
 */
export async function runPaperOutcomeTick() {
  const s = CONFIG.strategy;
  if (!s.enabled || !s.databaseUrl || !s.dryRun) return { line: null };

  const pool = getStrategyPool(s.databaseUrl);
  await ensureStrategySchemaOnce(pool);

  const client = await pool.connect();
  try {
    const pending = await findPendingPaperEntries(client, 30);
    if (!pending.length) return { line: null };

    let insertedCount = 0;
    let lastLine = null;

    for (const entry of pending) {
      const strategyKey = String(entry.strategy_key ?? "default");
      const marketSlug = String(entry.market_slug ?? "");
      if (!marketSlug) continue;

      const variant =
        s.variants.find((candidate) => candidate.key === strategyKey) ??
        (strategyKey.endsWith("_poststop_observer")
          ? s.variants.find((candidate) => candidate.key === strategyKey.replace(/_poststop_observer$/, ""))
          : null);
      const takerFeeRate = Math.max(0, Number(variant?.paperTakerFeeRate ?? s.paperTakerFeeRate) || 0);
      const chosen = entry.chosen_side;
      const remainingNotionalUsd = Number(entry.remaining_notional_usd ?? entry.notional_usd ?? 0);
      const remainingShares = Number(entry.remaining_shares ?? entry.simulated_shares ?? 0);
      const nextExitSequence = Math.max(1, Number(entry.last_exit_sequence ?? 0) + 1);

      let market;
      try {
        market = await fetchMarketBySlug(marketSlug);
      } catch {
        market = null;
      }

      if (!market) {
        if (!shouldFinalizeMissingMarketEntry(entry)) continue;
        const { inserted } = await insertPaperOutcome(client, {
          entry_id: entry.id,
          strategy_key: strategyKey,
          market_slug: marketSlug,
          seconds_left_at_eval: 0,
          evaluation_method: "gamma_market_missing_stale",
          up_mid: null,
          down_mid: null,
          up_best_bid: null,
          up_best_ask: null,
          down_best_bid: null,
          down_best_ask: null,
          inferred_winner: null,
          official_winner: null,
          outcome_code: "OUTCOME_STALE_UNAVAILABLE",
          official_resolution_status: "market_missing",
          official_resolution_source: "gamma:/markets?slug",
          official_resolved_at: null,
          official_outcome_prices_json: null,
          official_price_to_beat: null,
          official_price_at_close: null,
          entry_chosen_side: chosen,
          entry_correct: null,
          pnl_simulated_usd: null,
          dry_run: s.dryRun,
          exit_sequence: nextExitSequence,
          fraction_exited:
            remainingShares > 0 && Number(entry.simulated_shares ?? 0) > 0
              ? remainingShares / Number(entry.simulated_shares)
              : null,
          shares_exited: remainingShares > 0 ? remainingShares : null,
          notional_exited_usd: remainingNotionalUsd > 0 ? remainingNotionalUsd : null,
          remaining_shares: 0,
          remaining_notional_usd: 0,
          is_final_exit: true,
          exit_reason: "STALE_UNAVAILABLE"
        });
        if (!inserted) continue;
        insertedCount += 1;
        const staleWarn = `[${strategyKey}] WARN stale outcome finalized: Gamma sem slug histórico (${marketSlug})`;
        console.warn(staleWarn);
        lastLine = `${ANSI_YELLOW}${staleWarn}${ANSI_RESET}`;
        continue;
      }

      const resolved = extractResolvedOutcomeFromMarket(market);
      if (!resolved.resolved || !resolved.winner) continue;

      let entryCorrect = null;
      let accounting = null;
      if ((chosen === "UP" || chosen === "DOWN") && remainingNotionalUsd > 0) {
        accounting = computeSimulatedPnl({
          chosenSide: chosen,
          winnerSide: resolved.winner,
          entryPrice: entry.entry_price,
          notionalUsd: remainingNotionalUsd,
          shares: remainingShares,
          takerFeeRate
        });
        entryCorrect = accounting.entryCorrect;
      }

      const { inserted } = await insertPaperOutcome(client, {
        entry_id: entry.id,
        strategy_key: strategyKey,
        market_slug: marketSlug,
        seconds_left_at_eval: 0,
        evaluation_method: "gamma_resolved",
        up_mid: null,
        down_mid: null,
        up_best_bid: null,
        up_best_ask: null,
        down_best_bid: null,
        down_best_ask: null,
        inferred_winner: resolved.winner,
        official_winner: resolved.winnerLabel ?? resolved.winner,
        outcome_code: "OUTCOME_OFFICIAL",
        official_resolution_status: resolved.resolutionStatus,
        official_resolution_source: resolved.resolutionSource,
        official_resolved_at: resolved.resolvedAt,
        official_outcome_prices_json: {
          outcomes: resolved.outcomes,
          prices: resolved.outcomePrices
        },
        official_price_to_beat: resolved.priceToBeat,
        official_price_at_close: resolved.priceAtClose,
        entry_chosen_side: chosen,
        entry_correct: entryCorrect,
        pnl_simulated_usd: accounting?.pnl ?? null,
        gross_pnl_simulated_usd: accounting?.grossPnl ?? null,
        entry_fee_usd: accounting?.entryFeeUsd ?? null,
        exit_fee_usd: 0,
        total_fee_usd: accounting?.totalFeeUsd ?? null,
        dry_run: s.dryRun,
        exit_sequence: nextExitSequence,
        fraction_exited:
          remainingShares > 0 && Number(entry.simulated_shares ?? 0) > 0
            ? remainingShares / Number(entry.simulated_shares)
            : null,
        shares_exited: remainingShares > 0 ? remainingShares : null,
        notional_exited_usd: remainingNotionalUsd > 0 ? remainingNotionalUsd : null,
        remaining_shares: 0,
        remaining_notional_usd: 0,
        is_final_exit: true
      });

      if (!inserted) continue;

      insertedCount += 1;
      const pnl = accounting?.pnl ?? null;
      const winLabel = resolved.winnerLabel ?? resolved.winner ?? "?";
      const extraPrice =
        resolved.priceToBeat != null && resolved.priceAtClose != null
          ? ` | beat ${Number(resolved.priceToBeat).toFixed(2)} vs close ${Number(resolved.priceAtClose).toFixed(2)}`
          : "";

      lastLine = formatOfficialOutcomeLine({ strategyKey, winLabel, entryCorrect, pnl, extraPrice });
    }

    if (insertedCount === 0) return { line: null };
    return { inserted: true, line: lastLine ?? `${ANSI_GRAY}Outcome oficial atualizado${ANSI_RESET}` };
  } catch (e) {
    return { line: `${ANSI_RED}Outcome DB: ${e?.message ?? e}${ANSI_RESET}`, error: String(e?.message ?? e) };
  } finally {
    client.release();
  }
}
