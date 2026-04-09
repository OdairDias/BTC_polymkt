# Estrategia: `cheap_15m_tp35`

## Em uma frase (para leigos)

Esta estrategia compra cedo o lado mais barato do mercado de `15 minutos` e tenta sair com lucro em `0.35`, sem precisar esperar o resultado final.

## Objetivo

Capturar uma reprecificacao curta no meio da janela, em vez de depender apenas de acertar o vencedor no vencimento.

## Identidade

- `key`: `cheap_15m_tp35`
- `decisionMode`: `cheap_revert`
- Mercado: BTC `15m`
- Entrada tipica: `entryMinutesLeft=13.75` (cerca de 1m15s depois da abertura)
- Compra maxima: `targetEntryPrice=0.20`
- Piso de compra: `minEntryPrice=0.08`
- Saida no lucro: `takeProfitPrice=0.35`
- Saida por tempo: `forceExitMinutesLeft=2.5`

## O que ela faz (passo a passo)

1. Espera o mercado `15m` abrir e deixa passar um pequeno trecho inicial.
2. Quando entra na janela configurada, compara os dois lados (`UP` e `DOWN`).
3. Escolhe o lado mais barato.
4. So entra se esse lado estiver barato, mas ainda "vivo":
   - nao pode estar acima de `0.20`
   - nao pode estar abaixo de `0.08`
5. Depois da entrada, monitora o `best bid` da posicao aberta.
6. Se o bid bater `0.35`, sai no lucro antes do vencimento.
7. Se o alvo nao vier e o tempo estiver acabando, tenta sair quando faltarem `2.5` minutos.
8. Se nem o alvo nem a saida por tempo conseguirem acontecer, a operacao ainda pode acabar sendo resolvida no fechamento oficial.

## Ideia por tras

Essa estrategia nasceu para atacar um problema que apareceu nas operacoes reais: em varias situacoes, a entrada ate era boa, mas o mercado virava no final.

Entao a logica aqui e diferente da sniper:

- a sniper tenta achar um ponto extremo perto do fim para buscar payout alto
- a `cheap_15m_tp35` tenta explorar um exagero de preco mais cedo
- o foco e "comprar barato e vender melhor", nao necessariamente acertar o vencedor final

## Parametros mais importantes

- `entryMinutesLeft=13.75`
  - entra cedo na janela de `15m`, mas nao no primeiro segundo
- `targetEntryPrice=0.20`
  - se o lado barato estiver acima disso, a estrategia faz skip
- `minEntryPrice=0.08`
  - evita entrar em um lado que ja pode estar esmagado demais
- `takeProfitPrice=0.35`
  - alvo inicial mais conservador para comecar a calibracao
- `forceExitMinutesLeft=2.5`
  - evita carregar a operacao ate a parte mais "travada" do fim do mercado

## Leituras praticas

- Se entrar pouco, o primeiro ajuste natural costuma ser relaxar o teto de compra.
- Se entrar bem, mas nao realizar, o primeiro ajuste natural costuma ser calibrar o alvo de saida.
- Se tomar muitas reversoes tardias, o ponto principal para revisar e a saida por tempo.

## Observacoes

- Esta estrategia roda em paralelo com as de `5m`, mas observa outro mercado.
- O resultado dela precisa ser comparado separadamente no painel e no banco, porque a janela e a dinamica sao diferentes.
- Como depende de saida antecipada, faz ainda mais sentido acompanhar `fills`, liquidez no bid e `time stop`.
