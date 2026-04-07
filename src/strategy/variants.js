/**
 * Definições fixas das variantes de estratégia.
 * Edite aqui para mudar parâmetros — versionado no Git, sem risco de JSON mal-formatado no Railway.
 *
 * Campos de cada variante:
 *  - key:                Identificador único (usado como PK no banco)
 *  - label:              Nome legível no Dashboard
 *  - enabled:            false = variante ignorada sem deletar o código
 *  - decisionMode:       'sniper_v2' | 'main_2m_mid'
 *  - entryMinutesLeft:   Janela de entrada (em minutos antes do fechamento)
 *  - targetEntryPrice:   Preço-âncora da ordem FOK (só usado em sniper_v2)
 *  - priceEpsilon:       Margem mínima de diferença para não considerar empate
 *  - notionalUsd:        Tamanho da aposta simulada/real em USD
 *  - riskGuardsEnabled:  Ativa travas de drawdown e sequência de perdas
 *  - maxConsecutiveLosses: Trava após N perdas seguidas
 *  - rollingLossHours:   Janela de tempo para calcular perda acumulada
 *  - maxRollingLossUsd:  Perda máxima aceita na janela rolante (USD)
 *  - minPayoutMultiple:  Retorno mínimo aceitável (ex: 2.5 = precisa pagar 2.5x)
 *  - maxEntryPrice:      Preço máximo aceito para entrar (proteção de assimetria)
 */
export const STRATEGY_VARIANTS = [
  {
    key: "sniper_45s",
    label: "Sniper 45s (Principal)",
    enabled: true,
    decisionMode: "sniper_v2",
    entryMinutesLeft: 0.75,        // age nos últimos 45 segundos
    targetEntryPrice: 0.20,        // payout potencial ~5x
    priceEpsilon: 0.08,
    notionalUsd: 1.0,
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 999,      // aumentado: dados antigos estimados nao devem frear o bot
    rollingLossHours: 24,
    maxRollingLossUsd: 9999,         // ampliado para nao travar em dados sujos do passado
    minPayoutMultiple: 2.5,
    maxEntryPrice: 0.30
  },
  {
    key: "safe_90s",
    label: "Safe 90s (Conservadora)",
    enabled: true,
    decisionMode: "sniper_v2",
    entryMinutesLeft: 0.90,        // age nos últimos 54 segundos
    targetEntryPrice: 0.25,        // fill rate mais alto, payout ~4x
    priceEpsilon: 0.08,
    notionalUsd: 0.75,             // mao menor para suavizar drawdown
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 999,
    rollingLossHours: 24,
    maxRollingLossUsd: 9999,
    minPayoutMultiple: 2.0,
    maxEntryPrice: 0.35
  },
  {
    key: "aggr_35s",
    label: "Aggressive 35s (Agressiva)",
    enabled: true,
    decisionMode: "sniper_v2",
    entryMinutesLeft: 0.58,        // age nos últimos 35 segundos
    targetEntryPrice: 0.18,        // payout potencial ~5.5x
    priceEpsilon: 0.06,
    notionalUsd: 1.0,
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 999,
    rollingLossHours: 24,
    maxRollingLossUsd: 9999,
    minPayoutMultiple: 2.5,
    maxEntryPrice: 0.28
  },
  {
    key: "main_2m",
    label: "Main 2m (Baseline A/B)",
    enabled: true,
    decisionMode: "main_2m_mid",
    entryMinutesLeft: 2.0,         // age nos últimos 2 minutos
    targetEntryPrice: 0.50,        // não usada (main_2m usa preço real do livro)
    priceEpsilon: 0.001,           // empate apenas se diferença < 0.1%
    notionalUsd: 1.0,
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 999,
    rollingLossHours: 24,
    maxRollingLossUsd: 9999,
    minPayoutMultiple: 1.0,        // baseline: aceita qualquer payout > 1x
    maxEntryPrice: 0.99            // baseline: nao bloqueia por preco
  },

  // ─── Estratégias Contrárias ───────────────────────────────────────────────
  // Entram na ponta OPOSTA ao que o modelo recomienda.
  // Objetivo: descobrir se o modelo tem viés sistemático (e se sim, apostamos contra).
  // Preço de entrada usa sempre o preço real do livro (não âncora). Guards de
  // assimetria estão liberados pois a ponta cara naturalmente tem payout < 2x.
  {
    key: "sniper_45s_contra",
    label: "Sniper 45s CONTRA (Contrária)",
    enabled: true,
    decisionMode: "sniper_v2",
    contrarian: true,                  // inverte UP↔DOWN após a decisão
    entryMinutesLeft: 0.75,            // mesmo timing que sniper_45s
    targetEntryPrice: 0.20,            // não usado — contrarian usa preço real do livro
    priceEpsilon: 0.08,
    notionalUsd: 1.0,
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 999,
    rollingLossHours: 24,
    maxRollingLossUsd: 9999,
    minPayoutMultiple: 1.0,            // liberado: ponta contrária pode pagar só 1.2x
    maxEntryPrice: 0.99               // liberado: ponta contrária pode custar até 0.99
  },
  {
    key: "safe_90s_contra",
    label: "Safe 90s CONTRA (Contrária)",
    enabled: true,
    decisionMode: "sniper_v2",
    contrarian: true,
    entryMinutesLeft: 0.90,            // mesmo timing que safe_90s
    targetEntryPrice: 0.25,            // não usado — contrarian usa preço real do livro
    priceEpsilon: 0.08,
    notionalUsd: 0.75,
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 999,
    rollingLossHours: 24,
    maxRollingLossUsd: 9999,
    minPayoutMultiple: 1.0,
    maxEntryPrice: 0.99
  },
  {
    key: "aggr_35s_contra",
    label: "Aggressive 35s CONTRA (Contrária)",
    enabled: true,
    decisionMode: "sniper_v2",
    contrarian: true,
    entryMinutesLeft: 0.58,            // mesmo timing que aggr_35s
    targetEntryPrice: 0.18,            // não usado — contrarian usa preço real do livro
    priceEpsilon: 0.06,
    notionalUsd: 1.0,
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 999,
    rollingLossHours: 24,
    maxRollingLossUsd: 9999,
    minPayoutMultiple: 1.0,
    maxEntryPrice: 0.99
  },
  {
    key: "main_2m_contra",
    label: "Main 2m CONTRA (Contrária)",
    enabled: true,
    decisionMode: "main_2m_mid",      // mesma lógica de decisão que main_2m
    contrarian: true,
    entryMinutesLeft: 2.0,
    targetEntryPrice: 0.50,            // não usado — contrarian usa preço real do livro
    priceEpsilon: 0.001,
    notionalUsd: 1.0,
    riskGuardsEnabled: true,
    maxConsecutiveLosses: 999,
    rollingLossHours: 24,
    maxRollingLossUsd: 9999,
    minPayoutMultiple: 1.0,
    maxEntryPrice: 0.99
  }
];
