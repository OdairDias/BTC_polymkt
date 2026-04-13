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
  haNarrative
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
    const upAsk = Number.isFinite(Number(upBuy)) ? Number(upBuy) : null;
    const downAsk = Number.isFinite(Number(downBuy)) ? Number(downBuy) : null;
    if (upAsk === null || downAsk === null) {
      return { inWindow: true, result: "SKIP_NO_BUY_PRICE", side: null, upMid, downMid };
    }

    if (Math.abs(upAsk - downAsk) <= eps) {
      return { inWindow: true, result: "SKIP_TIE", side: null, upMid, downMid };
    }

    const chosenSide = upAsk < downAsk ? "UP" : "DOWN";
    const cheapPrice = chosenSide === "UP" ? upAsk : downAsk;
    const maxEntry = Number(targetEntryPrice);
    const minEntry = Number(minEntryPrice);

    if (!Number.isFinite(maxEntry) || maxEntry <= 0) {
      return { inWindow: true, result: "SKIP_BAD_TARGET_PRICE", side: null, upMid, downMid };
    }
    if (cheapPrice > maxEntry) {
      return { inWindow: true, result: "SKIP_CHEAP_TOO_EXPENSIVE", side: null, upMid, downMid };
    }
    if (Number.isFinite(minEntry) && minEntry > 0 && cheapPrice < minEntry) {
      return { inWindow: true, result: "SKIP_CHEAP_TOO_CHEAP", side: null, upMid, downMid };
    }

    const requiredEdge = Number(minEdge);
    const requiredModelProb = Number(minModelProb);
    const edgeGateEnabled = Number.isFinite(requiredEdge) && requiredEdge > 0;
    const modelProbGateEnabled = Number.isFinite(requiredModelProb) && requiredModelProb > 0;

    const selectedModelProbRaw = chosenSide === "UP" ? modelUp : modelDown;
    const selectedMarketProbRaw = chosenSide === "UP" ? marketUp : marketDown;
    const selectedBookImbalanceRaw = chosenSide === "UP" ? upBookImbalance : downBookImbalance;
    const selectedSpreadRaw = chosenSide === "UP" ? upSpread : downSpread;
    const selectedModelProb = Number.isFinite(Number(selectedModelProbRaw)) ? Number(selectedModelProbRaw) : null;
    const selectedMarketProb = Number.isFinite(Number(selectedMarketProbRaw)) ? Number(selectedMarketProbRaw) : null;
    const selectedBookImbalance =
      Number.isFinite(Number(selectedBookImbalanceRaw)) && Number(selectedBookImbalanceRaw) > 0
        ? Number(selectedBookImbalanceRaw)
        : null;
    const selectedSpread =
      Number.isFinite(Number(selectedSpreadRaw)) && Number(selectedSpreadRaw) >= 0
        ? Number(selectedSpreadRaw)
        : null;
    const selectedEdge =
      selectedModelProb !== null && selectedMarketProb !== null
        ? selectedModelProb - selectedMarketProb
        : null;

    if (modelProbGateEnabled) {
      if (selectedModelProb === null) {
        return { inWindow: true, result: "SKIP_MODEL_PROB_UNAVAILABLE", side: null, upMid, downMid };
      }
      if (selectedModelProb < requiredModelProb) {
        return { inWindow: true, result: "SKIP_MODEL_PROB_TOO_LOW", side: null, upMid, downMid };
      }
    }

    if (edgeGateEnabled) {
      if (selectedEdge === null) {
        return { inWindow: true, result: "SKIP_EDGE_UNAVAILABLE", side: null, upMid, downMid };
      }
      if (selectedEdge < requiredEdge) {
        return { inWindow: true, result: "SKIP_EDGE_TOO_SMALL", side: null, upMid, downMid };
      }
    }

    const requiredBookImbalance = Number(minBookImbalance);
    const bookImbalanceGateEnabled = Number.isFinite(requiredBookImbalance) && requiredBookImbalance > 0;
    if (bookImbalanceGateEnabled) {
      if (selectedBookImbalance === null) {
        return { inWindow: true, result: "SKIP_BOOK_IMBALANCE_UNAVAILABLE", side: null, upMid, downMid };
      }
      if (selectedBookImbalance < requiredBookImbalance) {
        return { inWindow: true, result: "SKIP_BOOK_IMBALANCE_TOO_LOW", side: null, upMid, downMid };
      }
    }

    const spreadToEdgeRatio = Number(maxSpreadToEdgeRatio);
    const spreadVsEdgeGateEnabled = Number.isFinite(spreadToEdgeRatio) && spreadToEdgeRatio > 0;
    if (spreadVsEdgeGateEnabled) {
      if (selectedSpread === null) {
        return { inWindow: true, result: "SKIP_SPREAD_UNAVAILABLE", side: null, upMid, downMid };
      }
      if (selectedEdge === null || selectedEdge <= 0) {
        return { inWindow: true, result: "SKIP_SPREAD_EDGE_UNAVAILABLE", side: null, upMid, downMid };
      }
      if (selectedSpread >= spreadToEdgeRatio * selectedEdge) {
        return { inWindow: true, result: "SKIP_SPREAD_TOO_WIDE_FOR_EDGE", side: null, upMid, downMid };
      }
    }

    return {
      inWindow: true,
      result: chosenSide,
      side: chosenSide,
      upMid,
      downMid,
      selectedModelProb,
      selectedMarketProb,
      selectedEdge,
      selectedBookImbalance,
      selectedSpread
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
