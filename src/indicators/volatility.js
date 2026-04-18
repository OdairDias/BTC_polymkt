function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function aggregateCandlesByCount(candles, groupSize) {
  const size = Math.max(1, Math.floor(Number(groupSize) || 1));
  if (!Array.isArray(candles) || !candles.length || size <= 1) {
    return Array.isArray(candles) ? candles.slice() : [];
  }

  const aggregated = [];
  for (let i = 0; i + size <= candles.length; i += size) {
    const slice = candles.slice(i, i + size);
    const first = slice[0];
    const last = slice[slice.length - 1];
    const high = slice.reduce((max, candle) => {
      const value = toFiniteNumber(candle?.high);
      return value == null ? max : Math.max(max, value);
    }, Number.NEGATIVE_INFINITY);
    const low = slice.reduce((min, candle) => {
      const value = toFiniteNumber(candle?.low);
      return value == null ? min : Math.min(min, value);
    }, Number.POSITIVE_INFINITY);
    const volume = slice.reduce((sum, candle) => sum + (toFiniteNumber(candle?.volume) ?? 0), 0);

    aggregated.push({
      openTime: first?.openTime ?? null,
      open: toFiniteNumber(first?.open),
      high: Number.isFinite(high) ? high : null,
      low: Number.isFinite(low) ? low : null,
      close: toFiniteNumber(last?.close),
      volume
    });
  }

  return aggregated;
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

export function computeAtrForWindow({
  candles,
  candleMinutes,
  targetWindowMinutes,
  period = 14
}) {
  const sourceMinutes = Math.max(1, Number(candleMinutes) || 1);
  const targetMinutes = Math.max(sourceMinutes, Number(targetWindowMinutes) || sourceMinutes);

  if (!Array.isArray(candles) || !candles.length) {
    return { atr: null, baseMinutes: sourceMinutes };
  }

  if (targetMinutes <= sourceMinutes) {
    return {
      atr: computeAtr(candles, period),
      baseMinutes: sourceMinutes
    };
  }

  if (targetMinutes % sourceMinutes !== 0) {
    return {
      atr: computeAtr(candles, period),
      baseMinutes: sourceMinutes
    };
  }

  const groupSize = Math.max(1, Math.round(targetMinutes / sourceMinutes));
  const aggregated = aggregateCandlesByCount(candles, groupSize);
  const atr = computeAtr(aggregated, period);
  return {
    atr,
    baseMinutes: atr != null ? targetMinutes : sourceMinutes
  };
}
