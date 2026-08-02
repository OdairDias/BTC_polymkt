# Notas de pesquisa BTC — vídeos, fontes e stop diário

> Estado: registro de evidência. Não autoriza alteração de estratégia, serviço, banco operacional ou execução live.

## 1. Material de vídeo analisado

Fontes abertas na sessão Chrome/RDP em 2026-08-01:

- `https://youtu.be/RhWVtOBsdEs` — material promocional genérico de “renda extra”; não trouxe regra BTC auditável.
- `https://youtu.be/YqiUnVYnnPo` — “BOT BTC AUTOMÁTICO À VENDA!”, mesmo canal; a tela mostra `BTC 5m Martingale` sobre contratos BTC UP/DOWN de 5 minutos da Polymarket.

O segundo vídeo exibe alegações comerciais como operação automática e “1% por operação”, além de uma UI com nível `1/10`, próxima entrada de US$5 e reset após ganho. Não documenta, de forma reproduzível:

- sinal mecânico para UP/DOWN;
- instante de entrada;
- multiplicador e limite econômico da progressão;
- perdas máximas, stop/cooldown ou risco de ruína;
- custos, profundidade, ordens, rejeições e fills;
- ledger de operações reais verificável.

### Decisão

**NO-GO para martingale.** A progressão de perdas não é evidência de alpha e concentra exposição exatamente após perdas. Nenhuma estratégia, shadow ou caminho live deve replicar martingale sem um contrato de risco inteiramente novo — o que não está autorizado.

## 2. Binance versus Polymarket/oráculo

A hipótese útil trazida pelo vídeo é que preço/fluxo Binance não é idêntico ao preço/oráculo usado no contrato Polymarket.

### Fatos do runtime `cheap_1h_exec_v2`

- Binance `BTCUSDT` é consultada por REST para candles de 1m/5m e último preço, e por WebSocket de trades.
- Os dados Binance alimentam VWAP, RSI, MACD, Heiken Ashi, volume, regime e a probabilidade técnica direcional.
- Polymarket fornece mercado, book, bid/ask, spread, liquidez e probabilidade implícita.
- Polymarket Live Data / Chainlink fornece o preço-oráculo usado contra o preço a bater do contrato.
- O modelo final usa probabilidade técnica e probabilidade-oráculo; o preço Binance também é persistido no ledger e possui guarda de frescor.

Evidência prospectiva na janela de 7 dias encerrada em 2026-08-01:

```txt
strategy_key: cheap_1h_exec_v2
sinais com Binance spot:       96/96
sinais com preço-oráculo:      96/96
sinais com preço a bater:      96/96
diferença média Binance-oráculo: +US$69,34
maior diferença absoluta:        US$107,20
```

### Limite da evidência

A diferença é observada e registrada, mas **não foi provada como edge**. O runtime não usa `Binance − oráculo` como gatilho independente de entrada. Diferença pode ser latência, metodologia de índice, arredondamento ou ruído já precificado no book.

### Decisão

**NO-GO para transformar divergência em gatilho de trade.** Se essa hipótese voltar a ser priorizada, o único caminho aceitável é uma coorte shadow isolada que meça se a divergência prevê repricing executável do book ou winner oficial depois de spread, fee e slippage.

## 3. Diagnóstico do H1 paper e stop diário

Coorte consolidada por entrada, não por saída parcial, no recorte disponível:

```txt
entradas finalizadas: 103
PnL total:          -US$12,97
EV por entrada:     -US$0,126
profit factor:       0,482
```

O H1 `cheap_1h_exec_v2` permanece `shadowOnly` / `dryRun`. O resultado negativo já inclui modelo de execução pessimista, fees e preços de entrada/saída ancorados ao book.

Dias observados no fuso `America/Sao_Paulo`:

| Dia | Entradas | PnL | EV por entrada |
|---|---:|---:|---:|
| 2026-08-01 | 5 | -US$2,24 | -US$0,448 |
| 2026-07-31 | 12 | -US$2,02 | -US$0,168 |
| 2026-07-30 | 16 | -US$2,22 | -US$0,139 |
| 2026-07-29 | 23 | -US$0,90 | -US$0,039 |
| 2026-07-28 | 5 | -US$2,11 | -US$0,421 |
| 2026-07-27 | 13 | -US$2,51 | -US$0,193 |
| 2026-07-26 | 20 | +US$0,04 | +US$0,002 |
| 2026-07-25 | 23 | -US$0,42 | -US$0,018 |

