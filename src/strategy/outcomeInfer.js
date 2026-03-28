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

/**
 * PnL simulado: compra a entryPrice com notional US$; se vence, shares * 1 - custo; se perde, -notional.
 */
export function computeSimulatedPnl({ chosenSide, winnerSide, entryPrice, notionalUsd }) {
  if (!chosenSide || !winnerSide || (chosenSide !== "UP" && chosenSide !== "DOWN")) {
    return { pnl: null, entryCorrect: null };
  }
  if (!entryPrice || !Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) {
    return { pnl: null, entryCorrect: null };
  }
  const notional = Number(notionalUsd) || 0;
  const p = Number(entryPrice);
  const shares = notional / p;
  const win = chosenSide === winnerSide;
  if (win) {
    const payout = shares * 1;
    return { pnl: payout - notional, entryCorrect: true };
  }
  return { pnl: -notional, entryCorrect: false };
}
