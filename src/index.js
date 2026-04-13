import "dotenv/config";
import { Wallet } from "ethers";
import { CONFIG } from "./config.js";
import { assertValidEvmPrivateKeyForClob, isRelayerBuilderConfigured } from "./automation/liveClob.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchMarketsBySeriesSlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { computeAtr } from "./indicators/volatility.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { computeFairValue, estimateOracleProbability } from "./strategy/fairValue.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { runPaperStrategyTick } from "./automation/paperStrategy.js";
import { runPaperOutcomeTick } from "./automation/paperOutcome.js";
import { startDashboard, dashboardState } from "./dashboard/server.js";

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

const marketCacheByKey = new Map();
const priceToBeatStateByMarket = new Map();

function timeLeftColorBand(minutesLeft, windowMinutes) {
  const w = Math.max(1, Number(windowMinutes) || 1);
  const hi = w * (10 / 15);
  const mid = w * (5 / 15);
  if (minutesLeft >= hi) return ANSI.green;
  if (minutesLeft >= mid) return ANSI.yellow;
  if (minutesLeft >= 0 && minutesLeft < mid) return ANSI.red;
  return ANSI.reset;
}

function buildMarketConfigKey(config = {}) {
  return JSON.stringify({
    marketSlug: config.marketSlug ?? "",
    marketSlugPrefix: config.marketSlugPrefix ?? "",
    marketWindowMinutes: config.marketWindowMinutes ?? null,
    seriesId: config.seriesId ?? "",
    seriesSlug: config.seriesSlug ?? "",
    autoSelectLatest: config.autoSelectLatest !== false
  });
}

function buildRecurringMarketSlug({ slugPrefix, windowMinutes, nowMs = Date.now() }) {
  const prefix = String(slugPrefix ?? "").trim();
  const window = Number(windowMinutes);
  if (!prefix || !Number.isFinite(window) || window <= 0) return null;
  const bucketMs = Math.floor(nowMs / (window * 60_000)) * window * 60_000;
  return `${prefix}-${Math.floor(bucketMs / 1000)}`;
}

function getStrategyMarketGroups() {
  const configured = Array.isArray(CONFIG.strategy.variants) ? CONFIG.strategy.variants : [];
  const variants = configured.filter((variant) => variant && variant.enabled !== false);
  const groups = new Map();

  for (const variant of variants) {
    const customMarketConfig = {
      marketSlug: String(variant.marketSlug ?? "").trim(),
      marketSlugPrefix: String(variant.marketSlugPrefix ?? "").trim(),
      marketWindowMinutes: Number.isFinite(Number(variant.marketWindowMinutes))
        ? Number(variant.marketWindowMinutes)
        : null,
      seriesId: String(variant.marketSeriesId ?? "").trim(),
      seriesSlug: String(variant.marketSeriesSlug ?? "").trim(),
      autoSelectLatest: true
    };

    const hasCustomMarket =
      Boolean(customMarketConfig.marketSlug) ||
      Boolean(customMarketConfig.marketSlugPrefix) ||
      Boolean(customMarketConfig.seriesId) ||
      Boolean(customMarketConfig.seriesSlug);

    const groupKey = hasCustomMarket ? buildMarketConfigKey(customMarketConfig) : "__default__";
    const existing = groups.get(groupKey) ?? {
      key: groupKey,
      marketConfig: hasCustomMarket ? customMarketConfig : {},
      variants: []
    };
    existing.variants.push(variant);
    groups.set(groupKey, existing);
  }

  if (!groups.size) {
    groups.set("__default__", {
      key: "__default__",
      marketConfig: {},
      variants: []
    });
  }

  return Array.from(groups.values());
}

