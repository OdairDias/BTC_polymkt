/**
 * Preço de referência por lado: mid (bid+ask)/2 quando ambos existem; senão fallback (ex. buy / Gamma).
 * Valores típicos no CLOB: 0–1 (probabilidade implícita por share).
 */
export function midFromBook(book, buyFallback) {
  const bid = book?.bestBid;
  const ask = book?.bestAsk;
  if (bid != null && ask != null && Number.isFinite(Number(bid)) && Number.isFinite(Number(ask))) {
    return (Number(bid) + Number(ask)) / 2;
  }
  if (buyFallback != null && Number.isFinite(Number(buyFallback))) {
    return Number(buyFallback);
  }
  return null;
}
