# Plano de melhoria — estratégia Polymarket BTC 15m

Documento de referência para implementação incremental. Alinha-se à estrutura atual do repositório (`lateWindow.js`, `paperStrategy.js`, `edge.js`, `probability.js`, `postgresStrategy.js`, `index.js`).

---

## 1. Princípios

1. **Settlement como contrato**: o payoff final obedece às regras de resolução do mercado, não ao gráfico “que parece certo”. Documentação oficial: [Resolution — Polymarket](https://docs.polymarket.com/concepts/resolution).
2. **Dois referenciais de preço**: Chainlink/stream (âncora próxima do settlement) vs Binance (sinal de curto prazo). Não misturar sem nomear no código e no banco.
3. **Três camadas de decisão**:
   - **Fair value** \(p^\*\) — probabilidade estimada de UP ganhar.
   - **Mercado implícito** \(p_{\text{mkt}}\) — ask/mid do token.
   - **Execução** — spread, profundidade, FOK/FAK, slippage.
4. **Calibração**: além de PnL, medir qualidade de \(p^\*\) (ex.: Brier score). Referência de leitura: [Building a Quantitative Prediction System for Polymarket](https://navnoorbawa.substack.com/p/building-a-quantitative-prediction).
5. **Nenhuma estratégia é “imbatível”**; o objetivo é **vantagem estatística + execução + risco** sustentáveis.

---

## 2. Objetivos mensuráveis (definir valores com dados)

| Métrica | Definição | Notas |
|--------|------------|--------|
| **EV/trade** | Média de `pnl_simulated_usd` por trade fechado | Estável por 2+ semanas antes de subir notional |
| **Brier** | Erro quadrático entre \(p^\*\) e resultado 0/1 (UP venceu?) | Queda ao longo do tempo após tunar modelo |
| **Tail risk** | p5 do PnL por trade, max drawdown rolling 7d | Limites explícitos em produção |
| **Realismo paper** | Diferença média paper vs live (slippage) | Paper pessimista como piso de expectativa |

---

## 3. Arquitetura alvo

```
Dados (book, oracle, Binance, meta do mercado)
  → features por tick / por entrada
  → fair_value(p*) + implied(p_mkt) + edge
  → policy (sniper / cheap / híbrido) + risk
  → execução (FOK/FAK, saídas)
  → Postgres + relatórios
  → calibração / walk-forward (offline)
```

**Módulos sugeridos (novos):**

- `src/strategy/fairValue.js` — \(p^\*\), normalização de `ptbDelta` por vol (ATR etc.).
- `src/strategy/policy.js` — composição de gates e códigos de skip estáveis.
- `src/strategy/executionModel.js` — simulação conservadora de fill (opcional).
- `scripts/report-strategy.mjs` — agregações EV por bucket, Brier.

---

## 4. Diagnóstico resumido do código atual

- **`cheap_revert`**: escolhe o lado mais barato pelo ask; **não** usa o modelo `computeEdge` / `decide` do dashboard — risco de “barato porque está morto”.
- **`sniper_v2`**: limiar fixo `ptbDelta` ± USD 5 — deve escalar com volatilidade/tempo.
- **`applyTimeAwareness`**: usa `windowMinutes` ligado a `CONFIG.candleWindowMinutes` (default 5); mercado 15m deve usar **janela de 15** (ou `variant.marketWindowMinutes`) para decay coerente.
- **Risk guards** na variante `cheap_15m_tp35`: valores 999/9999 desativam freios — ok para lab, inaceitável para produção.

---

## 5. Marcos de implementação (Nível Institucional)

### Marco 0 — Instrumentação (Feature Store e Data Science)

**Status:** `concluído` (colunas de sinais/outcomes persistidas + treino offline baseline em `scripts/train-probability-model.mjs`).

**Objetivo**: Transformar o banco de dados em uma base de treinamento para modelos estatísticos.

- **Colunas em `strategy_paper_signals`**:
  - `oracle_price`, `binance_spot_price`, `price_to_beat`, `ptb_delta_usd`
  - `model_up`, `model_down` (pós `applyTimeAwareness`)
  - `vol_atr_15m`: Volatilidade real dos últimos 14 períodos 15m.
  - `oracle_prob`: Probabilidade matemática (Normal CDF) baseada em distance/vol.
  - `book_imbalance`: Ratio entre volume no Bid e Ask.

---

### Marco 1 — Alinhamento Temporal e Decay THETA

**Status:** `concluído` (janela real de mercado por variante e decay temporal aplicado no fluxo 15m).

**Entregáveis**
- Uma função única que calcula decay temporal usando **duração real do mercado**.
- Substituir decay linear por curva de **Theta** (perda de valor acelerada no fim).

---

### Marco 2 — Fair Value Quantitativo (O Coração do Bot)

**Status:** `concluído` (fair value + edge explícito + persistência em banco).

O bot deve parar de pensar em "pontos" e passar a pensar em **Distorção de Preço**.
- **Fórmula de Fair Value**: Fusão Bayesiana entre sinais técnicos ($P_{TA}$) e probabilidade de barreira ($P_{Oracle}$).
- **Edge Explícito**: `Edge = P_Estimada - P_Mercado`.
- **Persistência**: Gravar Fair Value e Edge em cada trade para calibragem posterior.

---

### Marco 3 — Política de Entrada e Microestrutura

**Status:** `concluído` (gate de imbalance, spread-vs-edge e sniper dinâmico por ATR).

Um trader profissional não "clica no botão" se a fila estiver contra ele.
- **Order Flow Gate**: Verificar `book_imbalance` antes de entrar. Se a pressão de venda for alta, adia a compra 'UP'.
- **Spread vs. Edge**: Recusar trades onde o `Spread >= 0.5 * Edge`.
- **Sniper Dinâmico**: Substituir ± USD 5 fixo por múltiplo de ATR.

---

### Marco 4 — Execução e PnL Realista (Paper Mode)

**Status:** `concluído` (modo pessimista com slippage e penalidade de spread).

- Env `PAPER_FILL_MODE=pessimistic`.
- Simular slippage fixo em bps ou considerar o preço no 3º nível do book como preço de entrada.

---

### Marco 5 — Risco e Governança Profissional

**Status:** `concluído` (staleness/latência, sizing Kelly e kill-switch diário implementados).

- **Sizing Dinâmico (Kelly)**: Ajustar notional baseado na confiança do sinal.
- **Capital Guard**: Prod com `maxRollingLossUsd` e kill switch diário.
- **Halt Automático**: Pausar se o Oracle estiver "stale" ou latência > 2s.

---

### Marco 6 — Relatórios e Walk-Forward

**Status:** `concluído` (scripts `report-strategy` e `walkforward-strategy` com Brier, decil de edge, SKIPs, paper-vs-live e validação OOS).

- Script que gera o **Brier Score** semanal.
- Relatório de acerto por decil de Edge (ex: trades com Edge > 15% acertam 70% das vezes?).

---

## 9. Camada Extra — Elevando o Nível Profissional

Esta secção complementa o projeto com práticas de **institucional/mesa quant**.

- **9.1 Observabilidade**: Logar latência fim-a-fim e detectar "dados obsoletos" (staleness).
- **9.2 Rastreabilidade**: Cada trade vinculado ao `git_commit` e `config_hash` (`concluído`).
- **9.3 Microestrutura Avançada**: Velocidade de mudança do mid e inconsistência binária (sum mids != 1.00).

---

## 11. A visão do Trader Profissional (O Próximo Nível)

Para transformar o bot de um "seguidor de indicadores" em uma **máquina de extração de valor estatístico**:

- **Modelagem de Probabilidade Relatíva**: Operar distorção de preço, não gráfico.
- **Fila e Book**: O livro de ordens antecipa a vela.
- **Gestão via Kelly**: O sizing é 50% do lucro a longo prazo.

---

## 12. Checklist "Pronto para Escalar"

1. [x] Walk-forward Out-of-Sample implementado (pronto para execução mensal).
2. [x] Slippage Pessimista no paper ≥ 0.
3. [x] Kill-Switch de Latência e Staleness ativo.
4. [x] Log de Atribuição completo (por que entrei?).

---

## 13. Tópicos Avançados de Fronteira (Alpha Extra)

Para quando os marcos anteriores estiverem estabilizados, estes itens podem fornecer o "Alpha" final para bater a concorrência:

### 13.1 Correlação Exógena (Fator Macro)
O BTC não se move no vácuo.
- **Filtro TradFi**: Se o índice S&P500 ou Nasdaq (NQ) estiverem caindo forte em 1min, a probabilidade de um trade "UP" no BTC ter sucesso cai drasticamente.
- **Implementação**: Adicionar um "Macro Gate" que consulta preços de índices globais e pausa entradas contra o fluxo macro.

### 13.2 Inconsistência Binária (Arbitragem Teórica)
Em mercados de "Sim ou Não", a soma das probabilidades implícitas (`Mid_UP + Mid_DOWN`) deveria ser exatamente $1.00$.
- **Alerta de Inconsistência**: Se a soma for $0.90$, há uma oportunidade (ou erro de dados). Se for $1.10$, o spread está proibitivo.
- **Uso**: O bot pode priorizar entradas em mercados onde a soma é $< 1.00$, garantindo um preço matematicamente superior.

### 13.3 Detecção de Fluxo Tóxico (Anti-Adverse Selection)
Às vezes, ser executado é um sinal ruim (alguém sabe algo que você não sabe).
- **Toxic Flow Guard**: Se o preço da Binance cair forte *durante* o processo de envio da nossa ordem "UP", o bot deve tentar cancelar via FOK/FAK instantâneo para evitar ser " atropelado".

### 13.4 Transição de Regime (HMM - Hidden Markov Models)
O mercado tem dois estados principais: **Tendência** e **Ruído**.
- **Switch Automático**: No estado de Ruído, usamos `Cheap Revert` (reversão à média). No estado de Tendência, usamos `Sniper` (seguindo o momentum).

---

## 14. Nuances e Vantagens Específicas da Polymarket

Para operar profissionalmente na Polymarket, é preciso entender as "regras não escritas" da plataforma que geram lucro:

### 14.1 O Atraso do Oráculo (Chainlink Lag)
A Polymarket resolve via Chainlink. O oráculo tem um "heartbeat" (atualiza a cada X minutos ou Y% de variação).
- **Vantagem**: Às vezes a Binance já subiu \$20, mas o oráculo da Chainlink ainda não atualizou. Se o mercado da Polymarket estiver seguindo o oráculo "atrasado", você pode comprar o UP com uma certeza estatística muito maior de que o settlement será favorável.

### 14.2 Latência dos Market Makers
Os grandes provedores de liquidez no CLOB usam bots para ajustar os preços conforme a Binance se move.
- **Vantagem**: Existe uma latência (geralmente de 200ms a 800ms) entre o movimento na Binance e o ajuste na Polymarket. Nossas estratégias "Sniper" exploram exatamente esse "buraco" temporal onde o preço da Polymarket está "errado" por frações de segundo.

### 14.3 A Psicologia do "Bilhete de Loteria"
A natureza humana tende a superestimar a chance de reversões milagrosas no último minuto.
- **Vantagem**: Isso faz com que a ponta "perdedora" (ex: DOWN quando o preço está muito acima da barreira) muitas vezes custe \$0.05 ou \$0.08 quando matematicamente deveria custar \$0.01. Operar contra essa "esperança irracional" (vender o lixo) é uma fonte constante de renda para bots.

### 14.4 Concentração de Liquidez (Bins)
Diferente de uma corretora spot, a liquidez na Polymarket é concentrada em centavos inteiros.
- **Vantagem**: Às vezes, existe muita liquidez no \$0.35, mas quase nada no \$0.36. O bot deve estar programado para "atropelar" esses buracos de liquidez ou se posicionar logo antes deles.

---

*Última atualização: plano consolidado + camada quant + alpha extra + nuances Polymarket.*
