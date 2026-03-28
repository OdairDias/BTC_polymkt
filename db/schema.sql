-- Postgres (Railway / local). A aplicação também cria esta tabela no startup (ensureStrategySchema).
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
