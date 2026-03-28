# Polymarket BTC 5m Assistant

A real-time console trading assistant for Polymarket **"Bitcoin Up or Down" 5-minute** markets.

It combines:
- Polymarket market selection + UP/DOWN prices + liquidity
- Polymarket live WS **Chainlink BTC/USD CURRENT PRICE** (same feed shown on the Polymarket UI)
- Fallback to on-chain Chainlink (Polygon) via HTTP/WSS RPC
- Binance spot price for reference
- Short-term TA snapshot (Heiken Ashi, RSI, MACD, VWAP, Delta 1/3m)
- A simple live **Predict (LONG/SHORT %)** derived from the assistant’s current TA scoring

## Requirements

- Node.js **20.10+** (exigido por `@polymarket/clob-client`; https://nodejs.org)
- npm (comes with Node)


## Run from terminal (step-by-step)

### 1) Clone the repository

```bash
git clone https://github.com/oGabrielFreitas/PolymarketBTC15mAssistant.git
```

Then open a terminal in the project folder.

### 2) Install dependencies

```bash
npm install
```

### 3) Environment variables (recommended)

Configuration uses **`src/config.js`** defaults (BTC 5m, estratégia paper ligada, etc.). **Variáveis de ambiente** (Railway ou `.env`) sobrescrevem esses valores. A única variável que o Railway **precisa** fornecer para o Postgres é **`DATABASE_URL`** (não coloque isso no código). O app carrega **`.env`** automaticamente se existir (via [`dotenv`](https://github.com/motdotla/dotenv)).

1. Copy the example file:

   ```bash
   copy .env.example .env
   ```
   (On macOS/Linux: `cp .env.example .env`)

2. Edit `.env` if needed. Defaults target **BTC 5m** (`POLYMARKET_SERIES_ID=10684`, `POLYMARKET_SERIES_SLUG=btc-up-or-down-5m`).

You can still export variables in the shell instead of using `.env`; see below for Polygon RPC (optional but recommended for Chainlink fallback).

#### Windows PowerShell (current terminal session)

```powershell
$env:POLYGON_RPC_URL = "https://polygon-rpc.com"
$env:POLYGON_RPC_URLS = "https://polygon-rpc.com,https://rpc.ankr.com/polygon"
$env:POLYGON_WSS_URLS = "wss://polygon-bor-rpc.publicnode.com"
```

Optional Polymarket settings:

```powershell
$env:POLYMARKET_AUTO_SELECT_LATEST = "true"
# $env:POLYMARKET_SLUG = "btc-updown-5m-..."   # pin a specific market
```

#### Windows CMD (current terminal session)

```cmd
set POLYGON_RPC_URL=https://polygon-rpc.com
set POLYGON_RPC_URLS=https://polygon-rpc.com,https://rpc.ankr.com/polygon
set POLYGON_WSS_URLS=wss://polygon-bor-rpc.publicnode.com
```

Optional Polymarket settings:

```cmd
set POLYMARKET_AUTO_SELECT_LATEST=true
REM set POLYMARKET_SLUG=btc-updown-5m-...
```

Notes:
- Variables set only in the shell apply to that terminal window.
- Using `.env` keeps **5m** (or custom) settings between sessions.

## Configuration

### Polymarket

- `POLYMARKET_AUTO_SELECT_LATEST` (default: `true`)
  - When `true`, automatically picks the latest market for the configured series.
- `POLYMARKET_SERIES_ID` (default: `10684` for **BTC 5m**)
- `POLYMARKET_SERIES_SLUG` (default: `btc-up-or-down-5m`)
- `POLYMARKET_SLUG` (optional)
  - If set, the assistant targets that specific market slug.
- `POLYMARKET_LIVE_WS_URL` (default: `wss://ws-live-data.polymarket.com`)
- `CANDLE_WINDOW_MINUTES` (default: `5`)
  - Should match the market timeframe (use `15` if you point the series to 15m markets).

### Paper strategy (Postgres, dry run)

Opcional: gravar **uma decisão simulada por mercado** quando o relógio **entra** na última janela de N minutos antes do `endDate` (padrão **2 min**). Compara **mid** do book UP vs DOWN (`(bid+ask)/2`, ou fallback no preço buy); o maior vence; empate (dentro de `STRATEGY_PRICE_EPSILON`) → `SKIP_TIE`. Notional padrão **US$ 1** simulado.

- `STRATEGY_ENABLED` (default no código: `true`) — desligue com `false` se não quiser estratégia/DB.
- `DATABASE_URL` — connection string Postgres (ex.: Railway **Variables** → plugin Postgres).
- `STRATEGY_DRY_RUN` (default: `true`) — `false` grava `dry_run=false` na entrada e **habilita** envio CLOB se `STRATEGY_LIVE_ARMED=true`.
- `STRATEGY_LIVE_ARMED` (default: `false`) — **tem de ser `true`** para enviar ordem real (além de `STRATEGY_DRY_RUN=false` e `POLYMARKET_PRIVATE_KEY`).
- `STRATEGY_ENTRY_MINUTES_LEFT` (default: `2`) — janela: `0 < tempo_restante_min <= N`.
- `STRATEGY_PRICE_EPSILON` (default: `0.001`) — empate se `|up_mid - down_mid| <= epsilon`.
- `STRATEGY_NOTIONAL_USD` (default: `1`).
- `STRATEGY_OUTCOME_LAST_SECONDS` (default: `5`) — ao **entrar** na janela final (tempo restante ≤ N segundos e > 0), grava o resultado na segunda tabela.

**Tabelas Postgres** (criadas no primeiro uso; ver `db/schema.sql`):

1. **`strategy_paper_signals`** — entrada paper (uma linha por `market_slug`).
2. **`strategy_paper_outcomes`** — resultado inferido pelos **mids UP/DOWN** nessa janela final; liga em `entry_id`; calcula `entry_correct` e `pnl_simulated_usd` quando houve lado UP/DOWN na entrada.
3. **`strategy_live_orders`** — tentativa de ordem **real** no CLOB (uma por `entry_id`): `status` `SUBMITTED` ou `ERROR`, `clob_order_id`, `raw_response`.

### Conta real no CLOB (preparação)

Usa [`@polymarket/clob-client`](https://www.npmjs.com/package/@polymarket/clob-client): ordem **BUY mercado FOK** (`createAndPostMarketOrder`) — gasta até **`STRATEGY_NOTIONAL_USD`** em USDC com teto de preço = buy do snapshot (tick), alinhado à validação CLOB de “market buy”. O cliente usa **`useServerTime=true`** para alinhar timestamps L2 ao servidor. O cabeçalho **`POLY_ADDRESS`** nas rotas L2 deve ser a **EOA** da API key (comportamento oficial); forçar o endereço do proxy aí faz a API responder *order signer address has to be the address of the API KEY*.

**Checklist antes de ligar:**

1. **Colateral CLOB** — o endpoint `getBalanceAllowance` tem de mostrar saldo &gt; 0 para `COLLATERAL`. Se nos logs aparece `collateral balance=0`, o CLOB **não** vê USDC disponível para a combinação (assinante + funder) que estás a usar.
2. **`POLYMARKET_PRIVATE_KEY`** — chave **EOA** em hex (64 caracteres). Assina ordens e deriva credenciais L2.
3. **Proxy Polymarket (muito comum com Phantom / conta “normal” no site)** — o saldo pode estar na **carteira proxy** do perfil, não na EOA. Nesse caso define **`POLYMARKET_SIGNATURE_TYPE=1`** e **`POLYMARKET_FUNDER_ADDRESS=`** o endereço **`0x…` do perfil** (o mesmo que mostra “Address” nas definições). Sem isto, o CLOB continua com `balance: 0` mesmo com fundos visíveis no site. Referência alinhada ao fluxo de ordens do guia [Polymarket BTC 5m bot (gist)](https://gist.github.com/Archetapp/7680adabc48f812a561ca79d73cbac69) (`POLY_SIGNATURE_TYPE=1`, `POLY_FUNDER_ADDRESS`).
4. **EOA pura** — se negocias só com uma carteira onde o USDC está **on-chain nesse mesmo `0x`**, usa **`POLYMARKET_SIGNATURE_TYPE=0`** e deixa **`POLYMARKET_FUNDER_ADDRESS`** vazio. USDC na Polygon (muitas vezes **USDC.e**) + **allowance** aos contratos da exchange, como na [documentação de pré-requisitos](https://docs.polymarket.com/developers/CLOB/orders/create-order).
5. `STRATEGY_DRY_RUN=false` **e** `STRATEGY_LIVE_ARMED=true` — as duas; sem isso **não** envia ordem.
6. Railway: **Node 20+** no serviço (`engines` no `package.json`).
7. **Relayer / Builder API (opcional)** — se criaste chave em *Settings → Relayer API Keys* (ou Builder), define `RELAYER_API_KEY_ADDRESS` e **secret + passphrase**: ou variáveis `RELAYER_API_SECRET` e `RELAYER_API_PASSPHRASE`, ou `RELAYER_API_KEY` como JSON `{"secret":"...","passphrase":"..."}`. O `clob-client` usa isto como `BuilderConfig` e envia cabeçalhos `POLY_BUILDER_*` no `postOrder`. Isto **não substitui** `POLYMARKET_PRIVATE_KEY` nem o fluxo L2; pode ou não afetar erros do tipo *invalid signature* — vale testar se o suporte Polymarket indicar esse fluxo.

**Nota (mínimos):** em alguns mercados o Polymarket exige **tamanho mínimo** de ordem (o gist menciona ~5 shares em certos casos). Com `STRATEGY_NOTIONAL_USD=1` e token a ~0,9$, isso pode ficar abaixo do mínimo — se após resolver o saldo aparecer erro de tamanho mínimo, aumenta o notional.

Documentação oficial: [CLOB — Create order](https://docs.polymarket.com/developers/CLOB/orders/create-order), [Authentication](https://docs.polymarket.com/developers/CLOB/authentication).

**Railway:** crie um serviço Postgres, copie `DATABASE_URL` para o app, `npm start` como comando.

### Descobrir `series_id` e slug para outro timeframe (ex.: 5m → 15m)

1. No site do Polymarket, abra a série desejada e copie o **slug** da série (ex.: `btc-up-or-down-5m`).
2. Consulte a API Gamma, por exemplo:  
   `https://gamma-api.polymarket.com/series?slug=SEU-SLUG`  
   No JSON, use o campo **`id`** da série como `POLYMARKET_SERIES_ID` (ex.: `10684` para 5m).
3. Salve `POLYMARKET_SERIES_SLUG` e `POLYMARKET_SERIES_ID` no `.env` e rode `npm start` de novo.

### Chainlink on Polygon (fallback)

- `CHAINLINK_BTC_USD_AGGREGATOR`
  - Default: `0xc907E116054Ad103354f2D350FD2514433D57F6f`

HTTP RPC:
- `POLYGON_RPC_URL` (default: `https://polygon-rpc.com`)
- `POLYGON_RPC_URLS` (optional, comma-separated)
  - Example: `https://polygon-rpc.com,https://rpc.ankr.com/polygon`

WSS RPC (optional but recommended for more real-time fallback):
- `POLYGON_WSS_URL` (optional)
- `POLYGON_WSS_URLS` (optional, comma-separated)

### Proxy support

The bot supports HTTP(S) proxies for both HTTP requests (fetch) and WebSocket connections.

Supported env vars (standard):

- `HTTPS_PROXY` / `https_proxy`
- `HTTP_PROXY` / `http_proxy`
- `ALL_PROXY` / `all_proxy`

Examples:

PowerShell:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:8080"
# or
$env:ALL_PROXY = "socks5://127.0.0.1:1080"
```

CMD:

```cmd
set HTTPS_PROXY=http://127.0.0.1:8080
REM or
set ALL_PROXY=socks5://127.0.0.1:1080
```

#### Proxy with username + password (simple guide)

1) Take your proxy host and port (example: `1.2.3.4:8080`).

2) Add your login and password in the URL:

- HTTP/HTTPS proxy:
  - `http://USERNAME:PASSWORD@HOST:PORT`
- SOCKS5 proxy:
  - `socks5://USERNAME:PASSWORD@HOST:PORT`

3) Set it in the terminal and run the bot.

PowerShell:

```powershell
$env:HTTPS_PROXY = "http://USERNAME:PASSWORD@HOST:PORT"
npm start
```

CMD:

```cmd
set HTTPS_PROXY=http://USERNAME:PASSWORD@HOST:PORT
npm start
```

Important: if your password contains special characters like `@` or `:` you must URL-encode it.

Example:

- password: `p@ss:word`
- encoded: `p%40ss%3Aword`
- proxy URL: `http://user:p%40ss%3Aword@1.2.3.4:8080`

## Run

```bash
npm start
```

### Stop

Press `Ctrl + C` in the terminal.

### Update to latest version

```bash
git pull
npm install
npm start
```

## Notes / Troubleshooting

- If you see no Chainlink updates:
  - Polymarket WS might be temporarily unavailable. The bot falls back to Chainlink on-chain price via Polygon RPC.
  - Ensure at least one working Polygon RPC URL is configured.
- If the console looks like it “spams” lines:
  - The renderer uses `readline.cursorTo` + `clearScreenDown` for a stable, static screen, but some terminals may still behave differently.

## Safety

This is not financial advice. Use at your own risk.

created by @krajekis
