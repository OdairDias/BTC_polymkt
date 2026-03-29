/**
 * Nos últimos N minutos antes do fim: comparar UP vs DOWN (mid); maior ganha; empate = sem entrada.
 */
export function decideLateWindowSide({
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

  const diff = upMid - downMid;
  if (Math.abs(diff) <= eps) {
    return { inWindow: true, result: "SKIP_TIE", side: null, upMid, downMid };
  }

  const chosenSide = diff > 0 ? "UP" : "DOWN";

  // 1. Teto de Preço (Kelly Limit Risk/Reward)
  // Max price to enter: 0.88 (~$0.12 of minimum profit upside per share)
  if (chosenSide === "UP" && upMid > 0.88) return { inWindow: true, result: "SKIP_UP_TOO_EXPENSIVE", side: null, upMid, downMid };
  if (chosenSide === "DOWN" && downMid > 0.88) return { inWindow: true, result: "SKIP_DOWN_TOO_EXPENSIVE", side: null, upMid, downMid };

  // 2. Filtro de Segurança por "Delta Real" (Distância do Strike)
  // Requer pelo menos $5 dólares de margem de segurança na Binance vs Strike
  if (ptbDelta !== undefined && ptbDelta !== null && Number.isFinite(ptbDelta)) {
      if (chosenSide === "UP" && ptbDelta < 5) return { inWindow: true, result: "SKIP_DELTA_UP_TOO_SMALL", side: null, upMid, downMid };
      if (chosenSide === "DOWN" && ptbDelta > -5) return { inWindow: true, result: "SKIP_DELTA_DOWN_TOO_SMALL", side: null, upMid, downMid };
  }

  // 3. Filtro Antiexaustão (RSI)
  // Evitar comprar UP no topo sobrecomprado (>75) ou DOWN no fundo sobrevendido (<25)
  if (rsiNow !== undefined && rsiNow !== null && Number.isFinite(rsiNow)) {
      if (chosenSide === "UP" && rsiNow >= 75) return { inWindow: true, result: "SKIP_RSI_OVERBOUGHT", side: null, upMid, downMid };
      if (chosenSide === "DOWN" && rsiNow <= 25) return { inWindow: true, result: "SKIP_RSI_OVERSOLD", side: null, upMid, downMid };
  }

  // 4. Filtro Antimomento (Confluência MACD/Heiken Ashi)
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
