function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeSizingMode(value, fallback = "fixed") {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "kelly" || mode === "fixed" ? mode : fallback;
}

/**
 * Fractional Kelly for binary contracts.
 * estimatedProb: model belief of win probability [0, 1]
 * marketProb: implied market probability / entry price [0, 1]
 */
export function computeKellyFraction({ estimatedProb, marketProb }) {
  const p = toFinite(estimatedProb);
  const m = toFinite(marketProb);
  if (p == null || m == null || p <= 0 || p >= 1 || m <= 0 || m >= 1) return null;
  const b = (1 - m) / m;
  if (!Number.isFinite(b) || b <= 0) return null;
  const q = 1 - p;
  return (b * p - q) / b;
}

function resolveProbBySide(side, upProb, downProb) {
  if (side === "UP") return toFinite(upProb);
  if (side === "DOWN") return toFinite(downProb);
  return null;
}

export function chooseStrategyNotional({
  variantNotionalUsd,
  sizingMode,
  side,
  selectedModelProb,
  selectedMarketProb,
  modelUp,
  modelDown,
  marketUp,
  marketDown,
  entryPrice,
  kellyFraction,
  kellyMinNotionalUsd,
  kellyMaxNotionalUsd
}) {
  const baseNotional = Math.max(0.01, toFinite(variantNotionalUsd) ?? 1);
  const mode = normalizeSizingMode(sizingMode, "fixed");
  if (mode !== "kelly") {
    return {
      sizingMode: "fixed",
      notionalUsd: baseNotional,
      kellyFull: null,
      kellyApplied: null,
      estimatedProb: null,
      marketProb: null
    };
  }

  const estimatedProb =
    toFinite(selectedModelProb) ??
    resolveProbBySide(side, modelUp, modelDown);
  const marketProb =
    toFinite(selectedMarketProb) ??
    resolveProbBySide(side, marketUp, marketDown) ??
    toFinite(entryPrice);

  const kellyFull = computeKellyFraction({ estimatedProb, marketProb });
  const fraction = clamp(toFinite(kellyFraction) ?? 0.25, 0, 1);
  const kellyApplied = kellyFull == null ? 0 : clamp(kellyFull * fraction, 0, 1);

  const minNotionalDefault = Math.min(baseNotional, 0.25);
  const minNotional = clamp(
    toFinite(kellyMinNotionalUsd) ?? minNotionalDefault,
    0.01,
    baseNotional
  );
  const maxNotional = clamp(
    toFinite(kellyMaxNotionalUsd) ?? baseNotional,
    minNotional,
    baseNotional
  );
  const notionalUsd = minNotional + (maxNotional - minNotional) * kellyApplied;

  return {
    sizingMode: "kelly",
    notionalUsd,
    kellyFull,
    kellyApplied,
    estimatedProb,
    marketProb
  };
}
