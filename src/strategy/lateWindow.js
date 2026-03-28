/**
 * Nos últimos N minutos antes do fim: comparar UP vs DOWN (mid); maior ganha; empate = sem entrada.
 */
export function decideLateWindowSide({
  minutesLeft,
  entryMinutesLeft,
  upMid,
  downMid,
  epsilon
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
  if (diff > 0) {
    return { inWindow: true, result: "UP", side: "UP", upMid, downMid };
  }
  return { inWindow: true, result: "DOWN", side: "DOWN", upMid, downMid };
}
