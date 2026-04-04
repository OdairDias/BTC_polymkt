# Estrategia: `aggr_35s`

## Em uma frase (para leigos)

Esta e uma "Sniper mais agressiva": decide muito perto do fim e tenta um preco ainda mais baixo para buscar maior assimetria, aceitando mais risco de nao executar e mais ruido.

## Objetivo

Variante Sniper agressiva para buscar entrada mais rapida e maior convexidade.

## Identidade

- `key`: `aggr_35s`
- `decisionMode`: `sniper_v2`
- Janela tipica: `entryMinutesLeft=0.58` (~35 segundos)
- Alvo tipico: `targetEntryPrice=0.18`
- Epsilon tipico: `priceEpsilon=0.06`

## O que ela faz (passo a passo detalhado)

A essência técnica é a mesma da Sniper, mas os parâmetros são "esticados" ao limite do extremo para focar na convexidade pura:

1. **Gatilho de Tempo no Pânico Absoluto:** O robô espera até que restem **apenas 35 segundos (0.58 min)**. Nesse momento, a maioria dos bots lentos e traders manuais fecharam suas ordens ou entraram em desespero ("microestrutura estressada").
2. **Análise Direcional Principal (Delta / T.A.):** 
   A direção do mercado é decidida comparando o preço *Spot* do Bitcoin na Binance com o preço base (*Price To Beat*).
   - **`UP` (Comprar):** `ptbDelta >= +5`
   - **`DOWN` (Vender):** `ptbDelta <= -5`
3. **Filtros de Segurança (Análise Técnica Evita "Falso Rompimento"):**
   Mesmo sendo agressiva na busca por lucro, ela não joga dinheiro fora em exaustões.
   - **RSI:** Bloqueia compras (`UP`) em RSI $\ge$ 75 (topo) e vendas (`DOWN`) em RSI $\le$ 25 (fundo).
   - **MACD + Heiken Ashi:** Fuga estrutural de momentum reverso imposta pelo MACD e velas vermelhas pesadas.
4. **Entrada FOK Ancorada (Extrema Assimetria):**
   Este é o grande diferencial. Colocamos a "faca na caveira" limitando o preço de entrada a incríveis **0.18 ou menos**. Isso significa que a estratégia só atira se a recompensa for absurdamente alta. Você perderá várias oportunidades (o preço passará raspando nas suas ordens), mas as ordens que entrarem terão um Payout Massivo para amortecer as ordens estopadas.
5. **Aprovação Final (Risk Guard):** Devido à natureza sensível dos parâmetros, as ordens passam por escrutínio de Drawdown no Banco. A recomendação é nunca subir o `notionalUsd` sem testar antes na nuvem.

## Por que "aggressive"

- janela de reacao menor
- ancora de preco mais baixa
- tende a menos entradas, com payoff potencial maior

## Parametros mais importantes

- `entryMinutesLeft`: `0.58` (aprox 35s) faz a estrategia agir muito no final.
- `targetEntryPrice`: `0.18` aumenta payout potencial, mas aumenta chance de ficar sem fill e aumenta sensibilidade a microestrutura.
- `notionalUsd`: deve ser controlado com cuidado aqui; um perfil agressivo nao deve carregar um notional alto sem guardas.

## Observacoes

- Mais sensivel a ruido de microestrutura e dinamica de fill.
- Deve ser monitorada de perto para streak de perdas e baixa taxa de execucao.
