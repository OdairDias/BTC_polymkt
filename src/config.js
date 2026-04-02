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
    entryMinutesLeft: 4.0,   // Lê a tendência macro ainda 'limpa' aos 4 min
    targetEntryPrice: 0.20,  // Compra a oportunidade de ineficiência de mercado (Black Swan)
    priceEpsilon: 0.06,      // mínimo 6% de vantagem entre lados antes de agir
    notionalUsd: 1,          // de volta para 1 USD (via estratégia Tape Reading/FOK)
    outcomeLastSeconds: 5
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
