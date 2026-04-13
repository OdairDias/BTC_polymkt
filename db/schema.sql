-- Entrada (trade paper) — uma linha por mercado
CREATE TABLE IF NOT EXISTS strategy_paper_signals (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  strategy_key TEXT NOT NULL DEFAULT 'default',
  market_slug TEXT NOT NULL,
  condition_id TEXT,
  market_end_at TIMESTAMPTZ,
  minutes_left NUMERIC NOT NULL,
  up_mid NUMERIC,
  down_mid NUMERIC,
  up_buy NUMERIC,
  down_buy NUMERIC,
  up_best_bid NUMERIC,
  up_best_ask NUMERIC,
  down_best_bid NUMERIC,
  down_best_ask NUMERIC,
  result_code TEXT NOT NULL,
  chosen_side TEXT,
  notional_usd NUMERIC NOT NULL DEFAULT 1,
  entry_price NUMERIC,
  simulated_shares NUMERIC,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  oracle_price NUMERIC,
  binance_spot_price NUMERIC,
  price_to_beat NUMERIC,
  ptb_delta_usd NUMERIC,
  model_prob_up NUMERIC,
  market_prob_up NUMERIC,
  edge_up NUMERIC,
  vol_atr_usd NUMERIC,
  selected_model_prob NUMERIC,
  selected_market_prob NUMERIC,
  selected_edge NUMERIC,
  book_imbalance NUMERIC,
  selected_spread NUMERIC,
  UNIQUE(strategy_key, market_slug)
);

CREATE INDEX IF NOT EXISTS idx_strategy_paper_signals_created
  ON strategy_paper_signals (created_at DESC);

-- Resultado — uma linha por entrada (janela final ~5s: mids → vencedor + PnL simulado)
CREATE TABLE IF NOT EXISTS strategy_paper_outcomes (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_id BIGINT NOT NULL REFERENCES strategy_paper_signals(id) ON DELETE CASCADE,
  strategy_key TEXT NOT NULL DEFAULT 'default',
  market_slug TEXT NOT NULL,
  seconds_left_at_eval NUMERIC NOT NULL,
  evaluation_method TEXT NOT NULL DEFAULT 'last_5s_mid',
  up_mid NUMERIC,
  down_mid NUMERIC,
  up_best_bid NUMERIC,
  up_best_ask NUMERIC,
  down_best_bid NUMERIC,
  down_best_ask NUMERIC,
  inferred_winner TEXT,
  official_winner TEXT,
  outcome_code TEXT NOT NULL,
  official_resolution_status TEXT,
  official_resolution_source TEXT,
  official_resolved_at TIMESTAMPTZ,
  official_outcome_prices_json JSONB,
  official_price_to_beat NUMERIC,
  official_price_at_close NUMERIC,
  entry_chosen_side TEXT,
  entry_correct BOOLEAN,
  pnl_simulated_usd NUMERIC,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(entry_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_paper_outcomes_slug
  ON strategy_paper_outcomes (market_slug);
CREATE INDEX IF NOT EXISTS idx_strategy_paper_outcomes_created
  ON strategy_paper_outcomes (created_at DESC);

ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_winner TEXT;
ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_resolution_status TEXT;
ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_resolution_source TEXT;
ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_resolved_at TIMESTAMPTZ;
ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_outcome_prices_json JSONB;
ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_price_to_beat NUMERIC;
ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS official_price_at_close NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS strategy_key TEXT NOT NULL DEFAULT 'default';
ALTER TABLE strategy_paper_outcomes ADD COLUMN IF NOT EXISTS strategy_key TEXT NOT NULL DEFAULT 'default';
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS oracle_price NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS binance_spot_price NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS price_to_beat NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS ptb_delta_usd NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS model_prob_up NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS market_prob_up NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS edge_up NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS vol_atr_usd NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS selected_model_prob NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS selected_market_prob NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS selected_edge NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS book_imbalance NUMERIC;
ALTER TABLE strategy_paper_signals ADD COLUMN IF NOT EXISTS selected_spread NUMERIC;
ALTER TABLE strategy_paper_signals DROP CONSTRAINT IF EXISTS strategy_paper_signals_market_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_paper_signals_strategy_slug
  ON strategy_paper_signals(strategy_key, market_slug);

-- Ordem CLOB real (uma por entrada), opcional
CREATE TABLE IF NOT EXISTS strategy_live_orders (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_id BIGINT NOT NULL REFERENCES strategy_paper_signals(id) ON DELETE CASCADE,
  strategy_key TEXT NOT NULL DEFAULT 'default',
  market_slug TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL,
  limit_price NUMERIC,
  size_shares NUMERIC,
  notional_usd NUMERIC,
  clob_order_id TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  raw_response JSONB,
  UNIQUE(entry_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_live_orders_created
  ON strategy_live_orders (created_at DESC);

ALTER TABLE strategy_live_orders ADD COLUMN IF NOT EXISTS strategy_key TEXT NOT NULL DEFAULT 'default';
