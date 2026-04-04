import { fetchOutcomeRiskStats } from "../db/postgresStrategy.js";

function asNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function payoutMultipleFromPrice(price) {
  const p = asNumber(price);
  if (p === null || p <= 0 || p >= 1) return null;
  return (1 - p) / p;
}

export function evaluateAsymmetryGuard({
  entryPrice,
  maxEntryPrice,
  minPayoutMultiple
}) {
  const p = asNumber(entryPrice);
  const maxP = asNumber(maxEntryPrice);
  const minPay = asNumber(minPayoutMultiple);

  if (p === null) {
    return { allowed: false, resultCode: "SKIP_INVALID_ENTRY_PRICE", line: "Risk: preÃ§o de entrada invÃ¡lido" };
  }

  if (maxP !== null && p > maxP) {
    return {
      allowed: false,
      resultCode: "SKIP_ASYM_BAD_PRICE",
      line: `Risk: entry ${p.toFixed(3)} > max ${maxP.toFixed(3)}`
    };
  }

  const payoutMultiple = payoutMultipleFromPrice(p);
  if (payoutMultiple === null) {
    return { allowed: false, resultCode: "SKIP_INVALID_ENTRY_PRICE", line: "Risk: payout mÃºltiplo invÃ¡lido" };
  }

  if (minPay !== null && payoutMultiple < minPay) {
    return {
      allowed: false,
      resultCode: "SKIP_ASYM_BAD_RR",
      line: `Risk: payoff ${payoutMultiple.toFixed(2)}x < min ${minPay.toFixed(2)}x`
    };
  }

  return {
    allowed: true,
    resultCode: "OK",
    line: `Asym ok: entry ${p.toFixed(3)} | payoff ${payoutMultiple.toFixed(2)}x`,
    payoutMultiple
  };
}

export async function evaluateRiskStatsGuard({
  pgClient,
  maxConsecutiveLosses,
  rollingLossHours,
  maxRollingLossUsd
}) {
  const streakLimit = Math.max(1, Math.floor(Number(maxConsecutiveLosses) || 1));
  const maxLoss = Math.max(0.01, Number(maxRollingLossUsd) || 0.01);
  const hours = Math.max(1, Math.floor(Number(rollingLossHours) || 24));

  const stats = await fetchOutcomeRiskStats(pgClient, { rollingHours: hours, streakSampleSize: 200 });
  const rollingPnl = Number(stats.rollingPnlUsd) || 0;
  const streak = Number(stats.consecutiveLosses) || 0;

  if (rollingPnl <= -maxLoss) {
    return {
      allowed: false,
      resultCode: "SKIP_RISK_ROLLING_LOSS",
      line: `Risk: rollingPnL ${rollingPnl.toFixed(2)} <= -${maxLoss.toFixed(2)} (${hours}h)`,
      stats
    };
  }

  if (streak >= streakLimit) {
    return {
      allowed: false,
      resultCode: "SKIP_RISK_LOSS_STREAK",
      line: `Risk: loss streak ${streak} >= ${streakLimit}`,
      stats
    };
  }

  return {
    allowed: true,
    resultCode: "OK",
    line: `Risk ok: rollingPnL ${rollingPnl.toFixed(2)} | streak ${streak}`,
    stats
  };
}