function describeStrategyVariant(variant) {
  const marketRef = variant.marketSlug
    ? `slug=${variant.marketSlug}`
    : variant.marketSlugPrefix
      ? `prefix=${variant.marketSlugPrefix}/${variant.marketWindowMinutes ?? "?"}m`
      : `series=${CONFIG.polymarket.seriesSlug}`;
  return [
    variant.key,
    `mode=${variant.decisionMode}`,
    marketRef,
    `entry=${variant.entryMinutesLeft}m`,
    variant.grossProfitTargetUsd ? `gp=$${variant.grossProfitTargetUsd}` : null,
    variant.minEdge ? `minEdge=${variant.minEdge}` : null,
    variant.minModelProb ? `minProb=${variant.minModelProb}` : null,
    variant.paperFillMode ? `paperFill=${variant.paperFillMode}` : null,
    Number.isFinite(Number(variant.maxOracleLagMs)) && Number(variant.maxOracleLagMs) > 0
      ? `maxOracleLag=${Math.floor(Number(variant.maxOracleLagMs))}ms`
      : null,
    Number.isFinite(Number(variant.maxBinanceLagMs)) && Number(variant.maxBinanceLagMs) > 0
      ? `maxBinanceLag=${Math.floor(Number(variant.maxBinanceLagMs))}ms`
      : null,
    Number.isFinite(Number(variant.maxSnapshotAgeMs)) && Number(variant.maxSnapshotAgeMs) > 0
      ? `maxSnapAge=${Math.floor(Number(variant.maxSnapshotAgeMs))}ms`
      : null,
    `liveEntry=${variant.liveEntryOrderType ?? "FOK"}`,
    `liveExit=${variant.liveExitOrderType ?? variant.liveEntryOrderType ?? "FOK"}`
  ].filter(Boolean).join(" ");
}

function updatePriceToBeatState({ marketSlug, marketStartMs, currentPrice }) {
  const slug = String(marketSlug ?? "");
  if (!slug) return null;

  const existing = priceToBeatStateByMarket.get(slug) ?? {
    value: null,
    setAtMs: null,
    marketStartMs: marketStartMs ?? null
  };
  if (marketStartMs != null) existing.marketStartMs = marketStartMs;

  if (existing.value === null && currentPrice !== null && Number.isFinite(Number(currentPrice))) {
    const nowMs = Date.now();
    const okToLatch = existing.marketStartMs == null ? true : nowMs >= existing.marketStartMs;
    if (okToLatch) {
      existing.value = Number(currentPrice);
      existing.setAtMs = nowMs;
    }
  }

  priceToBeatStateByMarket.set(slug, existing);
  if (priceToBeatStateByMarket.size > 100) {
    const oldestKey = priceToBeatStateByMarket.keys().next().value;
    if (oldestKey) priceToBeatStateByMarket.delete(oldestKey);
  }
  return existing.value;
}

