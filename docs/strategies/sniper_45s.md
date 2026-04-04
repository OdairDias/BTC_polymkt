# Estrategia: `sniper_45s`

## Em uma frase (para leigos)

Esta estrategia tenta acertar a direcao bem no fim da janela e so entra se o preco permitir um bom "retorno potencial" (assimetria).

## Objetivo

Perfil Sniper principal, focado em conviccao direcional no final da janela com entrada assimetrica.

## Identidade

- `key`: `sniper_45s`
- `decisionMode`: `sniper_v2`
- Janela tipica: `entryMinutesLeft=0.75` (45 segundos)

## O que ela faz (passo a passo detalhado)

1. **Gatilho de Tempo:** A estratégia permanece inativa até entrar na janela crítica de decisão, ou seja, quando faltam **45 segundos (0.75 min)** ou menos para o fechamento do candle de 5 minutos.
2. **Análise Direcional Principal (Delta / T.A.):** 
   A direção do mercado é decidida comparando o preço *Spot* do Bitcoin na Binance com o preço base (*Price To Beat*) do Polymarket.
   - **`UP` (Comprar):** Se o preço do Bitcoin estiver com uma folga positiva de no mínimo **$5** (`ptbDelta >= +5`) em relação ao alvo.
   - **`DOWN` (Vender):** Se o preço do Bitcoin estiver abaixo do alvo em pelo menos **$5** (`ptbDelta <= -5`).
   - Se o preço estiver "andando de lado" (diferença menor que $5), o robô ignora o mercado por falta de força direcional clara.

3. **Filtros de Segurança (Análise Técnica Evita "Falso Rompimento"):**
   Mesmo que o Delta seja positivo, o robô faz uma checagem dupla para não entrar em movimentos que já acabaram:
   - **RSI (A exaustão):** Se a estratégia mandar dar `UP` mas a força compradora já estiver exausta demais (RSI $\ge$ 75), o robô cancela a entrada para não comprar "no topo". Se mandar dar `DOWN` e o RSI estiver $\le$ 25 (já caiu demais), ele não vende "no fundo".
   - **MACD + Heiken Ashi (Momentum vs Direção):** Se a tendência (Heiken Ashi) estiver vermelha/de queda e o histograma do MACD estiver caindo, o robô **bloqueará qualquer tentativa de entrada em UP**. Ele só aposta a favor do momentum.

4. **Entrada FOK Ancorada:**
   Após passar com sucesso pelos filtros, a estratégia estipula qual é o **limite máximo** que você aceita pagar pelas cotas (ex: `targetEntryPrice = 0.20`).
   O robô então prepara uma ordem agressiva do tipo *Fill-or-Kill (FOK)* no valor que você determinou em `notionalUsd`. Se houver liquidez barata na carteira visível do mercado e a $0.20 ou menos, ele pesca esses tokens no pânico dos 45 segundos.

5. **Aprovação Final (Risk Guard):** Todo sinal gerado passa por um bloqueador geral (Drawdown ou Limite de Perdas Consecutivas) antes de bater na API.

## Risco e assimetria

Esta estrategia respeita os guardas globais/da variante:

- `minPayoutMultiple`
- `maxEntryPrice`
- limite de perdas rolantes e sequencia de losses

## Parametros mais importantes

- `entryMinutesLeft`: define o quao "no final" a estrategia pode agir. `0.75` significa entrar faltando 45s.
- `targetEntryPrice`: define o preco-ancora. Quanto menor, mais assimetrico, mas mais dificil de executar e mais sujeito a ficar sem entrada.
- `notionalUsd`: define o tamanho do trade para essa estrategia no modo live (em paper tambem afeta o PnL simulado).
- `minPayoutMultiple`: define o minimo retorno potencial aceitavel (intuicao: `payout ~ 1/price`).

## Observacoes

- Recomendada como `STRATEGY_LIVE_STRATEGY_KEY` quando live estiver ligado.
- Boa referencia para comparar contra `main_2m`.
