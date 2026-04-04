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
const ANSI_RED = "\x1b[31m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

export function resetOutcomeTrailForTests() {
  // Mantido por compatibilidade com testes antigos.
}

/**
 * Grava resultado oficial da Gamma API para entradas pendentes jÃ¡ encerradas.
 * NÃ£o infere mais vencedor por mids nos Ãºltimos segundos.
 */
export async function runPaperOutcomeTick() {
  const s = CONFIG.strategy;
  if (!s.enabled || !s.databaseUrl) return { line: null };

  const pool = getStrategyPool(s.databaseUrl);
  await ensureStrategySchemaOnce(pool);

  const client = await pool.connect();
  try {
    const pending = await findPendingPaperEntries(client, 30);
    if (!pending.length) return { line: null };

    let insertedCount = 0;
    let lastLine = null;

    for (const entry of pending) {
      const marketSlug = String(entry.market_slug ?? "");
      if (!marketSlug) continue;

      let market;
      try {
        market = await fetchMarketBySlug(marketSlug);
      } catch {
        continue;
      }
      if (!market) continue;

      const resolved = extractResolvedOutcomeFromMarket(market);
      if (!resolved.resolved || !resolved.winner) continue;

      const chosen = entry.chosen_side;
      let entryCorrect = null;
      let pnl = null;
      if (chosen === "UP" || chosen === "DOWN") {
        const r = computeSimulatedPnl({
          chosenSide: chosen,
          winnerSide: resolved.winner,
          entryPrice: entry.entry_price,
          notionalUsd: entry.notional_usd
        });
        entryCorrect = r.entryCorrect;
        pnl = r.pnl;
      }

      const { inserted } = await insertPaperOutcome(client, {
        entry_id: entry.id,
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
        official_winner: resolved.winner,
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
        pnl_simulated_usd: pnl,
        dry_run: s.dryRun
      });

      if (!inserted) continue;

      insertedCount += 1;
      const winLabel = resolved.winner ?? "?";
      const extraPrice =
        resolved.priceToBeat != null && resolved.priceAtClose != null
          ? ` | beat ${Number(resolved.priceToBeat).toFixed(2)} vs close ${Number(resolved.priceAtClose).toFixed(2)}`
          : "";

      if (entryCorrect === true && pnl != null) {
        lastLine = `${ANSI_GREEN}Outcome oficial: ${winLabel} won Â· entrada OK Â· PnL ~$${pnl.toFixed(2)}${extraPrice}${ANSI_RESET}`;
      } else if (entryCorrect === false && pnl != null) {
        lastLine = `${ANSI_RED}Outcome oficial: ${winLabel} won Â· entrada errou Â· PnL ~$${pnl.toFixed(2)}${extraPrice}${ANSI_RESET}`;
      } else {
        lastLine = `${ANSI_GRAY}Outcome oficial: ${winLabel}${extraPrice}${ANSI_RESET}`;
      }
    }

    if (insertedCount === 0) return { line: null };
    return { inserted: true, line: lastLine ?? `${ANSI_GRAY}Outcome oficial atualizado${ANSI_RESET}` };
  } catch (e) {
    return { line: `${ANSI_RED}Outcome DB: ${e?.message ?? e}${ANSI_RESET}`, error: String(e?.message ?? e) };
  } finally {
    client.release();
  }
}