async function resolveCurrentBtcMarket(marketConfig = {}) {
  const config = {
    marketSlug: String(marketConfig.marketSlug ?? CONFIG.polymarket.marketSlug ?? "").trim(),
    marketSlugPrefix: String(marketConfig.marketSlugPrefix ?? "").trim(),
    marketWindowMinutes: Number.isFinite(Number(marketConfig.marketWindowMinutes))
      ? Number(marketConfig.marketWindowMinutes)
      : null,
    seriesId: String(marketConfig.seriesId ?? CONFIG.polymarket.seriesId ?? "").trim(),
    seriesSlug: String(marketConfig.seriesSlug ?? CONFIG.polymarket.seriesSlug ?? "").trim(),
    autoSelectLatest: marketConfig.autoSelectLatest === undefined
      ? CONFIG.polymarket.autoSelectLatest
      : Boolean(marketConfig.autoSelectLatest)
  };

  if (config.marketSlug) {
    return await fetchMarketBySlug(config.marketSlug);
  }

  const cacheKey = buildMarketConfigKey(config);
  const now = Date.now();
  const cached = marketCacheByKey.get(cacheKey);
  if (cached?.market && now - cached.fetchedAtMs < CONFIG.pollIntervalMs) {
    return cached.market;
  }

  let picked = null;
  const triedSlugs = [];

  if (config.marketSlugPrefix && config.marketWindowMinutes) {
    const bucketMs = config.marketWindowMinutes * 60_000;
    const candidates = [
      now,
      now - bucketMs,
      now + bucketMs
    ]
      .map((candidateNow) => buildRecurringMarketSlug({
        slugPrefix: config.marketSlugPrefix,
        windowMinutes: config.marketWindowMinutes,
        nowMs: candidateNow
      }))
      .filter(Boolean);

    for (const candidateSlug of new Set(candidates)) {
      triedSlugs.push(candidateSlug);
      try {
        const market = await fetchMarketBySlug(candidateSlug);
        if (market) {
          picked = market;
          console.error(`[market] resolved via slug: ${candidateSlug}`);
          break;
        }
      } catch {
        // tenta o proximo slug candidato
      }
    }

    if (!picked) {
      console.error(`[market] slug candidates not found: ${triedSlugs.join(", ")} — trying series fallback`);
    }
  }

  // Fallback 1: por seriesId numérico
  if (!picked && config.autoSelectLatest && config.seriesId) {
    console.error(`[market] fallback seriesId=${config.seriesId}`);
    const events = await fetchLiveEventsBySeriesId({ seriesId: config.seriesId, limit: 25 });
    const markets = flattenEventMarkets(events);
    picked = pickLatestLiveMarket(markets);
    if (picked) console.error(`[market] resolved via seriesId=${config.seriesId}: ${picked.slug}`);
  }

  // Fallback 2: por seriesSlug (ex.: "btc-up-or-down-15m")
  if (!picked && config.autoSelectLatest && config.seriesSlug && config.seriesSlug !== CONFIG.polymarket.seriesSlug) {
    console.error(`[market] fallback seriesSlug=${config.seriesSlug}`);
    try {
      const markets = await fetchMarketsBySeriesSlug({ seriesSlug: config.seriesSlug, limit: 25 });
      picked = pickLatestLiveMarket(markets);
      if (picked) console.error(`[market] resolved via seriesSlug=${config.seriesSlug}: ${picked.slug}`);
    } catch (err) {
      console.error(`[market] seriesSlug fallback error: ${err?.message ?? err}`);
    }
  }

  if (!picked) {
    console.error(`[market] WARN: market not found for config prefix=${config.marketSlugPrefix} seriesId=${config.seriesId} seriesSlug=${config.seriesSlug}`);
  }

  marketCacheByKey.set(cacheKey, { market: picked, fetchedAtMs: now });
  return picked;
}

