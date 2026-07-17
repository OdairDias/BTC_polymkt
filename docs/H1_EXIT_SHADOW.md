# H1 exit shadow research

A coorte `cheap_1h_exec_v2` continua sendo a baseline paper executável. O shadow de saída somente observa o lifecycle dessa coorte; ele não altera entradas, take profits, trailing stop, time stop, stake ou qualquer estado de execução.

A coleta prospectiva desta etapa usa a chave imutável `h1_exit_shadow_v1`. Mudanças futuras nas políticas exigem uma nova chave; não se deve reinterpretar silenciosamente a coorte v1.

## Dados coletados

Enquanto uma posição paper está aberta, o runtime tenta persistir um snapshot bucketizado a cada 15 segundos em `strategy_exit_shadow_snapshots`:

- bid observado e bid executável **modelado** após slippage/spread penalty;
- profundidade agregada observada e flag de liquidez suficiente no modelo paper;
- segundos para o encerramento;
- shares/notional restantes;
- nível de TP já alcançado e maior bid observado;
- PnL bruto, fees e PnL líquido caso o restante fosse fechado naquele snapshot;
- PnL já realizado em saídas parciais e PnL total contrafactual;
- commit e hash de configuração.

A persistência usa uma fila limitada e um pool Postgres dedicado com timeout curto. O tick apenas enfileira um payload imutável depois de concluir a decisão baseline; ele não aguarda I/O shadow. Falha, timeout ou fila cheia descartam o snapshot sem retry e não modificam nem interrompem o lifecycle da baseline.

A tabela shadow não faz parte de `ensureStrategySchemaOnce()`. Antes do primeiro cutover, execute separadamente `npm run migrate:h1-exit-shadow`; falha dessa migração bloqueia apenas a coleta shadow, não o startup da estratégia principal.

## Hipóteses iniciais

O relatório `npm run report:h1-exit-shadow` avalia:

- `time_stop_15m`;
- `time_stop_10m`;
- `max_loss_025`: saída modelada quando o PnL líquido total do trade atinge `−US$0,25`;
- `max_loss_040`: saída modelada quando o PnL líquido total do trade atinge `−US$0,40`.

Cada política usa apenas o primeiro **cruzamento observado** entre um snapshot anterior válido/não acionado e o primeiro snapshot posterior acionado. Se o primeiro snapshot válido já satisfizer a condição, a entrada é marcada `left_censored` e excluída das métricas daquela política. Snapshots sem bid modelado ou liquidez são contabilizados como não avaliáveis, não como “sem trigger”. TP/trailing continuam com prioridade causal no mesmo tick. Isso **não** equivale a VWAP ou fill real da venue; resultados paper não validam slippage, latência ou execução live.

## Cobertura e causalidade

Uma entrada só entra na comparação fechada quando:

- possui pelo menos dois snapshots;
- o primeiro snapshot chega até 45 segundos depois da entrada;
- não há gap superior a 45 segundos;
- o último snapshot está a no máximo 45 segundos da saída final;
- a baseline já possui saída final.

Os 16 trades anteriores à ativação não têm trajetória de book e não são retroativamente preenchidos. Não se deve reconstruir MAE/MFE ou stops alternativos apenas com entrada e saída final.

O status permanece `awaiting_shadow_samples` até pelo menos 30 entradas fechadas com cobertura completa. Esse marco permite investigação comparativa inicial, não promoção para live. Mudanças na baseline exigem estabilidade por vários dias/regimes e revisão específica; o ideal permanece 50–100 operações.