O guard diário atual bloqueou corretamente em `dailyPnL=-US$2,24 <= -US$2,00` em 2026-08-01.

### Limite de observabilidade atual

Após uma decisão contínua bloqueada por risco, o runtime não persiste o candidato nem acompanha o desfecho. Na auditoria:

```txt
registros persistidos SKIP_RISK_* para cheap_1h_exec_v2: 0
```

Assim, não existe contrafactual auditável para afirmar que operações posteriores ao stop teriam recuperado perdas ou piorado o resultado.

### Decisão

**Não aumentar/remover o stop diário da baseline atual.** Mais operações negativas não criam edge. O stop protege a interpretação e impede que uma tese fraca acumule perda sem entregar evidência causal.

## 4. Próximas hipóteses prioritárias — não implementadas

1. **Observabilidade antes de relaxar risco**
   - Registrar prospectivamente todos os candidatos que chegam ao gate diário, inclusive os bloqueados.
   - Registrar book, ask/bid, sinal, edge, motivo, preço executável modelado e trajetória até o outcome.
   - Manter esses candidatos sem ordem e sem misturar com a baseline.

2. **Calibração e alvo econômico**
   - Verificar se `model_prob` e `edge` separam vencedores/perdedores.
   - Verificar se a previsão de settlement é compatível com o lifecycle de TP/trailing/time-stop.
   - Não subir thresholds por intuição; comparar distribuições e estabilidade por regime.

3. **Shadow pareado de política de risco**
   - Preservar a baseline com stop de US$2.
   - Criar, somente mediante aprovação, uma coorte separada de observação com a mesma regra de entrada e stake fixa, mas sem interromper a geração de contrafactuais após o stop.
   - Relatar separadamente `BASELINE_STOP_2USD` e `UNLIMITED_OBSERVATION_ONLY`.
   - O segundo rótulo não representa PnL live nem autorização para capital adicional.

4. **Diagnóstico de cauda de perdas e saída**
   - Segmentar por lado, faixa de entrada, edge, probabilidade, spread, book imbalance, minutos restantes, regime e motivo de saída.
   - Priorizar cortes/quarentenas de subconjuntos comprovadamente ruins, não aumentar frequência de toda a estratégia.

## 5. Implementação prospectiva aprovada — observer pós-stop

Implementado em `2026-08-01` como experimento **paper-only**:

```txt
strategy_key: cheap_1h_exec_v2_poststop_observer
origem: somente candidatos bloqueados por SKIP_RISK_DAILY_LOSS
momento: após preço executável, sizing e profundidade de ask
entrada: mesma best ask/slippage/fee simulados da baseline
saída: settlement oficial Gamma; não replica TP em memória
execução live: inexistente; não é liveStrategyKey e não chama o adapter CLOB
persistência: uma observação por strategy_key + market_slug
```

O observer não remove nem amplia o stop de US$2 da baseline. Seu resultado é classificado como:

```txt
EXECUTABLE_FILL_SIMULATED
SETTLEMENT_ONLY
OBSERVATION_ONLY
```

O objetivo é produzir o contrafactual faltante: medir se candidatos posteriores ao stop diário teriam melhorado ou piorado o resultado sob preço executável e fee modelados. Não é evidência de fill real, escalabilidade ou autorização live.

Critério de leitura: comparar baseline e observer por data/regime/lado/edge/preço, após uma quantidade prospectiva suficiente de outcomes oficiais. Não alterar thresholds ou risco com base em uma sequência curta.


Nenhuma mudança de sizing, stop diário ou live deve ser promovida antes de uma coorte prospectiva com:

- candidatos bloqueados e permitidos integralmente atribuídos;
- preço de entrada no ask e saída no bid, com fee/slippage;
- número mínimo de entradas definido antes da leitura;
- PnL líquido, profit factor, drawdown e estabilidade por dia/regime;
- comparação pareada contra a baseline no mesmo período;
- decisão explícita GO/NO-GO.
