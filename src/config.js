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
    maxSpreadToEdgeRatio: 0
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
    grossProfitTargetUsd: Number.isFinite(grossProfitTargetUsd) && grossProfitTargetUsd > 0 ? Math.max(0.01, grossProfitTargetUsd) : null,
    forceExitMinutesLeft: Number.isFinite(forceExitMinutesLeft) && forceExitMinutesLeft > 0 ? forceExitMinutesLeft : null,
    minEdge: Number.isFinite(minEdge) && minEdge > 0 ? Math.min(0.99, minEdge) : null,
    minModelProb: Number.isFinite(minModelProb) && minModelProb > 0 ? Math.min(0.99, minModelProb) : null,
    minBookImbalance: Number.isFinite(minBookImbalance) && minBookImbalance > 0 ? Math.max(0.01, minBookImbalance) : null,
    maxSpreadToEdgeRatio:
      Number.isFinite(maxSpreadToEdgeRatio) && maxSpreadToEdgeRatio > 0
        ? Math.max(0.01, maxSpreadToEdgeRatio)
        : null,
    entryCloseMinutesLeft: Number.isFinite(Number(c.entryCloseMinutesLeft)) ? Number(c.entryCloseMinutesLeft) : base.entryCloseMinutesLeft,
    liveEntryOrderType: sanitizeMarketOrderType(c.liveEntryOrderType ?? base.liveEntryOrderType),
    liveExitOrderType: sanitizeMarketOrderType(c.liveExitOrderType ?? base.liveExitOrderType),
    marketSlug: String(c.marketSlug ?? base.marketSlug ?? "").trim(),
    marketSlugPrefix: String(c.marketSlugPrefix ?? base.marketSlugPrefix ?? "").trim().toLowerCase(),
    marketWindowMinutes: Number.isFinite(marketWindowMinutes) && marketWindowMinutes > 0 ? marketWindowMinutes : null,
    marketSeriesId: String(c.marketSeriesId ?? base.marketSeriesId ?? "").trim(),
    marketSeriesSlug: String(c.marketSeriesSlug ?? base.marketSeriesSlug ?? "").trim().toLowerCase()
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
    )
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
  grossProfitTargetUsd: CONFIG.strategy.grossProfitTargetUsd,
  forceExitMinutesLeft: CONFIG.strategy.forceExitMinutesLeft,
  minEdge: CONFIG.strategy.minEdge,
  minModelProb: CONFIG.strategy.minModelProb,
  minBookImbalance: CONFIG.strategy.minBookImbalance,
  maxSpreadToEdgeRatio: CONFIG.strategy.maxSpreadToEdgeRatio,
  entryCloseMinutesLeft: null,
  liveEntryOrderType: "FOK",
  liveExitOrderType: "FOK",
  marketSlug: "",
  marketSlugPrefix: "",
  marketWindowMinutes: null,
  marketSeriesId: "",
  marketSeriesSlug: ""
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
