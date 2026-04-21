# Estrategia: `cheap_1h_tp45`

## Em uma frase

Versao da `cheap_revert` para mercado BTC de `1 hora`, com janela continua de entrada, tiers por tempo restante e confirmacao suave pelo mercado `15m`.

## Identidade

- `key`: `cheap_1h_tp45`
- `decisionMode`: `cheap_revert`
- Mercado principal: BTC `1h`
- Janela de entrada: de `57m` ate `10m` restantes
- Piso de compra: `minEntryPrice=0.05`
- Saida: TP escalonado em `0.40`, `0.45` e `0.50`, com trailing a partir de `0.42`
- Force exit: `5m` antes do fim
- Tipo de ordem live: `FAK` para entrada e saida

## Tiers de entrada

| Tempo restante | Compra maxima | Edge minimo |
|---|---:|---:|
| `40m` a `57m` | `0.42` | `0.11` |
| `20m` a `40m` | `0.42` | `0.07` |
| `10m` a `20m` | `0.42` | `0.05` |

## Regras principais

- `minPayoutMultiple=1.5`
- `minEdge=0.05`
- `minModelProb=0.30`
- `minBookImbalance=0.65`
- `maxSpreadToEdgeRatio=0.50`
- `grossProfitTargetUsd=0` (desligado)
- `sizingMode=kelly` com faixa de notional `0.70` a `1.00` USD

## Resolucao de mercado

Para o H1, o bot usa a serie da Gamma:

- `marketSeriesId=10114`
- `marketSeriesSlug=btc-up-or-down-hourly`

Para confirmacao cross-market, o plano usa o mercado `15m` corrente:

- `crossMarketWindowMinutes=15`
- `crossMarketSlugPrefix=btc-updown-15m`
- `crossMarketSeriesSlug=btc-up-or-down-15m`

Como `crossMarketRequired=false`, a confirmacao de `15m` funciona como bonus quando alinhada. Divergencia alta nao bloqueia a entrada enquanto esse campo estiver falso.

## Estado atual de operacao

- `cheap_1h_tp45`: ativa
- `cheap_15m_tp35`: mantida no codigo, mas desativada para o teste atual de `1h`
