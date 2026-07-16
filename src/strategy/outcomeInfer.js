import { computeTakerFeeUsd } from "./executionModel.js";

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
export function computeSimulatedPnl({ chosenSide, winnerSide, entryPrice, notionalUsd, shares = null, takerFeeRate = 0 }) {
  const normalizedChosenSide = normalizeBinarySide(chosenSide);
  const normalizedWinnerSide = normalizeBinarySide(winnerSide);

  if (!normalizedChosenSide || !normalizedWinnerSide) {
    return { pnl: null, grossPnl: null, entryCorrect: null, shares: null, entryFeeUsd: null, totalFeeUsd: null };
  }
  if (!entryPrice || !Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) {
    return { pnl: null, grossPnl: null, entryCorrect: null, shares: null, entryFeeUsd: null, totalFeeUsd: null };
  }
  const notional = Number(notionalUsd) || 0;
  const p = Number(entryPrice);
  const explicitShares = Number(shares);
  const effectiveShares = Number.isFinite(explicitShares) && explicitShares > 0 ? explicitShares : notional / p;
  const entryNotional = effectiveShares * p;
  const entryFeeUsd = computeTakerFeeUsd({ shares: effectiveShares, price: p, feeRate: takerFeeRate });
  const win = normalizedChosenSide === normalizedWinnerSide;
  const grossPnl = win ? effectiveShares - entryNotional : -entryNotional;
  return {
    pnl: grossPnl - entryFeeUsd,
    grossPnl,
    entryCorrect: win,
    shares: effectiveShares,
    entryFeeUsd,
    totalFeeUsd: entryFeeUsd
  };
}

/**
 * PnL realizado em saída antecipada:
 * compra shares = notional / entryPrice e vende shares * exitPrice.
 */
export function computeRealizedExitPnl({ entryPrice, exitPrice, notionalUsd, shares = null, takerFeeRate = 0 }) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const notional = Number(notionalUsd) || 0;

  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit) || exit <= 0) {
    return { pnl: null, grossPnl: null, shares: null, entryFeeUsd: null, exitFeeUsd: null, totalFeeUsd: null };
  }

  const explicitShares = Number(shares);
  const effectiveShares = Number.isFinite(explicitShares) && explicitShares > 0 ? explicitShares : notional / entry;
  const entryNotional = effectiveShares * entry;
  const proceeds = effectiveShares * exit;
  const grossPnl = proceeds - entryNotional;
  const entryFeeUsd = computeTakerFeeUsd({ shares: effectiveShares, price: entry, feeRate: takerFeeRate });
  const exitFeeUsd = computeTakerFeeUsd({ shares: effectiveShares, price: exit, feeRate: takerFeeRate });
  const totalFeeUsd = entryFeeUsd + exitFeeUsd;
  return {
    pnl: grossPnl - totalFeeUsd,
    grossPnl,
    shares: effectiveShares,
    entryFeeUsd,
    exitFeeUsd,
    totalFeeUsd
  };
}
