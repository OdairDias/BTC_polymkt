/**
 * Decide o lado na janela final.
 * - decisionMode=sniper_v2 (padrao atual): direcao por ptbDelta + filtros RSI/MACD/HA
 * - decisionMode=main_2m_mid: replica a logica da main (UP vs DOWN por mid com empate por epsilon)
 */
export function decideLateWindowSide({
  decisionMode = "sniper_v2",
  minutesLeft,
  entryMinutesLeft,
  upMid,
  downMid,
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

  // sniper_v2
  let chosenSide = null;
  if (ptbDelta !== undefined && ptbDelta !== null && Number.isFinite(ptbDelta)) {
    if (ptbDelta >= 5) chosenSide = "UP";
    else if (ptbDelta <= -5) chosenSide = "DOWN";
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

