import { STRATEGY_VARIANTS } from "./strategy/variants.js";

/**
 * Valores padrão da aplicação (BTC 5m + estratégia paper).
 * Railway / `.env` podem sobrescrever qualquer chave via process.env.
 *
 * Nunca coloque DATABASE_URL ou segredos neste arquivo — use variáveis no Railway.
 */

const DEFAULTS = {
  candleWindowMinutes: 5,

  polymarket: {
    marketSlug: "",
    seriesId: "10684",
    seriesSlug: "btc-up-or-down-5m",
    autoSelectLatest: true,
    liveDataWsUrl: "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: "Up",
    downOutcomeLabel: "Down"
  },

  chainlink: {
    polygonRpcUrls: "",
    polygonRpcUrl: "https://polygon-rpc.com",
    polygonWssUrls: "",
    polygonWssUrl: "",
    btcUsdAggregator: "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  },

  strategy: {
    enabled: true,
    dryRun: true,
    liveArmed: false,
    databaseUrl: "",
    entryMinutesLeft: 0.75,  // 'Sniper 2.0': Analisa aos 45s finais (pico de certeza direcional)
    targetEntryPrice: 0.20,  // Captura pânico real para retorno assimétrico de 500%
    priceEpsilon: 0.08,      // exigência de 8% de vantagem (mais seletivo)
    notionalUsd: 1,          // de volta para 1 USD (via estratégia Tape Reading/FOK)
    outcomeLastSeconds: 5,
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 6,
    rollingLossHours: 24,
    maxRollingLossUsd: 12,
    minPayoutMultiple: 2.5,
    maxEntryPrice: 0.30,
    minEntryPrice: 0.01,
    takeProfitEnabled: false,
    takeProfitPrice: 0.80,
    grossProfitTargetUsd: 0,
    forceExitMinutesLeft: 0,
    minEdge: 0,
    minModelProb: 0,
    minBookImbalance: 0,
    maxSpreadToEdgeRatio: 0,
    paperFillMode: "pessimistic",
    paperEntrySlippageBps: 20,
    paperExitSlippageBps: 25,
    paperSpreadPenaltyFactor: 0.25,
    maxOracleLagMs: 0,
    maxBinanceLagMs: 0,
    maxSnapshotAgeMs: 0,
    sniperDeltaFloorUsd: 5,
    sniperDeltaAtrMult: 0,
    sizingMode: "fixed",
    kellyFraction: 0.25,
    kellyMinNotionalUsd: 0.25,
    kellyMaxNotionalUsd: 1.0,
    maxDailyLossUsd: 0,
    riskDayTimezone: "America/Sao_Paulo"
  },

  /** Execução CLOB (conta real). Chaves só via env — nunca no código. */
  live: {
    privateKey: "",
    chainId: 137,
    signatureType: 0,
    funderAddress: ""
  },

  /** Builder/Relayer (opcional): cabeçalhos extra no POST /order do CLOB via @polymarket/builder-signing-sdk. */
  relayer: {
    apiKeyAddress: "",
    apiKeyBlob: "",
    apiSecret: "",
    apiPassphrase: ""
  }
};

function envString(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envBool(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return String(v).toLowerCase() === "true";
}

function envBoolNeg(key, fallbackTrue) {
  const v = process.env[key];
  if (v === undefined || v === "") return fallbackTrue;
  return String(v).toLowerCase() !== "false";
}

function envJsonArray(key, fallback = []) {
  const raw = process.env[key];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeStrategyVariantKey(value, fallback = "default") {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return s.replace(/[^a-z0-9_-]/g, "").slice(0, 40) || fallback;
}

function sanitizeMarketOrderType(value, fallback = "FOK") {
  const s = String(value ?? "").trim().toUpperCase();
  return s === "FAK" || s === "FOK" ? s : fallback;
}

function sanitizePaperFillMode(value, fallback = "pessimistic") {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "optimistic" || s === "pessimistic" ? s : fallback;
}

function sanitizeSizingMode(value, fallback = "fixed") {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "fixed" || s === "kelly" ? s : fallback;
}

function sanitizeTakeProfitLevels(levels, fallback = [], fallbackPrice = null) {
  const source = Array.isArray(levels) ? levels : Array.isArray(fallback) ? fallback : [];
  const cleaned = source
    .map((level) => {
      const price = Number(level?.price);
      const fraction = Number(level?.fraction);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
      if (!Number.isFinite(fraction) || fraction <= 0) return null;
      return {
        price: Math.min(0.99, Math.max(0.01, price)),
        fraction: Math.max(0.0001, fraction)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.price - b.price);

  if (!cleaned.length) {
    const price = Number(fallbackPrice);
    return Number.isFinite(price) && price > 0 && price < 1
      ? [{ price: Math.min(0.99, Math.max(0.01, price)), fraction: 1 }]
      : [];
  }

  const totalFraction = cleaned.reduce((sum, level) => sum + level.fraction, 0);
  if (!Number.isFinite(totalFraction) || totalFraction <= 0) return [];
  return cleaned.map((level, index) => ({
    price: level.price,
    fraction:
      index === cleaned.length - 1
        ? Math.max(0.0001, 1 - cleaned.slice(0, -1).reduce((sum, item) => sum + (item.fraction / totalFraction), 0))
        : level.fraction / totalFraction
  }));
}

function sanitizeEntryPriceTiers(tiers, fallback = []) {
  const source = Array.isArray(tiers) ? tiers : Array.isArray(fallback) ? fallback : [];
  return source
    .map((tier) => {
      const minutesLeftMin = Number(tier?.minutesLeftMin);
      const minutesLeftMax = Number(tier?.minutesLeftMax);
      const maxPrice = Number(tier?.maxPrice);
      const minEdge = Number(tier?.minEdge);
      const minModelProb = Number(tier?.minModelProb);
      const minBookImbalance = Number(tier?.minBookImbalance);
      return {
        minutesLeftMin: Number.isFinite(minutesLeftMin) ? minutesLeftMin : null,
        minutesLeftMax: Number.isFinite(minutesLeftMax) ? minutesLeftMax : null,
        maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? Math.min(0.99, Math.max(0.01, maxPrice)) : null,
        minEdge: Number.isFinite(minEdge) && minEdge > 0 ? Math.min(0.99, minEdge) : null,
        minModelProb: Number.isFinite(minModelProb) && minModelProb > 0 ? Math.min(0.99, minModelProb) : null,
        minBookImbalance:
          Number.isFinite(minBookImbalance) && minBookImbalance > 0
            ? Math.max(0.01, minBookImbalance)
            : null
      };
    })
    .filter((tier) => tier.maxPrice != null || tier.minEdge != null || tier.minModelProb != null || tier.minBookImbalance != null)
    .sort((a, b) => {
      const aMax = Number.isFinite(Number(a.minutesLeftMax)) ? Number(a.minutesLeftMax) : Number.POSITIVE_INFINITY;
      const bMax = Number.isFinite(Number(b.minutesLeftMax)) ? Number(b.minutesLeftMax) : Number.POSITIVE_INFINITY;
      return bMax - aMax;
    });
}

function mergeStrategyVariant(base, candidate) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const takeProfitPrice = Number(c.takeProfitPrice ?? base.takeProfitPrice);
  const grossProfitTargetUsd = Number(c.grossProfitTargetUsd ?? base.grossProfitTargetUsd);
  const forceExitMinutesLeft = Number(c.forceExitMinutesLeft ?? base.forceExitMinutesLeft);
  const minEntryPrice = Number(c.minEntryPrice ?? base.minEntryPrice);
  const marketWindowMinutes = Number(c.marketWindowMinutes ?? base.marketWindowMinutes);
  const minEdge = Number(c.minEdge ?? base.minEdge);
  const minModelProb = Number(c.minModelProb ?? base.minModelProb);
  const minBookImbalance = Number(c.minBookImbalance ?? base.minBookImbalance);
  const maxSpreadToEdgeRatio = Number(c.maxSpreadToEdgeRatio ?? base.maxSpreadToEdgeRatio);
  const paperEntrySlippageBps = Number(c.paperEntrySlippageBps ?? base.paperEntrySlippageBps);
  const paperExitSlippageBps = Number(c.paperExitSlippageBps ?? base.paperExitSlippageBps);
  const paperSpreadPenaltyFactor = Number(c.paperSpreadPenaltyFactor ?? base.paperSpreadPenaltyFactor);
  const maxOracleLagMs = Number(c.maxOracleLagMs ?? base.maxOracleLagMs);
  const maxBinanceLagMs = Number(c.maxBinanceLagMs ?? base.maxBinanceLagMs);
  const maxSnapshotAgeMs = Number(c.maxSnapshotAgeMs ?? base.maxSnapshotAgeMs);
  const sniperDeltaFloorUsd = Number(c.sniperDeltaFloorUsd ?? base.sniperDeltaFloorUsd);
  const sniperDeltaAtrMult = Number(c.sniperDeltaAtrMult ?? base.sniperDeltaAtrMult);
  const kellyFraction = Number(c.kellyFraction ?? base.kellyFraction);
  const kellyMinNotionalUsd = Number(c.kellyMinNotionalUsd ?? base.kellyMinNotionalUsd);
  const kellyMaxNotionalUsd = Number(c.kellyMaxNotionalUsd ?? base.kellyMaxNotionalUsd);
  const maxDailyLossUsd = Number(c.maxDailyLossUsd ?? base.maxDailyLossUsd);
  const maxSumMids = Number(c.maxSumMids ?? base.maxSumMids);
  const minSumMids = Number(c.minSumMids ?? base.minSumMids);
  const binaryDiscountBonus = Number(c.binaryDiscountBonus ?? base.binaryDiscountBonus);
  const regimeTrendEdgeMultiplier = Number(c.regimeTrendEdgeMultiplier ?? base.regimeTrendEdgeMultiplier);
  const oracleLagBonusMinMs = Number(c.oracleLagBonusMinMs ?? base.oracleLagBonusMinMs);
  const oracleLagBonusMinDelta = Number(c.oracleLagBonusMinDelta ?? base.oracleLagBonusMinDelta);
  const oracleLagBonusEdge = Number(c.oracleLagBonusEdge ?? base.oracleLagBonusEdge);
  const crossMarketWindowMinutes = Number(c.crossMarketWindowMinutes ?? base.crossMarketWindowMinutes);
  const crossMarketMaxDivergence = Number(c.crossMarketMaxDivergence ?? base.crossMarketMaxDivergence);
  const crossMarketEdgeBonus = Number(c.crossMarketEdgeBonus ?? base.crossMarketEdgeBonus);
  const takeProfitLevels = sanitizeTakeProfitLevels(
    c.takeProfitLevels,
    base.takeProfitLevels,
    Number.isFinite(takeProfitPrice) ? takeProfitPrice : base.takeProfitPrice
  );
  const entryPriceTiers = sanitizeEntryPriceTiers(c.entryPriceTiers, base.entryPriceTiers);
  return {
    key: sanitizeStrategyVariantKey(c.key, "default"),
    label: String(c.label ?? c.key ?? "default"),
    enabled: c.enabled === undefined ? true : Boolean(c.enabled),
    decisionMode: String(c.decisionMode ?? base.decisionMode ?? "sniper_v2"),
    contrarian: c.contrarian === undefined ? false : Boolean(c.contrarian),
    entryMinutesLeft: Math.max(0.05, Number(c.entryMinutesLeft ?? base.entryMinutesLeft)),
    targetEntryPrice: Math.max(0.01, Number(c.targetEntryPrice ?? base.targetEntryPrice)),
    priceEpsilon: Math.max(0, Number(c.priceEpsilon ?? base.priceEpsilon)),
    notionalUsd: Math.max(0.01, Number(c.notionalUsd ?? base.notionalUsd)),
    riskGuardsEnabled: c.riskGuardsEnabled === undefined ? base.riskGuardsEnabled : Boolean(c.riskGuardsEnabled),
    maxConsecutiveLosses: Math.max(1, Math.floor(Number(c.maxConsecutiveLosses ?? base.maxConsecutiveLosses))),
    rollingLossHours: Math.max(1, Math.floor(Number(c.rollingLossHours ?? base.rollingLossHours))),
    maxRollingLossUsd: Math.max(0.01, Number(c.maxRollingLossUsd ?? base.maxRollingLossUsd)),
    minPayoutMultiple: Math.max(1, Number(c.minPayoutMultiple ?? base.minPayoutMultiple)),
    maxEntryPrice: Math.max(0.01, Number(c.maxEntryPrice ?? base.maxEntryPrice)),
    minEntryPrice: Number.isFinite(minEntryPrice) ? Math.max(0.01, Math.min(0.99, minEntryPrice)) : null,
    takeProfitEnabled: c.takeProfitEnabled === undefined ? Boolean(base.takeProfitEnabled) : Boolean(c.takeProfitEnabled),
    takeProfitPrice: Number.isFinite(takeProfitPrice) ? Math.max(0.01, Math.min(0.99, takeProfitPrice)) : base.takeProfitPrice,
    takeProfitLevels,
    trailingStopEnabled:
      c.trailingStopEnabled === undefined ? Boolean(base.trailingStopEnabled) : Boolean(c.trailingStopEnabled),
    trailingStopActivationPrice:
      Number.isFinite(Number(c.trailingStopActivationPrice ?? base.trailingStopActivationPrice))
        ? Math.max(0.01, Math.min(0.99, Number(c.trailingStopActivationPrice ?? base.trailingStopActivationPrice)))
        : null,
    trailingStopDropCents:
      Number.isFinite(Number(c.trailingStopDropCents ?? base.trailingStopDropCents))
        ? Math.max(0.001, Math.min(0.99, Number(c.trailingStopDropCents ?? base.trailingStopDropCents)))
        : null,
    grossProfitTargetUsd: Number.isFinite(grossProfitTargetUsd) && grossProfitTargetUsd > 0 ? Math.max(0.01, grossProfitTargetUsd) : null,
    forceExitMinutesLeft: Number.isFinite(forceExitMinutesLeft) && forceExitMinutesLeft > 0 ? forceExitMinutesLeft : null,
    minEdge: Number.isFinite(minEdge) && minEdge > 0 ? Math.min(0.99, minEdge) : null,
    minModelProb: Number.isFinite(minModelProb) && minModelProb > 0 ? Math.min(0.99, minModelProb) : null,
    minBookImbalance: Number.isFinite(minBookImbalance) && minBookImbalance > 0 ? Math.max(0.01, minBookImbalance) : null,
    maxSpreadToEdgeRatio:
      Number.isFinite(maxSpreadToEdgeRatio) && maxSpreadToEdgeRatio > 0
        ? Math.max(0.01, maxSpreadToEdgeRatio)
        : null,
    paperFillMode: sanitizePaperFillMode(c.paperFillMode ?? base.paperFillMode, "pessimistic"),
    paperEntrySlippageBps:
      Number.isFinite(paperEntrySlippageBps) && paperEntrySlippageBps >= 0
        ? Math.max(0, paperEntrySlippageBps)
        : 0,
    paperExitSlippageBps:
      Number.isFinite(paperExitSlippageBps) && paperExitSlippageBps >= 0
        ? Math.max(0, paperExitSlippageBps)
        : 0,
    paperSpreadPenaltyFactor:
      Number.isFinite(paperSpreadPenaltyFactor) && paperSpreadPenaltyFactor >= 0
        ? Math.max(0, paperSpreadPenaltyFactor)
        : 0,
    maxOracleLagMs:
      Number.isFinite(maxOracleLagMs) && maxOracleLagMs > 0
        ? Math.max(1, Math.floor(maxOracleLagMs))
        : null,
    maxBinanceLagMs:
      Number.isFinite(maxBinanceLagMs) && maxBinanceLagMs > 0
        ? Math.max(1, Math.floor(maxBinanceLagMs))
        : null,
    maxSnapshotAgeMs:
      Number.isFinite(maxSnapshotAgeMs) && maxSnapshotAgeMs > 0
        ? Math.max(1, Math.floor(maxSnapshotAgeMs))
        : null,
    sniperDeltaFloorUsd:
      Number.isFinite(sniperDeltaFloorUsd) && sniperDeltaFloorUsd > 0
        ? Math.max(0.1, sniperDeltaFloorUsd)
        : 5,
    sniperDeltaAtrMult:
      Number.isFinite(sniperDeltaAtrMult) && sniperDeltaAtrMult >= 0
        ? Math.max(0, sniperDeltaAtrMult)
        : 0,
    sizingMode: sanitizeSizingMode(c.sizingMode ?? base.sizingMode, "fixed"),
    kellyFraction:
      Number.isFinite(kellyFraction) && kellyFraction >= 0
        ? Math.min(1, kellyFraction)
        : 0.25,
    kellyMinNotionalUsd:
      Number.isFinite(kellyMinNotionalUsd) && kellyMinNotionalUsd > 0
        ? Math.max(0.01, kellyMinNotionalUsd)
        : 0.25,
    kellyMaxNotionalUsd:
      Number.isFinite(kellyMaxNotionalUsd) && kellyMaxNotionalUsd > 0
        ? Math.max(0.01, kellyMaxNotionalUsd)
        : Math.max(0.01, Number(c.notionalUsd ?? base.notionalUsd)),
    maxDailyLossUsd:
      Number.isFinite(maxDailyLossUsd) && maxDailyLossUsd > 0
        ? Math.max(0.01, maxDailyLossUsd)
        : 0,
    riskDayTimezone: String(c.riskDayTimezone ?? base.riskDayTimezone ?? "America/Sao_Paulo").trim() || "America/Sao_Paulo",
    maxSumMids:
      Number.isFinite(maxSumMids) && maxSumMids > 0
        ? Math.max(0.01, maxSumMids)
        : null,
    minSumMids:
      Number.isFinite(minSumMids) && minSumMids > 0
        ? Math.max(0.01, minSumMids)
        : null,
    binaryDiscountBonus:
      Number.isFinite(binaryDiscountBonus) && binaryDiscountBonus >= 0
        ? Math.max(0, binaryDiscountBonus)
        : 0,
    regimeGateEnabled:
      c.regimeGateEnabled === undefined ? Boolean(base.regimeGateEnabled) : Boolean(c.regimeGateEnabled),
    regimeTrendEdgeMultiplier:
      Number.isFinite(regimeTrendEdgeMultiplier) && regimeTrendEdgeMultiplier > 1
        ? regimeTrendEdgeMultiplier
        : 1,
    oracleLagBonusEnabled:
      c.oracleLagBonusEnabled === undefined ? Boolean(base.oracleLagBonusEnabled) : Boolean(c.oracleLagBonusEnabled),
    oracleLagBonusMinMs:
      Number.isFinite(oracleLagBonusMinMs) && oracleLagBonusMinMs > 0
        ? Math.max(1, Math.floor(oracleLagBonusMinMs))
        : null,
    oracleLagBonusMinDelta:
      Number.isFinite(oracleLagBonusMinDelta) && oracleLagBonusMinDelta > 0
        ? Math.max(0.1, oracleLagBonusMinDelta)
        : null,
    oracleLagBonusEdge:
      Number.isFinite(oracleLagBonusEdge) && oracleLagBonusEdge > 0
        ? Math.min(0.99, oracleLagBonusEdge)
        : 0,
    entryPriceTiers,
    entryCloseMinutesLeft: Number.isFinite(Number(c.entryCloseMinutesLeft)) ? Number(c.entryCloseMinutesLeft) : base.entryCloseMinutesLeft,
    liveEntryOrderType: sanitizeMarketOrderType(c.liveEntryOrderType ?? base.liveEntryOrderType),
    liveExitOrderType: sanitizeMarketOrderType(c.liveExitOrderType ?? base.liveExitOrderType),
    marketSlug: String(c.marketSlug ?? base.marketSlug ?? "").trim(),
    marketSlugPrefix: String(c.marketSlugPrefix ?? base.marketSlugPrefix ?? "").trim().toLowerCase(),
    marketWindowMinutes: Number.isFinite(marketWindowMinutes) && marketWindowMinutes > 0 ? marketWindowMinutes : null,
    marketSeriesId: String(c.marketSeriesId ?? base.marketSeriesId ?? "").trim(),
    marketSeriesSlug: String(c.marketSeriesSlug ?? base.marketSeriesSlug ?? "").trim().toLowerCase(),
    crossMarketWindowMinutes:
      Number.isFinite(crossMarketWindowMinutes) && crossMarketWindowMinutes > 0
        ? crossMarketWindowMinutes
        : null,
    crossMarketSeriesId: String(c.crossMarketSeriesId ?? base.crossMarketSeriesId ?? "").trim(),
    crossMarketSeriesSlug: String(c.crossMarketSeriesSlug ?? base.crossMarketSeriesSlug ?? "").trim().toLowerCase(),
    crossMarketMaxDivergence:
      Number.isFinite(crossMarketMaxDivergence) && crossMarketMaxDivergence > 0
        ? Math.min(1, crossMarketMaxDivergence)
        : null,
    crossMarketEdgeBonus:
      Number.isFinite(crossMarketEdgeBonus) && crossMarketEdgeBonus >= 0
        ? Math.max(0, crossMarketEdgeBonus)
        : 0,
    crossMarketRequired:
      c.crossMarketRequired === undefined ? Boolean(base.crossMarketRequired) : Boolean(c.crossMarketRequired)
  };
}

const candleWindowFromEnv = Number(process.env.CANDLE_WINDOW_MINUTES);
const candleWindowMinutes = Number.isFinite(candleWindowFromEnv) && candleWindowFromEnv > 0
  ? candleWindowFromEnv
  : DEFAULTS.candleWindowMinutes;

export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  candleWindowMinutes,

  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  polymarket: {
    marketSlug: envString("POLYMARKET_SLUG", DEFAULTS.polymarket.marketSlug),
    seriesId: envString("POLYMARKET_SERIES_ID", DEFAULTS.polymarket.seriesId),
    seriesSlug: envString("POLYMARKET_SERIES_SLUG", DEFAULTS.polymarket.seriesSlug),
    autoSelectLatest: envBool("POLYMARKET_AUTO_SELECT_LATEST", DEFAULTS.polymarket.autoSelectLatest),
    liveDataWsUrl: envString("POLYMARKET_LIVE_WS_URL", DEFAULTS.polymarket.liveDataWsUrl),
    upOutcomeLabel: envString("POLYMARKET_UP_LABEL", DEFAULTS.polymarket.upOutcomeLabel),
    downOutcomeLabel: envString("POLYMARKET_DOWN_LABEL", DEFAULTS.polymarket.downOutcomeLabel)
  },

  chainlink: {
    polygonRpcUrls: (envString("POLYGON_RPC_URLS", DEFAULTS.chainlink.polygonRpcUrls) || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    polygonRpcUrl: envString("POLYGON_RPC_URL", DEFAULTS.chainlink.polygonRpcUrl),
    polygonWssUrls: (envString("POLYGON_WSS_URLS", DEFAULTS.chainlink.polygonWssUrls) || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    polygonWssUrl: envString("POLYGON_WSS_URL", DEFAULTS.chainlink.polygonWssUrl),
    btcUsdAggregator: envString("CHAINLINK_BTC_USD_AGGREGATOR", DEFAULTS.chainlink.btcUsdAggregator)
  },

  strategy: {
    enabled: envBool("STRATEGY_ENABLED", DEFAULTS.strategy.enabled),
    dryRun: envBoolNeg("STRATEGY_DRY_RUN", DEFAULTS.strategy.dryRun),
    liveArmed: envBool("STRATEGY_LIVE_ARMED", DEFAULTS.strategy.liveArmed),
    databaseUrl: process.env.DATABASE_URL || "",
    entryMinutesLeft: Math.max(
      0.05,
      Number(process.env.STRATEGY_ENTRY_MINUTES_LEFT) || DEFAULTS.strategy.entryMinutesLeft
    ),
    targetEntryPrice: Math.max(0.01, Number(process.env.STRATEGY_TARGET_PRICE) || DEFAULTS.strategy.targetEntryPrice),
    priceEpsilon: Math.max(0, Number(process.env.STRATEGY_PRICE_EPSILON) || DEFAULTS.strategy.priceEpsilon),
    notionalUsd: Math.max(0.01, Number(process.env.STRATEGY_NOTIONAL_USD) || DEFAULTS.strategy.notionalUsd),
    outcomeLastSeconds: Math.max(
      1,
      Number(process.env.STRATEGY_OUTCOME_LAST_SECONDS) || DEFAULTS.strategy.outcomeLastSeconds
    ),
    riskGuardsEnabled: envBool("STRATEGY_RISK_GUARDS_ENABLED", DEFAULTS.strategy.riskGuardsEnabled),
    maxConsecutiveLosses: Math.max(
      1,
      Math.floor(Number(process.env.STRATEGY_MAX_CONSECUTIVE_LOSSES) || DEFAULTS.strategy.maxConsecutiveLosses)
    ),
    rollingLossHours: Math.max(
      1,
      Math.floor(Number(process.env.STRATEGY_ROLLING_LOSS_HOURS) || DEFAULTS.strategy.rollingLossHours)
    ),
    maxRollingLossUsd: Math.max(
      0.01,
      Number(process.env.STRATEGY_MAX_ROLLING_LOSS_USD) || DEFAULTS.strategy.maxRollingLossUsd
    ),
    minPayoutMultiple: Math.max(
      1,
      Number(process.env.STRATEGY_MIN_PAYOUT_MULTIPLE) || DEFAULTS.strategy.minPayoutMultiple
    ),
    maxEntryPrice: Math.max(
      0.01,
      Number(process.env.STRATEGY_MAX_ENTRY_PRICE) || DEFAULTS.strategy.maxEntryPrice
    ),
    minEntryPrice: Math.max(
      0.01,
      Number(process.env.STRATEGY_MIN_ENTRY_PRICE) || DEFAULTS.strategy.minEntryPrice
    ),
    takeProfitEnabled: envBool("STRATEGY_TAKE_PROFIT_ENABLED", DEFAULTS.strategy.takeProfitEnabled),
    takeProfitPrice: Math.max(
      0.01,
      Math.min(0.99, Number(process.env.STRATEGY_TAKE_PROFIT_PRICE) || DEFAULTS.strategy.takeProfitPrice)
    ),
    grossProfitTargetUsd: Math.max(
      0,
      Number(process.env.STRATEGY_GROSS_PROFIT_TARGET_USD) || DEFAULTS.strategy.grossProfitTargetUsd
    ),
    forceExitMinutesLeft: Math.max(
      0,
      Number(process.env.STRATEGY_FORCE_EXIT_MINUTES_LEFT) || DEFAULTS.strategy.forceExitMinutesLeft
    ),
    minEdge: Math.max(
      0,
      Number(process.env.STRATEGY_MIN_EDGE) || DEFAULTS.strategy.minEdge
    ),
    minModelProb: Math.max(
      0,
      Number(process.env.STRATEGY_MIN_MODEL_PROB) || DEFAULTS.strategy.minModelProb
    ),
    minBookImbalance: Math.max(
      0,
      Number(process.env.STRATEGY_MIN_BOOK_IMBALANCE) || DEFAULTS.strategy.minBookImbalance
    ),
    maxSpreadToEdgeRatio: Math.max(
      0,
      Number(process.env.STRATEGY_MAX_SPREAD_TO_EDGE_RATIO) || DEFAULTS.strategy.maxSpreadToEdgeRatio
    ),
    paperFillMode: sanitizePaperFillMode(
      process.env.STRATEGY_PAPER_FILL_MODE,
      DEFAULTS.strategy.paperFillMode
    ),
    paperEntrySlippageBps: Math.max(
      0,
      Number(process.env.STRATEGY_PAPER_ENTRY_SLIPPAGE_BPS) || DEFAULTS.strategy.paperEntrySlippageBps
    ),
    paperExitSlippageBps: Math.max(
      0,
      Number(process.env.STRATEGY_PAPER_EXIT_SLIPPAGE_BPS) || DEFAULTS.strategy.paperExitSlippageBps
    ),
    paperSpreadPenaltyFactor: Math.max(
      0,
      Number(process.env.STRATEGY_PAPER_SPREAD_PENALTY_FACTOR) || DEFAULTS.strategy.paperSpreadPenaltyFactor
    ),
    maxOracleLagMs: Math.max(
      0,
      Math.floor(Number(process.env.STRATEGY_MAX_ORACLE_LAG_MS) || DEFAULTS.strategy.maxOracleLagMs)
    ),
    maxBinanceLagMs: Math.max(
      0,
      Math.floor(Number(process.env.STRATEGY_MAX_BINANCE_LAG_MS) || DEFAULTS.strategy.maxBinanceLagMs)
    ),
    maxSnapshotAgeMs: Math.max(
      0,
      Math.floor(Number(process.env.STRATEGY_MAX_SNAPSHOT_AGE_MS) || DEFAULTS.strategy.maxSnapshotAgeMs)
    ),
    sniperDeltaFloorUsd: Math.max(
      0.1,
      Number(process.env.STRATEGY_SNIPER_DELTA_FLOOR_USD) || DEFAULTS.strategy.sniperDeltaFloorUsd
    ),
    sniperDeltaAtrMult: Math.max(
      0,
      Number(process.env.STRATEGY_SNIPER_DELTA_ATR_MULT) || DEFAULTS.strategy.sniperDeltaAtrMult
    ),
    sizingMode: sanitizeSizingMode(
      process.env.STRATEGY_SIZING_MODE,
      DEFAULTS.strategy.sizingMode
    ),
    kellyFraction: Math.min(
      1,
      Math.max(
        0,
        Number(process.env.STRATEGY_KELLY_FRACTION) || DEFAULTS.strategy.kellyFraction
      )
    ),
    kellyMinNotionalUsd: Math.max(
      0.01,
      Number(process.env.STRATEGY_KELLY_MIN_NOTIONAL_USD) || DEFAULTS.strategy.kellyMinNotionalUsd
    ),
    kellyMaxNotionalUsd: Math.max(
      0.01,
      Number(process.env.STRATEGY_KELLY_MAX_NOTIONAL_USD) || DEFAULTS.strategy.kellyMaxNotionalUsd
    ),
    maxDailyLossUsd: Math.max(
      0,
      Number(process.env.STRATEGY_MAX_DAILY_LOSS_USD) || DEFAULTS.strategy.maxDailyLossUsd
    ),
    riskDayTimezone:
      String(process.env.STRATEGY_RISK_DAY_TIMEZONE || DEFAULTS.strategy.riskDayTimezone).trim() ||
      DEFAULTS.strategy.riskDayTimezone
  },

  live: {
    privateKey: envString("POLYMARKET_PRIVATE_KEY", DEFAULTS.live.privateKey),
    chainId: Number.isFinite(Number(process.env.POLYMARKET_CHAIN_ID))
      ? Number(process.env.POLYMARKET_CHAIN_ID)
      : DEFAULTS.live.chainId,
    signatureType: Number.isFinite(Number(process.env.POLYMARKET_SIGNATURE_TYPE))
      ? Number(process.env.POLYMARKET_SIGNATURE_TYPE)
      : DEFAULTS.live.signatureType,
    funderAddress: envString("POLYMARKET_FUNDER_ADDRESS", DEFAULTS.live.funderAddress)
  },

  relayer: {
    apiKeyAddress: envString("RELAYER_API_KEY_ADDRESS", DEFAULTS.relayer.apiKeyAddress),
    apiKeyBlob: envString("RELAYER_API_KEY", DEFAULTS.relayer.apiKeyBlob),
    apiSecret: envString("RELAYER_API_SECRET", DEFAULTS.relayer.apiSecret),
    apiPassphrase: envString("RELAYER_API_PASSPHRASE", DEFAULTS.relayer.apiPassphrase)
  }
};

// Variantes carregadas do arquivo de código (versionado no Git).
// Para alterar parâmetros, edite src/strategy/variants.js — sem risco de JSON mal-formatado no Railway.
const baseVariant = {
  key: "default",
  label: "default",
  enabled: true,
  decisionMode: "sniper_v2",
  entryMinutesLeft: CONFIG.strategy.entryMinutesLeft,
  targetEntryPrice: CONFIG.strategy.targetEntryPrice,
  priceEpsilon: CONFIG.strategy.priceEpsilon,
  notionalUsd: CONFIG.strategy.notionalUsd,
  riskGuardsEnabled: CONFIG.strategy.riskGuardsEnabled,
  maxConsecutiveLosses: CONFIG.strategy.maxConsecutiveLosses,
  rollingLossHours: CONFIG.strategy.rollingLossHours,
  maxRollingLossUsd: CONFIG.strategy.maxRollingLossUsd,
  minPayoutMultiple: CONFIG.strategy.minPayoutMultiple,
  maxEntryPrice: CONFIG.strategy.maxEntryPrice,
  minEntryPrice: CONFIG.strategy.minEntryPrice,
  takeProfitEnabled: CONFIG.strategy.takeProfitEnabled,
  takeProfitPrice: CONFIG.strategy.takeProfitPrice,
  takeProfitLevels: [],
  trailingStopEnabled: false,
  trailingStopActivationPrice: null,
  trailingStopDropCents: null,
  grossProfitTargetUsd: CONFIG.strategy.grossProfitTargetUsd,
  forceExitMinutesLeft: CONFIG.strategy.forceExitMinutesLeft,
  minEdge: CONFIG.strategy.minEdge,
  minModelProb: CONFIG.strategy.minModelProb,
  minBookImbalance: CONFIG.strategy.minBookImbalance,
  maxSpreadToEdgeRatio: CONFIG.strategy.maxSpreadToEdgeRatio,
  maxSumMids: null,
  minSumMids: null,
  binaryDiscountBonus: 0,
  regimeGateEnabled: false,
  regimeTrendEdgeMultiplier: 1,
  oracleLagBonusEnabled: false,
  oracleLagBonusMinMs: null,
  oracleLagBonusMinDelta: null,
  oracleLagBonusEdge: 0,
  entryPriceTiers: [],
  paperFillMode: CONFIG.strategy.paperFillMode,
  paperEntrySlippageBps: CONFIG.strategy.paperEntrySlippageBps,
  paperExitSlippageBps: CONFIG.strategy.paperExitSlippageBps,
  paperSpreadPenaltyFactor: CONFIG.strategy.paperSpreadPenaltyFactor,
  maxOracleLagMs: CONFIG.strategy.maxOracleLagMs,
  maxBinanceLagMs: CONFIG.strategy.maxBinanceLagMs,
  maxSnapshotAgeMs: CONFIG.strategy.maxSnapshotAgeMs,
  sniperDeltaFloorUsd: CONFIG.strategy.sniperDeltaFloorUsd,
  sniperDeltaAtrMult: CONFIG.strategy.sniperDeltaAtrMult,
  sizingMode: CONFIG.strategy.sizingMode,
  kellyFraction: CONFIG.strategy.kellyFraction,
  kellyMinNotionalUsd: CONFIG.strategy.kellyMinNotionalUsd,
  kellyMaxNotionalUsd: CONFIG.strategy.kellyMaxNotionalUsd,
  maxDailyLossUsd: CONFIG.strategy.maxDailyLossUsd,
  riskDayTimezone: CONFIG.strategy.riskDayTimezone,
  entryCloseMinutesLeft: null,
  liveEntryOrderType: "FOK",
  liveExitOrderType: "FOK",
  marketSlug: "",
  marketSlugPrefix: "",
  marketWindowMinutes: null,
  marketSeriesId: "",
  marketSeriesSlug: "",
  crossMarketWindowMinutes: null,
  crossMarketSeriesId: "",
  crossMarketSeriesSlug: "",
  crossMarketMaxDivergence: null,
  crossMarketEdgeBonus: 0,
  crossMarketRequired: false
};

// Usa as variantes hardcoded em variants.js como fonte primária.
// Se STRATEGY_VARIANTS_JSON estiver definido no Railway, ele SOBRESCREVE (override pontual).
const variantsFromEnv = envJsonArray("STRATEGY_VARIANTS_JSON", []);
const codeVariants = Array.isArray(STRATEGY_VARIANTS) ? STRATEGY_VARIANTS.filter(v => v.enabled !== false) : [];

const byKey = new Map();
// 1. Carrega as variantes do código primeiro
for (const v of codeVariants) {
  byKey.set(v.key, mergeStrategyVariant(baseVariant, v));
}
// 2. Se houver override no env, ele sobrescreve a variante de mesmo key
for (const v of variantsFromEnv) {
  byKey.set(sanitizeStrategyVariantKey(v.key, "override"), mergeStrategyVariant(baseVariant, v));
}
// 3. Se não tiver nenhuma variante de nenhum lado, usa o default antigo
if (byKey.size === 0) {
  byKey.set("default", baseVariant);
}

CONFIG.strategy.variants = Array.from(byKey.values()).filter(v => v.enabled !== false);
const liveKeyCandidate = sanitizeStrategyVariantKey(envString("STRATEGY_LIVE_STRATEGY_KEY", "sniper_45s"), "sniper_45s");
CONFIG.strategy.liveStrategyKey = byKey.has(liveKeyCandidate)
  ? liveKeyCandidate
  : (CONFIG.strategy.variants[0]?.key ?? "sniper_45s");
