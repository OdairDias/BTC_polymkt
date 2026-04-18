function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeBinaryMidProbability(upMid, downMid) {
  const up = toFiniteNumber(upMid);
  const down = toFiniteNumber(downMid);
  if (up == null || down == null) return null;
  const sum = up + down;
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return up / sum;
}

export function computeCrossMarketConsistency({
  primaryUpMid,
  primaryDownMid,
  confirmUpMid,
  confirmDownMid,
  chosenSide = null
}) {
  const primaryImpliedUp = normalizeBinaryMidProbability(primaryUpMid, primaryDownMid);
  const confirmImpliedUp = normalizeBinaryMidProbability(confirmUpMid, confirmDownMid);

  if (primaryImpliedUp == null || confirmImpliedUp == null) {
    return {
      primaryImpliedUp: null,
      confirmImpliedUp: null,
      divergence: null,
      consistency: null,
      alignedWithChosenSide: null,
      confirmSide: null
    };
  }

  const divergence = Math.abs(primaryImpliedUp - confirmImpliedUp);
  const consistency = Math.max(0, 1 - divergence);
  const confirmSide =
    confirmImpliedUp > 0.5 ? "UP" : confirmImpliedUp < 0.5 ? "DOWN" : null;
  const alignedWithChosenSide =
    chosenSide === "UP" || chosenSide === "DOWN"
      ? confirmSide == null
        ? null
        : confirmSide === chosenSide
      : null;

  return {
    primaryImpliedUp,
    confirmImpliedUp,
    divergence,
    consistency,
    alignedWithChosenSide,
    confirmSide
  };
}
