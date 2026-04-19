import { computeCrossMarketConsistency } from "./crossMarket.js";

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickEntryTier(entryPriceTiers, minutesLeft) {
  if (!Array.isArray(entryPriceTiers)) return null;
  const t = toFiniteNumber(minutesLeft);
  if (t == null) return null;

  for (const tier of entryPriceTiers) {
    const min = toFiniteNumber(tier?.minutesLeftMin);
    const max = toFiniteNumber(tier?.minutesLeftMax);
    const aboveMin = min == null ? true : t >= min;
    const belowMax = max == null ? true : t <= max;
    if (aboveMin && belowMax) {
      return tier;
    }
  }
  return null;
}

function isTrendAgainstSide(regimeDetected, side) {
  if (side === "UP") return regimeDetected === "TREND_DOWN";
  if (side === "DOWN") return regimeDetected === "TREND_UP";
  return false;
}

/**
 * Decide o lado na janela final.
 * - decisionMode=sniper_v2 (padrao atual): direcao por ptbDelta + filtros RSI/MACD/HA
 * - decisionMode=main_2m_mid: replica a logica da main (UP vs DOWN por mid com empate por epsilon)
 * - decisionMode=cheap_revert: entra cedo no lado mais barato e tenta vender antes do fim
 */
export function decideLateWindowSide({
  decisionMode = "sniper_v2",
  minutesLeft,
  entryMinutesLeft,
  upMid,
  downMid,
  upBuy,
  downBuy,
  upBookImbalance,
  downBookImbalance,
  upSpread,
  downSpread,
  modelUp,
  modelDown,
  marketUp,
  marketDown,
  targetEntryPrice,
  minEntryPrice,
  minEdge,
  minModelProb,
  minBookImbalance,
  maxSpreadToEdgeRatio,
  volAtrUsd,
  sniperDeltaFloorUsd,
  sniperDeltaAtrMult,
  epsilon,
  ptbDelta,
  rsiNow,
  macd,
  haNarrative,
  entryPriceTiers,
  maxSumMids,
  minSumMids,
  binaryDiscountBonus,
  regimeDetected,
  regimeGateEnabled,
  regimeTrendEdgeMultiplier,
  oracleLagMs,
  oracleLagBonusEnabled,
  oracleLagBonusMinMs,
  oracleLagBonusMinDelta,
  oracleLagBonusEdge,
  crossMarketUpMid,
  crossMarketDownMid,
  crossMarketMaxDivergence,
  crossMarketEdgeBonus,
  crossMarketRequired
}) {
  const window = Number(entryMinutesLeft);
  const eps = Number(epsilon) || 0;
  const t = minutesLeft;

  if (t === null || t === undefined || !Number.isFinite(t)) {
    return { inWindow: false, result: "SKIP_NO_TIME", side: null, upMid, downMid };
  }
  if (t <= 0) {
    return { inWindow: false, result: "SKIP_EXPIRED", side: null, upMid, downMid };
  }
  if (t > window) {
    return { inWindow: false, result: "SKIP_OUTSIDE_WINDOW", side: null, upMid, downMid };
  }

  if (upMid === null || downMid === null || !Number.isFinite(upMid) || !Number.isFinite(downMid)) {
    return { inWindow: true, result: "SKIP_NO_DATA", side: null, upMid, downMid };
  }

  const mode = String(decisionMode || "sniper_v2").toLowerCase();
  if (mode === "main_2m_mid") {
    const diff = upMid - downMid;
    if (Math.abs(diff) <= eps) {
      return { inWindow: true, result: "SKIP_TIE", side: null, upMid, downMid };
    }
    if (diff > 0) return { inWindow: true, result: "UP", side: "UP", upMid, downMid };
    return { inWindow: true, result: "DOWN", side: "DOWN", upMid, downMid };
  }

  if (mode === "cheap_revert") {
    const upAsk = toFiniteNumber(upBuy);
    const downAsk = toFiniteNumber(downBuy);
    if (upAsk === null || downAsk === null) {
      return { inWindow: true, result: "SKIP_NO_BUY_PRICE", side: null, upMid, downMid };
    }

    if (Math.abs(upAsk - downAsk) <= eps) {
      return { inWindow: true, result: "SKIP_TIE", side: null, upMid, downMid };
    }

    const chosenSide = upAsk < downAsk ? "UP" : "DOWN";
    const cheapPrice = chosenSide === "UP" ? upAsk : downAsk;
    const entryTier = pickEntryTier(entryPriceTiers, t);
    const maxEntry = toFiniteNumber(entryTier?.maxPrice) ?? toFiniteNumber(targetEntryPrice);
    const minEntry = toFiniteNumber(minEntryPrice);

    if (!Number.isFinite(maxEntry) || maxEntry <= 0) {
      return { inWindow: true, result: "SKIP_BAD_TARGET_PRICE", side: null, upMid, downMid };
    }
    if (cheapPrice > maxEntry) {
      return {
        inWindow: true,
        result: "SKIP_CHEAP_TOO_EXPENSIVE",
        side: null,
        upMid,
        downMid,
        entryTier,
        cheapPrice,
        maxEntryPrice: maxEntry
      };
    }
    if (Number.isFinite(minEntry) && minEntry > 0 && cheapPrice < minEntry) {
      return {
        inWindow: true,
        result: "SKIP_CHEAP_TOO_CHEAP",
        side: null,
        upMid,
        downMid,
        entryTier,
        cheapPrice,
        minEntryPrice: minEntry
      };
    }

    const sumMids = upMid + downMid;
    const minValidSumMids = toFiniteNumber(minSumMids);
    const maxValidSumMids = toFiniteNumber(maxSumMids);
    if (minValidSumMids != null && sumMids < minValidSumMids) {
      return {
        inWindow: true,
        result: "SKIP_BINARY_SUM_TOO_LOW",
        side: null,
        upMid,
        downMid,
        binarySumMids: sumMids,
        entryTier
      };
    }
    if (maxValidSumMids != null && sumMids > maxValidSumMids) {
      return {
        inWindow: true,
        result: "SKIP_BINARY_SPREAD_TOO_WIDE",
        side: null,
        upMid,
        downMid,
        binarySumMids: sumMids,
        entryTier
      };
    }

    const requiredEdge = toFiniteNumber(entryTier?.minEdge) ?? toFiniteNumber(minEdge);
    const requiredModelProb = toFiniteNumber(entryTier?.minModelProb) ?? toFiniteNumber(minModelProb);
    const requiredBookImbalance = toFiniteNumber(entryTier?.minBookImbalance) ?? toFiniteNumber(minBookImbalance);
    const edgeGateEnabled = requiredEdge != null && requiredEdge > 0;
    const modelProbGateEnabled = requiredModelProb != null && requiredModelProb > 0;

    const selectedModelProbRaw = chosenSide === "UP" ? modelUp : modelDown;
    const selectedMarketProbRaw = chosenSide === "UP" ? marketUp : marketDown;
    const selectedBookImbalanceRaw = chosenSide === "UP" ? upBookImbalance : downBookImbalance;
    const selectedSpreadRaw = chosenSide === "UP" ? upSpread : downSpread;
    const selectedModelProb = toFiniteNumber(selectedModelProbRaw);
    const selectedMarketProb = toFiniteNumber(selectedMarketProbRaw);
    const selectedBookImbalance =
      toFiniteNumber(selectedBookImbalanceRaw) != null && Number(selectedBookImbalanceRaw) > 0
        ? Number(selectedBookImbalanceRaw)
        : null;
    const selectedSpread =
      toFiniteNumber(selectedSpreadRaw) != null && Number(selectedSpreadRaw) >= 0
        ? Number(selectedSpreadRaw)
        : null;
    const selectedBaseEdge =
      selectedModelProb !== null && selectedMarketProb !== null
        ? selectedModelProb - selectedMarketProb
        : null;

    if (modelProbGateEnabled) {
      if (selectedModelProb === null) {
        return {
          inWindow: true,
          result: "SKIP_MODEL_PROB_UNAVAILABLE",
          side: null,
          upMid,
          downMid,
          entryTier,
          requiredModelProb
        };
      }
      if (selectedModelProb < requiredModelProb) {
        return {
          inWindow: true,
          result: "SKIP_MODEL_PROB_TOO_LOW",
          side: null,
          upMid,
          downMid,
          entryTier,
          selectedModelProb,
          requiredModelProb
        };
      }
    }

    const binaryDiscount = Number.isFinite(sumMids) ? 1 - sumMids : null;
    const binaryEdgeBonus =
      binaryDiscount != null && binaryDiscount > 0
        ? binaryDiscount * (toFiniteNumber(binaryDiscountBonus) ?? 0)
        : 0;

    const lag = toFiniteNumber(oracleLagMs);
    const lagDelta = Math.abs(toFiniteNumber(ptbDelta) ?? 0);
    const lagAligned =
      (chosenSide === "UP" && (toFiniteNumber(ptbDelta) ?? 0) > 0) ||
      (chosenSide === "DOWN" && (toFiniteNumber(ptbDelta) ?? 0) < 0);
    const oracleLagEdgeBonus =
      oracleLagBonusEnabled &&
      lag != null &&
      lag >= (toFiniteNumber(oracleLagBonusMinMs) ?? 0) &&
      lagDelta >= (toFiniteNumber(oracleLagBonusMinDelta) ?? 0) &&
      lagAligned
        ? (toFiniteNumber(oracleLagBonusEdge) ?? 0)
        : 0;

    const crossMarket = computeCrossMarketConsistency({
      primaryUpMid: upMid,
      primaryDownMid: downMid,
      confirmUpMid: crossMarketUpMid,
      confirmDownMid: crossMarketDownMid,
      chosenSide
    });
    const maxCrossDivergence = toFiniteNumber(crossMarketMaxDivergence);
    if (
      crossMarketRequired &&
      crossMarket.primaryImpliedUp != null &&
      crossMarket.confirmImpliedUp != null &&
      maxCrossDivergence != null &&
      crossMarket.divergence != null &&
      crossMarket.divergence > maxCrossDivergence
    ) {
      return {
        inWindow: true,
        result: "SKIP_CROSS_MARKET_DIVERGENCE",
        side: null,
        upMid,
        downMid,
        entryTier,
        binarySumMids: sumMids,
        crossMarketConsistency: crossMarket.consistency,
        crossMarketDivergence: crossMarket.divergence,
        maxCrossMarketDivergence: maxCrossDivergence
      };
    }
    if (
      crossMarketRequired &&
      crossMarket.alignedWithChosenSide === false
    ) {
      return {
        inWindow: true,
        result: "SKIP_CROSS_MARKET_AGAINST",
        side: null,
        upMid,
        downMid,
        entryTier,
        binarySumMids: sumMids,
        crossMarketConsistency: crossMarket.consistency,
        crossMarketDivergence: crossMarket.divergence
      };
    }

    const crossMarketBonus =
      crossMarket.alignedWithChosenSide === true
        ? (toFiniteNumber(crossMarketEdgeBonus) ?? 0)
        : 0;
    const selectedEdge =
      selectedBaseEdge == null
        ? null
        : selectedBaseEdge + binaryEdgeBonus + oracleLagEdgeBonus + crossMarketBonus;

    if (edgeGateEnabled) {
      if (selectedEdge === null) {
        return { inWindow: true, result: "SKIP_EDGE_UNAVAILABLE", side: null, upMid, downMid, entryTier };
      }
      if (selectedEdge < requiredEdge) {
        return {
          inWindow: true,
          result: "SKIP_EDGE_TOO_SMALL",
          side: null,
          upMid,
          downMid,
          entryTier,
          selectedBaseEdge,
          selectedEdge,
          requiredEdge
        };
      }
    }

    const bookImbalanceGateEnabled = requiredBookImbalance != null && requiredBookImbalance > 0;
    if (bookImbalanceGateEnabled) {
      if (selectedBookImbalance === null) {
        return {
          inWindow: true,
          result: "SKIP_BOOK_IMBALANCE_UNAVAILABLE",
          side: null,
          upMid,
          downMid,
          entryTier,
          requiredBookImbalance
        };
      }
      if (selectedBookImbalance < requiredBookImbalance) {
        return {
          inWindow: true,
          result: "SKIP_BOOK_IMBALANCE_TOO_LOW",
          side: null,
          upMid,
          downMid,
          entryTier,
          selectedBookImbalance,
          requiredBookImbalance
        };
      }
    }

    const trendEdgeMultiplier =
      toFiniteNumber(regimeTrendEdgeMultiplier) != null && Number(regimeTrendEdgeMultiplier) > 1
        ? Number(regimeTrendEdgeMultiplier)
        : 1;
    if (regimeGateEnabled && isTrendAgainstSide(regimeDetected, chosenSide)) {
      const trendRequiredEdge =
        requiredEdge != null && requiredEdge > 0 ? requiredEdge * trendEdgeMultiplier : null;
      if (trendRequiredEdge != null && (selectedEdge == null || selectedEdge < trendRequiredEdge)) {
        return {
          inWindow: true,
          result: "SKIP_REGIME_TREND_AGAINST",
          side: null,
          upMid,
          downMid,
          entryTier,
          selectedEdge,
          regimeDetected
        };
      }
    }

    const spreadToEdgeRatio = Number(maxSpreadToEdgeRatio);
    const spreadVsEdgeGateEnabled = Number.isFinite(spreadToEdgeRatio) && spreadToEdgeRatio > 0;
    if (spreadVsEdgeGateEnabled) {
      if (selectedSpread === null) {
        return { inWindow: true, result: "SKIP_SPREAD_UNAVAILABLE", side: null, upMid, downMid, entryTier };
      }
      if (selectedEdge === null || selectedEdge <= 0) {
        return { inWindow: true, result: "SKIP_SPREAD_EDGE_UNAVAILABLE", side: null, upMid, downMid, entryTier };
      }
      if (selectedSpread >= spreadToEdgeRatio * selectedEdge) {
        return { inWindow: true, result: "SKIP_SPREAD_TOO_WIDE_FOR_EDGE", side: null, upMid, downMid, entryTier };
      }
    }

    return {
      inWindow: true,
      result: chosenSide,
      side: chosenSide,
      upMid,
      downMid,
      entryTier,
      selectedModelProb,
      selectedMarketProb,
      selectedBaseEdge,
      selectedEdge,
      selectedBookImbalance,
      selectedSpread,
      binarySumMids: sumMids,
      binaryDiscount,
      binaryEdgeBonus,
      oracleLagEdgeBonus,
      regimeDetected: regimeDetected ?? null,
      crossMarketConsistency: crossMarket.consistency,
      crossMarketDivergence: crossMarket.divergence,
      crossMarketAligned: crossMarket.alignedWithChosenSide
    };
  }

  // sniper_v2
  const floorDelta = Number(sniperDeltaFloorUsd);
  const atrMult = Number(sniperDeltaAtrMult);
  const atr = Number(volAtrUsd);
  const dynamicDeltaThreshold = Math.max(
    Number.isFinite(floorDelta) && floorDelta > 0 ? floorDelta : 5,
    Number.isFinite(atr) && atr > 0 && Number.isFinite(atrMult) && atrMult > 0 ? atr * atrMult : 0
  );

  let chosenSide = null;
  if (ptbDelta !== undefined && ptbDelta !== null && Number.isFinite(ptbDelta)) {
    if (ptbDelta >= dynamicDeltaThreshold) chosenSide = "UP";
    else if (ptbDelta <= -dynamicDeltaThreshold) chosenSide = "DOWN";
  }

  if (!chosenSide) {
    return { inWindow: true, result: "SKIP_DELTA_TOO_SMALL", side: null, upMid, downMid };
  }

  if (rsiNow !== undefined && rsiNow !== null && Number.isFinite(rsiNow)) {
    if (chosenSide === "UP" && rsiNow >= 75) {
      return { inWindow: true, result: "SKIP_RSI_OVERBOUGHT", side: null, upMid, downMid };
    }
    if (chosenSide === "DOWN" && rsiNow <= 25) {
      return { inWindow: true, result: "SKIP_RSI_OVERSOLD", side: null, upMid, downMid };
    }
  }

  if (macd !== undefined && macd !== null && haNarrative !== undefined) {
    const isMacdBearish = macd.hist < 0;
    if (chosenSide === "UP" && isMacdBearish && haNarrative === "SHORT") {
      return { inWindow: true, result: "SKIP_MOMENTUM_AGAINST_UP", side: null, upMid, downMid };
    }

    const isMacdBullish = macd.hist > 0;
    if (chosenSide === "DOWN" && isMacdBullish && haNarrative === "LONG") {
      return { inWindow: true, result: "SKIP_MOMENTUM_AGAINST_DOWN", side: null, upMid, downMid };
    }
  }

  return { inWindow: true, result: chosenSide, side: chosenSide, upMid, downMid };
}
