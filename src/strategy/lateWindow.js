/**
 * Nos últimos N minutos antes do fim:
 * Agora a decisão ignora o spread do Polymarket.
 * A decisão é pautada estritamente na distância de preço da Binance vs Strike (ptbDelta)
 * para identificar a tendência verdadeira, permitindo que a gente engatilhe 
 * oportunidades (Sniper) onde os odds do Polymarket divergirem fortemente (ex: baterem 0.20)!
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

  // 1. Determina a direção REAL (Binance) ignorando ilusões de preço do Polymarket.
  // Requer pelo menos $5 dólares de margem a favor pra sentirmos firmeza na ponta.
  let chosenSide = null;
  if (ptbDelta !== undefined && ptbDelta !== null && Number.isFinite(ptbDelta)) {
      if (ptbDelta >= 5) chosenSide = "UP";
      else if (ptbDelta <= -5) chosenSide = "DOWN";
  }

  if (!chosenSide) {
      return { inWindow: true, result: "SKIP_DELTA_TOO_SMALL", side: null, upMid, downMid };
  }

  // 2. Filtro Antiexaustão (RSI)
  // Evitar comprar UP no topo sobrecomprado (>75) ou DOWN no fundo sobrevendido (<25)
  if (rsiNow !== undefined && rsiNow !== null && Number.isFinite(rsiNow)) {
      if (chosenSide === "UP" && rsiNow >= 75) return { inWindow: true, result: "SKIP_RSI_OVERBOUGHT", side: null, upMid, downMid };
      if (chosenSide === "DOWN" && rsiNow <= 25) return { inWindow: true, result: "SKIP_RSI_OVERSOLD", side: null, upMid, downMid };
  }

  // 3. Filtro Antimomento (Confluência MACD/Heiken Ashi da Binance)
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
