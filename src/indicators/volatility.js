function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Simple ATR from candle array [{ high, low, close }].
 */
export function computeAtr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const p = candles[i - 1];
    const high = toFiniteNumber(c?.high);
    const low = toFiniteNumber(c?.low);
    const prevClose = toFiniteNumber(p?.close);
    if (high == null || low == null || prevClose == null) continue;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    if (Number.isFinite(tr)) trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;
  const recent = trueRanges.slice(-period);
  const sum = recent.reduce((acc, v) => acc + v, 0);
  return sum / period;
}