async function fetchPolymarketSnapshot(marketConfig = {}) {
  const fetchedAtMs = Date.now();
  const market = await resolveCurrentBtcMarket(marketConfig);

  if (!market) return { ok: false, reason: "market_not_found", fetchedAtMs };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      fetchedAtMs,
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    fetchedAtMs,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

async function main() {
  if (CONFIG.strategy.enabled) {
    const pk = (CONFIG.live.privateKey || "").trim();
    const fa = (CONFIG.live.funderAddress || "").trim();
    const funderLog =
      fa.length >= 12 ? `${fa.slice(0, 6)}…${fa.slice(-4)}` : fa ? "set(short)" : "none";
    let signerLog = "n/a";
    if (pk) {
      try {
        const addr = new Wallet(assertValidEvmPrivateKeyForClob(pk)).address;
        signerLog = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
      } catch {
        signerLog = "invalid_key";
      }
    }
    const relayerBuilder = isRelayerBuilderConfigured();
    const relayerHint = relayerBuilder
      ? "relayerBuilder=on"
      : (CONFIG.relayer.apiKeyAddress || "").trim()
        ? "relayerBuilder=incomplete(secret+passphrase)"
        : "relayerBuilder=off";
    console.log(
      `[strategy] dryRun=${CONFIG.strategy.dryRun} liveArmed=${CONFIG.strategy.liveArmed} ` +
        `privateKey=${pk ? "set" : "missing"} signer=${signerLog} signatureType=${CONFIG.live.signatureType} funder=${funderLog} ` +
        `${relayerHint} ` +
        `notionalUsd=${CONFIG.strategy.notionalUsd} databaseUrl=${CONFIG.strategy.databaseUrl ? "set" : "missing"} ` +
        `liveStrategyKey=${CONFIG.strategy.liveStrategyKey}`
    );
    const variantSummary = (Array.isArray(CONFIG.strategy.variants) ? CONFIG.strategy.variants : [])
      .map(describeStrategyVariant)
      .join(" | ");
    if (variantSummary) {
      console.log(`[strategy] variants ${variantSummary}`);
    }
  }

  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  let prevSpotPrice = null;
  let prevCurrentPrice = null;

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation"
  ];

  // Inicia o dashboard na porta 9090 (Railway) ou na porta configurada
  startDashboard(process.env.PORT || 9090);

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const strategyMarketGroups = getStrategyMarketGroups();
      const marketSnapshotsPromise = Promise.all(
        strategyMarketGroups.map(async (group) => ({
          ...group,
          poly: await fetchPolymarketSnapshot(group.marketConfig)
        }))
      );

      const [klines1m, klines5m, lastPrice, chainlink, marketSnapshots] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchKlines({ interval: "5m", limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        marketSnapshotsPromise
      ]);

      const displaySnapshot =
        marketSnapshots.find((group) => group.key === "__default__") ??
        marketSnapshots.find((group) => group.poly?.ok) ??
        marketSnapshots[0] ??
        { poly: { ok: false, reason: "market_not_found" } };
      const poly = displaySnapshot.poly;

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const marketDecisionWindowMinutes = Number.isFinite(Number(displaySnapshot?.marketConfig?.marketWindowMinutes))
        ? Number(displaySnapshot.marketConfig.marketWindowMinutes)
        : CONFIG.candleWindowMinutes;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, marketDecisionWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;
      const predictLine = `Predict: ${predictValue}`;

      const marketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
      const marketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
      const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;
      const deltaLine = `Delta 1/3Min: ${deltaValue}`;

      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const actionLine = rec.action === "ENTER"
        ? `${rec.action} NOW (${rec.phase} ENTRY)`
        : `NO TRADE (${rec.phase})`;

      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;

      const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);
      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;
      const priceToBeat = poly.ok
        ? updatePriceToBeatState({ marketSlug, marketStartMs, currentPrice })
        : null;
      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const volAtrUsd = computeAtr(klines5m, 14);
      const oracleProbUp = estimateOracleProbability({
        ptbDelta,
        volAtr: volAtrUsd,
        minutesLeft: timeLeftMin
      });
      const fairModelUp = computeFairValue({
        probTa: timeAware.adjustedUp,
        probOracle: oracleProbUp,
        weightTa: 0.45
      });
      const fairModelDown = 1 - fairModelUp;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      if (poly.ok && poly.market && priceToBeat === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotLine = `${binanceSpotBaseLine}${diffLine}`;
      const binanceSpotValue = binanceSpotLine.split(": ")[1] ?? binanceSpotLine;
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      const timeColor = timeLeftColorBand(timeLeftMin, marketDecisionWindowMinutes);
      const timeLeftLine = `⏱ Time left: ${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? timeLeftColorBand(settlementLeftMin, marketDecisionWindowMinutes)
        : ANSI.reset;

      let strategyStatusLine = null;
      let liveOrderStatusLine = null;
      let outcomeStatusLine = null;
      if (CONFIG.strategy.enabled) {
        const loopNowMs = Date.now();
        const binanceLagMs = Number.isFinite(Number(wsTick?.ts))
          ? Math.max(0, loopNowMs - Number(wsTick.ts))
          : null;
        const oracleUpdatedAtMs = Number.isFinite(Number(chainlink?.updatedAt))
          ? Number(chainlink.updatedAt)
          : null;
        const oracleLagMs = oracleUpdatedAtMs != null
          ? Math.max(0, loopNowMs - oracleUpdatedAtMs)
          : null;

        for (const snapshotGroup of marketSnapshots) {
          const groupPoly = snapshotGroup.poly;
          const snapshotAgeMs = Number.isFinite(Number(groupPoly?.fetchedAtMs))
            ? Math.max(0, loopNowMs - Number(groupPoly.fetchedAtMs))
            : null;
          const groupSettlementMs = groupPoly.ok && groupPoly.market?.endDate
            ? new Date(groupPoly.market.endDate).getTime()
            : null;
          const groupSettlementLeftMin = groupSettlementMs ? (groupSettlementMs - Date.now()) / 60_000 : null;
          const groupMarketSlug = groupPoly.ok ? String(groupPoly.market?.slug ?? "") : "";
          const groupMarketStartMs = groupPoly.ok && groupPoly.market?.eventStartTime
            ? new Date(groupPoly.market.eventStartTime).getTime()
            : null;
          const groupPriceToBeat = groupPoly.ok
            ? updatePriceToBeatState({
              marketSlug: groupMarketSlug,
              marketStartMs: groupMarketStartMs,
              currentPrice
            })
            : null;
          const groupPtbDelta =
            currentPrice !== null &&
            groupPriceToBeat !== null &&
            Number.isFinite(currentPrice) &&
            Number.isFinite(groupPriceToBeat)
              ? currentPrice - groupPriceToBeat
              : null;
          const groupMarketUp = groupPoly.ok ? groupPoly.prices?.up ?? null : null;
          const groupMarketDown = groupPoly.ok ? groupPoly.prices?.down ?? null : null;
          const groupModelOracleUp = estimateOracleProbability({
            ptbDelta: groupPtbDelta,
            volAtr: volAtrUsd,
            minutesLeft: groupSettlementLeftMin ?? timeLeftMin
          });
          const groupModelUp = computeFairValue({
            probTa: fairModelUp,
            probOracle: groupModelOracleUp,
            weightTa: 0.5
          });
          const groupModelDown = 1 - groupModelUp;

          const st = await runPaperStrategyTick({
            poly: groupPoly,
            settlementLeftMin: groupSettlementLeftMin,
            dataHealth: {
              oracleLagMs,
              binanceLagMs,
              snapshotAgeMs,
              oracleSource: chainlink?.source ?? null
            },
            ptbDelta: groupPtbDelta,
            modelUp: groupModelUp,
            modelDown: groupModelDown,
            marketUp: groupMarketUp,
            marketDown: groupMarketDown,
            oraclePrice: currentPrice,
            binanceSpotPrice: spotPrice,
            priceToBeat: groupPriceToBeat,
            volAtrUsd,
            rsiNow,
            macd,
            haNarrative,
            variants: snapshotGroup.variants
          });
          if (st?.line) strategyStatusLine = st.line;
          if (st?.liveOrderLine) liveOrderStatusLine = st.liveOrderLine;
        }

        if (CONFIG.strategy.dryRun) {
          const ot = await runPaperOutcomeTick();
          if (ot?.line) outcomeStatusLine = ot.line;
        }
      }

      const strategyLabel = CONFIG.strategy.dryRun ? "Paper strategy:" : "Strategy:";
      const lines = [
        titleLine,
        marketLine,
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        strategyStatusLine ? `${padLabel(strategyLabel, LABEL_W)}${strategyStatusLine}` : null,
        liveOrderStatusLine ? `${padLabel("Live CLOB:", LABEL_W)}${liveOrderStatusLine}` : null,
        outcomeStatusLine ? `${padLabel("Paper outcome:", LABEL_W)}${outcomeStatusLine}` : null,
        "",
        sepLine(),
        "",
        kv("TA Predict:", predictValue),
        kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
        kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
        kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
        kv("Delta 1/3:", deltaLine.split(": ")[1] ?? deltaLine),
        kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
        "",
        sepLine(),
        "",
        kv("POLYMARKET:", polyHeaderValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine,
        "",
        sepLine(),
        "",
        binanceSpotKvLine,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      renderScreen(lines.join("\n") + "\n");

      // Atualiza o estado do Dashboard para visualização Web
      dashboardState.activeMarket = titleLine;
      dashboardState.timeLeft = fmtTimeLeft(timeLeftMin);
      dashboardState.sniperArmed = strategyStatusLine?.includes("ARMED") || false;
      dashboardState.lastSnapshotAt = new Date().toISOString();

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow("./logs/signals.csv", header, [
        new Date().toISOString(),
        timing.elapsedMinutes.toFixed(3),
        timeLeftMin.toFixed(3),
        regimeInfo.regime,
        signal,
        timeAware.adjustedUp,
        timeAware.adjustedDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE"
      ]);
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
