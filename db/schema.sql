-- Entrada (trade paper) — uma linha por mercado
CREATE TABLE IF NOT EXISTS strategy_paper_signals (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  market_slug TEXT NOT NULL UNIQUE,
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
  dry_run BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_strategy_paper_signals_created
  ON strategy_paper_signals (created_at DESC);

-- Resultado — uma linha por entrada (janela final ~5s: mids → vencedor + PnL simulado)
CREATE TABLE IF NOT EXISTS strategy_paper_outcomes (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_id BIGINT NOT NULL REFERENCES strategy_paper_signals(id) ON DELETE CASCADE,
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
  outcome_code TEXT NOT NULL,
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
