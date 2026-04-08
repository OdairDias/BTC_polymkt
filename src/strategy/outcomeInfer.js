/**
 * Infere vencedor do mercado binário a partir dos mids (últimos segundos: um lado ~1, outro ~0).
 */
export function inferMarketWinnerFromMids(upMid, downMid, epsilon) {
  const eps = Number(epsilon) || 0;
  if (upMid == null || downMid == null || !Number.isFinite(Number(upMid)) || !Number.isFinite(Number(downMid))) {
    return { winner: null, outcomeCode: "NO_DATA" };
  }
  const u = Number(upMid);
  const d = Number(downMid);
  const diff = u - d;
  if (Math.abs(diff) <= eps) {
    return { winner: null, outcomeCode: "TIE" };
  }
  if (diff > 0) {
    return { winner: "UP", outcomeCode: "WINNER_UP" };
  }
  return { winner: "DOWN", outcomeCode: "WINNER_DOWN" };
}

export function normalizeBinarySide(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return null;
  if (raw === "UP" || raw === "YES") return "UP";
  if (raw === "DOWN" || raw === "NO") return "DOWN";
  return null;
}

/**
 * PnL simulado: compra a entryPrice com notional US$; se vence, shares * 1 - custo; se perde, -notional.
 */
export function computeSimulatedPnl({ chosenSide, winnerSide, entryPrice, notionalUsd }) {
  const normalizedChosenSide = normalizeBinarySide(chosenSide);
  const normalizedWinnerSide = normalizeBinarySide(winnerSide);

  if (!normalizedChosenSide || !normalizedWinnerSide) {
    return { pnl: null, entryCorrect: null };
  }
  if (!entryPrice || !Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) {
    return { pnl: null, entryCorrect: null };
  }
  const notional = Number(notionalUsd) || 0;
  const p = Number(entryPrice);
  const shares = notional / p;
  const win = normalizedChosenSide === normalizedWinnerSide;
  if (win) {
    const payout = shares * 1;
    return { pnl: payout - notional, entryCorrect: true };
  }
  return { pnl: -notional, entryCorrect: false };
}

/**
 * PnL realizado em saída antecipada:
 * compra shares = notional / entryPrice e vende shares * exitPrice.
 */
export function computeRealizedExitPnl({ entryPrice, exitPrice, notionalUsd }) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const notional = Number(notionalUsd) || 0;

  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit) || exit <= 0) {
    return { pnl: null, shares: null };
  }

  const shares = notional / entry;
  const proceeds = shares * exit;
  return {
    pnl: proceeds - notional,
    shares
  };
}
