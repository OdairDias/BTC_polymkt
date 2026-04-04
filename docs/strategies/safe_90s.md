# Estrategia: `safe_90s`

## Em uma frase (para leigos)

Esta e uma "Sniper mais segura": entra um pouco antes e aceita um preco menos assimetrico, com tamanho menor, para reduzir variancia e drawdown.

## Objetivo

Variante Sniper conservadora: mais cautelosa que perfis agressivos.

## Identidade

- `key`: `safe_90s`
- `decisionMode`: `sniper_v2`
- Janela tipica: `entryMinutesLeft=0.9` (~54 segundos)
- Alvo tipico: `targetEntryPrice=0.25`
- Tamanho tipico: `notionalUsd=0.75`

## O que ela faz (passo a passo detalhado)

Mesma base técnica da família Sniper, mas com um perfil mais "flexível" para garantir a entrada e suavizar drawdowns:

1. **Gatilho de Tempo Antecipado:** Ao invés de esperar o pânico final dos 45 segundos, o robô entra em ação quando faltam **54 segundos (0.9 min)** para o fim do candle. Ele tenta pescar a tendência antes dela explodir.
2. **Análise Direcional Principal (Delta / T.A.):** 
   A direção do mercado é decidida comparando o preço *Spot* do Bitcoin na Binance com o preço base (*Price To Beat*).
   - **`UP` (Comprar):** `ptbDelta >= +5`
   - **`DOWN` (Vender):** `ptbDelta <= -5`
3. **Filtros de Segurança (Análise Técnica Evita "Falso Rompimento"):**
   Mesmo sendo "Safe", a estratégia se recusa a entrar em exaustões de mercado.
   - **RSI:** Bloqueia compras (`UP`) em RSI $\ge$ 75 (topo eufórico) e vendas (`DOWN`) em RSI $\le$ 25 (fundo de pânico).
   - **MACD + Heiken Ashi:** Bloqueia apostas contra o *momentum*. Se o mercado estruturalmente cai forte (Heiken Ashi de queda + MACD cruzando pra baixo), ignoramos sinais passageiros isolados de UP.
4. **Entrada FOK Ancorada (Menos Assimétrica):**
   A grande diferença para a Sniper padrão. Aqui, estabelecemos o **preço-alvo de 0.25** em vez de 0.20. Ao aceitar pagar até 25 centavos por contrato, nós "sacrificamos" um pouco do lucro máximo potencial em troca de uma **taxa de sucesso de execução (Fill Rate) consideravelmente mais alta**.
5. **Aprovação Final (Risk Guard):** Todo sinal passa pelo gerenciador de risco (Drawdown e limites de loss). Além disso, o `notionalUsd` padrão é rebaixado (ex: $0.75) para que eventuais stops machuquem menos o portfólio no longo prazo.

## Por que "safe"

- entrada menos extrema que `0.20`
- notional menor
- pode operar com guardas de risco mais restritivos

## Parametros mais importantes

- `entryMinutesLeft`: `0.9` (aprox 54s) costuma dar um pouco mais de tempo que `0.75` (45s).
- `targetEntryPrice`: `0.25` reduz payout potencial vs `0.20`, mas tende a dar mais fills.
- `notionalUsd`: `0.75` reduz o impacto de sequencias de perdas durante teste.
- `minPayoutMultiple`: se definido, ajuda a manter a asimetria a favor mesmo com preco alvo mais alto.

## Observacoes

- Boa para teste de controle de drawdown.
- Compare contra `sniper_45s` para medir se menor variancia compensa o payoff menor.
