import { CONFIG } from "../config.js";
import { normalizeBinarySide } from "../strategy/outcomeInfer.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function pickNumericField(obj, candidates) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of candidates) {
    if (obj[k] == null) continue;
    const n = toNumber(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

function inferReferencePrices(market) {
  const priceToBeat = pickNumericField(market, [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "threshold",
    "thresholdPrice"
  ]);
  const priceAtClose = pickNumericField(market, [
    "finalPrice",
    "final_price",
    "closePrice",
    "close_price",
    "endPrice",
    "end_price",
    "resolvedPrice",
    "resolved_price"
  ]);

  if (priceToBeat !== null || priceAtClose !== null) {
    return { priceToBeat, priceAtClose };
  }

  const events = Array.isArray(market?.events) ? market.events : [];
  for (const e of events) {
    const p1 = pickNumericField(e, [
      "priceToBeat",
      "price_to_beat",
      "strikePrice",
      "strike_price",
      "threshold",
      "thresholdPrice"
    ]);
    const p2 = pickNumericField(e, [
      "finalPrice",
      "final_price",
      "closePrice",
      "close_price",
      "endPrice",
      "end_price",
      "resolvedPrice",
      "resolved_price"
    ]);
    if (p1 !== null || p2 !== null) {
      return { priceToBeat: p1, priceAtClose: p2 };
    }
  }

  return { priceToBeat: null, priceAtClose: null };
}

export async function fetchMarketBySlug(slug) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("slug", slug);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma markets error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const market = Array.isArray(data) ? data[0] : data;
  if (!market) return null;

  return market;
}

export function extractResolvedOutcomeFromMarket(market, { minWinnerPrice = 0.99 } = {}) {
  const outcomes = parseJsonArray(market?.outcomes).map((x) => String(x));
  const outcomePrices = parseJsonArray(market?.outcomePrices).map((x) => toNumber(x));
  const status = String(market?.umaResolutionStatus ?? "").toLowerCase();
  const closed = Boolean(market?.closed);

  let winnerLabel = null;
  if (outcomes.length && outcomePrices.length === outcomes.length) {
    let bestIdx = -1;
    let bestPrice = -Infinity;
    for (let i = 0; i < outcomePrices.length; i += 1) {
      const p = outcomePrices[i];
      if (p === null) continue;
      if (p > bestPrice) {
        bestPrice = p;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestPrice >= minWinnerPrice) {
      winnerLabel = outcomes[bestIdx] ?? null;
    }
  }

  const winner = normalizeBinarySide(winnerLabel);
  const resolved = status === "resolved" || (closed && winner !== null);
  const resolvedAt = market?.closedTime ?? market?.umaEndDate ?? market?.endDate ?? null;
  const resolutionSource = market?.resolutionSource ?? null;
  const { priceToBeat, priceAtClose } = inferReferencePrices(market);

  return {
    resolved,
    winner,
    winnerLabel,
    resolutionStatus: status || null,
    resolvedAt,
    resolutionSource,
    outcomes,
    outcomePrices,
    priceToBeat,
    priceAtClose
  };
}

export async function fetchMarketsBySeriesSlug({ seriesSlug, limit = 50 }) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("seriesSlug", seriesSlug);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("enableOrderBook", "true");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma markets(series) error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchLiveEventsBySeriesId({ seriesId, limit = 20 }) {
  const url = new URL("/events", CONFIG.gammaBaseUrl);
  url.searchParams.set("series_id", String(seriesId));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma events(series_id) error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export function flattenEventMarkets(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const markets = Array.isArray(e.markets) ? e.markets : [];
    for (const m of markets) {
      out.push(m);
    }
  }
  return out;
}

export async function fetchActiveMarkets({ limit = 200, offset = 0 } = {}) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("enableOrderBook", "true");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma markets(active) error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function safeTimeMs(x) {
  if (!x) return null;
  const t = new Date(x).getTime();
  return Number.isFinite(t) ? t : null;
}

export function pickLatestLiveMarket(markets, nowMs = Date.now()) {
  if (!Array.isArray(markets) || markets.length === 0) return null;

  const enriched = markets
    .map((m) => {
      const endMs = safeTimeMs(m.endDate);
      const startMs = safeTimeMs(m.eventStartTime ?? m.startTime ?? m.startDate);
      return { m, endMs, startMs };
    })
    .filter((x) => x.endMs !== null);

  const live = enriched
    .filter((x) => {
      const started = x.startMs === null ? true : x.startMs <= nowMs;
      return started && nowMs < x.endMs;
    })
    .sort((a, b) => a.endMs - b.endMs);

  if (live.length) return live[0].m;

  const upcoming = enriched
    .filter((x) => nowMs < x.endMs)
    .sort((a, b) => a.endMs - b.endMs);

  return upcoming.length ? upcoming[0].m : null;
}

function marketHasSeriesSlug(market, seriesSlug) {
  if (!market || !seriesSlug) return false;

  const events = Array.isArray(market.events) ? market.events : [];
  for (const e of events) {
    const series = Array.isArray(e.series) ? e.series : [];
    for (const s of series) {
      if (String(s.slug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
    }
    if (String(e.seriesSlug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
  }
  if (String(market.seriesSlug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
  return false;
}

export function filterBtcUpDownSeriesMarkets(markets, { seriesSlug, slugPrefix } = {}) {
  const prefix = (slugPrefix ?? "").toLowerCase();
  const wantedSeries = (seriesSlug ?? "").toLowerCase();

  return (Array.isArray(markets) ? markets : []).filter((m) => {
    const slug = String(m.slug ?? "").toLowerCase();
    const matchesPrefix = prefix ? slug.startsWith(prefix) : false;
    const matchesSeries = wantedSeries ? marketHasSeriesSlug(m, wantedSeries) : false;
    return matchesPrefix || matchesSeries;
  });
}

export async function fetchClobPrice({ tokenId, side }) {
  const url = new URL("/price", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);
  url.searchParams.set("side", side);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CLOB price error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return toNumber(data.price);
}

export async function fetchOrderBook({ tokenId }) {
  const url = new URL("/book", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CLOB book error: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

export function summarizeOrderBook(book, depthLevels = 5) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  const bestBid = bids.length
    ? bids.reduce((best, lvl) => {
        const p = toNumber(lvl.price);
        if (p === null) return best;
        if (best === null) return p;
        return Math.max(best, p);
      }, null)
    : null;

  const bestAsk = asks.length
    ? asks.reduce((best, lvl) => {
        const p = toNumber(lvl.price);
        if (p === null) return best;
        if (best === null) return p;
        return Math.min(best, p);
      }, null)
    : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  const bidLiquidity = bids.slice(0, depthLevels).reduce((acc, x) => acc + (toNumber(x.size) ?? 0), 0);
  const askLiquidity = asks.slice(0, depthLevels).reduce((acc, x) => acc + (toNumber(x.size) ?? 0), 0);

  return {
    bestBid,
    bestAsk,
    spread,
    bidLiquidity,
    askLiquidity
  };
}
