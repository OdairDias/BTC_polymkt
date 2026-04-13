import { clamp } from "../utils.js";

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Approximates the probability of UP settling above the strike.
 * Inputs are intentionally simple so we can calibrate later with real data.
 */
export function estimateOracleProbability({ ptbDelta, volAtr, minutesLeft }) {
  const delta = toFiniteNumber(ptbDelta);
  const atr = toFiniteNumber(volAtr);
  const mins = toFiniteNumber(minutesLeft);

  if (delta == null || atr == null || atr <= 0 || mins == null || mins <= 0) {
    return 0.5;
  }

  // Scale expected move by remaining time (5m base because ATR comes from 5m candles).
  const timeFactor = Math.sqrt(Math.max(0.1, mins / 5));
  const expectedMove = atr * timeFactor;
  if (!Number.isFinite(expectedMove) || expectedMove <= 0) {
    return delta > 0 ? 0.99 : 0.01;
  }

  // Logistic approximation of a normal CDF-like boundary probability.
  const zScore = delta / expectedMove;
  const probUp = 1 / (1 + Math.exp(-1.6 * zScore));
  return clamp(probUp, 0.01, 0.99);
}

/**
 * Blends directional TA probability with oracle/settlement probability.
 */
export function computeFairValue({ probTa, probOracle, weightTa = 0.45 }) {
  const ta = toFiniteNumber(probTa) ?? 0.5;
  const oracle = toFiniteNumber(probOracle) ?? 0.5;
  const w = clamp(Number(weightTa), 0, 1);
  return clamp((ta * w) + (oracle * (1 - w)), 0.01, 0.99);
}
