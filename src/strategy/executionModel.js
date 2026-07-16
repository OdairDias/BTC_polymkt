function clampPrice01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0.001;
  if (n >= 1) return 0.999;
  return n;
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function resolvePaperBuyReferencePrice({ quotePrice, bestAsk }) {
  const quote = toFinite(quotePrice);
  const ask = toFinite(bestAsk);
  if (ask == null || ask <= 0) return null;
  if (quote == null || quote <= 0) return clampPrice01(ask);
  return clampPrice01(Math.max(quote, ask));
}

export function computeTakerFeeUsd({ shares, price, feeRate = 0 }) {
  const quantity = toFinite(shares);
  const p = toFinite(price);
  const rate = toFinite(feeRate);
  if (quantity == null || quantity <= 0 || p == null || p <= 0 || p >= 1 || rate == null || rate <= 0) {
    return 0;
  }
  return Math.round(quantity * rate * p * (1 - p) * 100_000) / 100_000;
}

export function normalizePaperFillMode(value, fallback = "pessimistic") {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "optimistic" || mode === "pessimistic") return mode;
  return fallback;
}

/**
 * Ajusta preco simulado para um modelo de execucao conservador.
 * - BUY: piora o preco (mais caro)
 * - SELL: piora o preco (mais barato)
 */
export function applyPaperExecutionPrice({
  action,
  referencePrice,
  spread = null,
  fillMode = "pessimistic",
  slippageBps = 0,
  spreadPenaltyFactor = 0
}) {
  const ref = toFinite(referencePrice);
  if (ref == null || ref <= 0) return null;

  const mode = normalizePaperFillMode(fillMode, "pessimistic");
  if (mode === "optimistic") return clampPrice01(ref);

  const spreadN = toFinite(spread);
  const spreadPenalty =
    spreadN != null && spreadN > 0
      ? spreadN * Math.max(0, Number(spreadPenaltyFactor) || 0)
      : 0;
  const bps = Math.max(0, Number(slippageBps) || 0);
  const slipPenalty = ref * (bps / 10_000);
  const totalPenalty = spreadPenalty + slipPenalty;

  const side = String(action ?? "").trim().toLowerCase();
  if (side === "buy") {
    return clampPrice01(ref + totalPenalty);
  }
  if (side === "sell") {
    return clampPrice01(ref - totalPenalty);
  }
  return clampPrice01(ref);
}

