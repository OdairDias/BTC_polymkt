# Changelog

## [switch-1h-test] - 2026-04-15

### Nova variante live para mercado horario

- Criada a estrategia `cheap_1h_tp45` (`decisionMode=cheap_revert`) para o mercado de 1 hora.
- Parametros operacionais solicitados:
  - entrada maxima: `targetEntryPrice=0.30` (`maxEntryPrice=0.30`)
  - saida alvo: `takeProfitPrice=0.45`
- Mercado configurado com fallback robusto por serie:
  - `marketSeriesId=10114`
  - `marketSeriesSlug=btc-up-or-down-hourly`

### Isolamento do teste

- `cheap_15m_tp35` foi mantida no codigo, mas com `enabled=false` para evitar concorrencia durante o teste de 1h.
- Com isso, se `STRATEGY_LIVE_STRATEGY_KEY` continuar apontando para `cheap_15m_tp35`, o bootstrap automaticamente usa a primeira variante ativa (`cheap_1h_tp45`).

## [ajuste-strategia] - 2026-04-13

### Ajuste fino da `cheap_15m_tp35`

- `minModelProb` reduzido de `0.56` para `0.54` na variante `cheap_15m_tp35`.
- Motivo: os logs apos o ultimo deploy mostraram ausencia de erro operacional, mas excesso de
  `SKIP_MODEL_PROB_TOO_LOW`, indicando filtro de conviccao conservador demais para a janela atual.
- `targetEntryPrice` / `maxEntryPrice` aumentados de `0.35` para `0.37`.
- Motivo: entradas historicas permitidas estavam concentradas no limite de `0.35`, enquanto o
  bloco `SKIP_CHEAP_TOO_EXPENSIVE` permaneceu alto nas ultimas janelas.

### Robustez do fallback por `seriesSlug`

- O fallback de mercado por `seriesSlug` foi alterado para consultar o endpoint `/series?slug=...`
  e, a partir dele, resolver o evento/mercado ativo por slug.
- Motivo: a Gamma nem sempre respeita o filtro `seriesSlug` no endpoint `/markets`, o que deixa
  o fallback atual vulneravel para series fora do padrao de slug recorrente por timestamp.
- Impacto pratico: isso melhora a seguranca do fallback do `15m` e abre caminho tecnico mais
  confiavel para avaliar a serie `btc-up-or-down-hourly`.

## [ajuste-strategia] — 2026-04-09

### Diagnostico da sessao

Durante analise dos logs do Railway foi identificado que a estrategia `cheap_15m_tp35`
nunca gerava entradas. A investigacao revelou dois problemas independentes:

**Problema 1 — Dado em cache congelado**
Nos logs, a linha de status da `cheap_15m_tp35` mostrava sempre os mesmos precos
(`UP 0.605 vs DOWN 0.395`) sem variar entre os ticks. Isso indicava que o snapshot
do mercado 15m estava retornando `ok: false` na maioria dos ticks, e o codigo
exibia a ultima mensagem salva em cache indefinidamente.

**Problema 2 — Bug na resolucao do mercado 15m**
O campo `marketSeriesSlug` definido em `variants.js` para a estrategia 15m
(`btc-up-or-down-15m`) nao era passado pela funcao `getStrategyMarketGroups`
para `resolveCurrentBtcMarket`. Apenas `marketSeriesId` era passado, que estava
vazio. Sem fallback de serie funcionando, o bot dependia exclusivamente do slug
gerado por timestamp (`btc-updown-15m-{bucket}`), que pode nao existir em todos
os momentos.

---

### Correcoes aplicadas

#### `src/index.js`

- **`getStrategyMarketGroups`**: adicionado `seriesSlug` ao `customMarketConfig`,
  lido de `variant.marketSeriesSlug`. Atualizado `hasCustomMarket` para considerar
  `seriesSlug` como sinalizador de mercado customizado.

- **`buildMarketConfigKey`**: incluido `seriesSlug` na chave de cache para garantir
  isolamento correto entre grupos com series distintas.

- **`resolveCurrentBtcMarket`**: adicionado `seriesSlug` ao objeto de config interno.
  Implementado **Fallback 2** via `fetchMarketsBySeriesSlug`, acionado quando os slugs
  por timestamp e o fallback por `seriesId` falham. Adicionados logs `[market]`
  mostrando quais slugs foram tentados, qual resolveu e avisos quando nenhum foi
  encontrado.

- **Import**: adicionado `fetchMarketsBySeriesSlug` ao import de `./data/polymarket.js`.

#### `src/strategy/variants.js`

- Variantes `sniper_45s`, `safe_90s`, `aggr_35s` e `main_2m` marcadas com
  `enabled: false` para isolar o teste da `cheap_15m_tp35`.
- `cheap_15m_tp35` permanece com `enabled: true` e parametros originais intactos
  (`targetEntryPrice=0.25`, `minPayoutMultiple=2.0`).

#### `docs/strategies/cheap_15m_tp35.md`

- Adicionada secao "Como o mercado 15m e resolvido" explicando as tres tentativas
  em ordem (slug, seriesId, seriesSlug) e os logs esperados.
- Adicionada nota sobre `marketSeriesSlug` ser essencial para o fallback.
- Expandidas as "Leituras praticas" com orientacao sobre dado congelado nos logs.

---

### Ordem de resolucao de mercado pos-correcao

Para a `cheap_15m_tp35`, a sequencia agora e:

```
1. btc-updown-15m-{bucket_atual}   ← slug por timestamp (janela atual)
2. btc-updown-15m-{bucket_anterior} ← slug por timestamp (janela -15m)
3. btc-updown-15m-{bucket_proximo}  ← slug por timestamp (janela +15m)
4. seriesId numerico (vazio neste caso)
5. seriesSlug=btc-up-or-down-15m   ← NOVO fallback via Gamma /markets
```

---

### Variaveis Railway recomendadas (sem alteracao)

```
STRATEGY_DRY_RUN=false
STRATEGY_ENABLED=true
STRATEGY_LIVE_ARMED=true
STRATEGY_LIVE_STRATEGY_KEY=cheap_15m_tp35
STRATEGY_NOTIONAL_USD=1
POLYMARKET_SIGNATURE_TYPE=2   ← revisar: valores validos sao 0 (EOA) ou 1 (proxy)
```

> **Atencao:** `POLYMARKET_SIGNATURE_TYPE=2` pode ser invalido no CLOB da Polymarket.
> Os valores documentados sao `0` (EOA pura) e `1` (conta proxy/funder com
> `POLYMARKET_FUNDER_ADDRESS`). Testar com `1` se houver erros de assinatura
> na primeira ordem real.

---

### Proximos passos sugeridos

1. Fazer redeploy no Railway e verificar nos logs se aparece `[market] resolved via ...`
   para o grupo 15m.
2. Confirmar que `POLYMARKET_SIGNATURE_TYPE` esta correto antes da primeira ordem live.
3. Apos primeiras entradas, avaliar frequencia de `SKIP_CHEAP_TOO_EXPENSIVE` —
   se ainda for alta, considerar ajuste controlado de `targetEntryPrice` (ex.: 0.30)
   mantendo `minPayoutMultiple` coerente.
