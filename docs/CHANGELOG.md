# Changelog

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
