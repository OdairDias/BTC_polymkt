import express from "express";
import cors from "cors";
import basicAuth from "express-basic-auth";
import { getAccountStats } from "../automation/accountInfo.js";
import { getStrategyPool, getStrategyPerformanceReport } from "../db/postgresStrategy.js";
import { CONFIG } from "../config.js";

// Singleton to hold the bot's current status (populated from index.js)
export const dashboardState = {
  activeMarket: "Starting...",
  timeLeft: "--:--",
  targetPrice: 0.20,
  sniperArmed: false,
  lastSnapshotAt: new Date().toISOString(),
  latestTrade: null, // latest trade outcome if found
};

export function startDashboard(port) {
  const finalPort = Number(port) || 8080;
  const app = express();
  app.use(cors());
  app.use(express.json());
  const activeStrategyKeys = new Set(
    (Array.isArray(CONFIG.strategy.variants) ? CONFIG.strategy.variants : [])
      .filter((variant) => variant && variant.enabled !== false)
      .map((variant) => String(variant.key || "").trim())
      .filter(Boolean)
  );

  // Autenticação Básica
  app.use(basicAuth({
      users: { 'odair': 'Odair@dias78' },
      challenge: true,
      realm: 'Polymarket Dashboard',
  }));

  // 1. API: Account stats and current bot status
  app.get("/api/status", async (req, res) => {
    try {
      const stats = await getAccountStats();
      let strategyMetrics = [];
      try {
        const pool = getStrategyPool(CONFIG.strategy.databaseUrl);
        if (pool) {
          strategyMetrics = await getStrategyPerformanceReport(pool);
          if (activeStrategyKeys.size > 0) {
            strategyMetrics = strategyMetrics.filter((metric) => activeStrategyKeys.has(metric.strategy));
          }
        }
      } catch (poolErr) {
        console.error("Dashboard failed to fetch strategy stats", poolErr);
      }

      res.json({
          ...dashboardState,
          account: stats,
          strategies: strategyMetrics
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 2. Simple Dashboard (HTML)
  app.get("/", (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Polymarket BTC Dashboard</title>
          <style>
              :root {
                  --bg: #0b0e11;
                  --card: #1e2329;
                  --text: #ffffff;
                  --primary: #f0b90b;
                  --red: #f6465d;
                  --green: #0ecb81;
                  --gray: #848e9c;
                  --poly-blue: #3d88ff;
              }
              body {
                  font-family: 'Inter', system-ui, sans-serif;
                  background: var(--bg);
                  color: var(--text);
                  margin: 0;
                  padding: 20px;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
              }
              header {
                  width: 100%;
                  max-width: 900px;
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  padding: 10px 0;
                  border-bottom: 1px solid #333;
                  margin-bottom: 30px;
              }
              .logo { font-size: 1.5rem; font-weight: bold; color: var(--primary); }
              .dashboard {
                  display: grid;
                  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                  gap: 20px;
                  width: 100%;
                  max-width: 900px;
              }
              .card {
                  background: var(--card);
                  padding: 20px;
                  border-radius: 12px;
                  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                  border: 1px solid #333;
              }
              .card h3 { color: var(--poly-blue); font-size: 0.95rem; font-weight: 500; margin-top: 0; margin-bottom: 8px; cursor: default; }
              .card .value { font-size: 2.2rem; font-weight: 700; color: var(--green); margin: 0; }
              .card .value.small { font-size: 1.1rem; color: var(--text); white-space: normal; line-height: 1.4; }
              .card .detail { color: var(--gray); font-size: 0.8rem; margin-top: 5px; }
              .status-pill {
                  padding: 4px 12px;
                  border-radius: 20px;
                  font-size: 0.75rem;
                  font-weight: bold;
                  background: var(--gray);
                  color: white;
              }
              .status-pill.active { background: #2b3139; color: var(--green); border: 1px solid var(--green); }
              .status-pill.armed { background: var(--primary); color: black; animation: pulse 1.5s infinite; }
              @keyframes pulse {
                  0% { opacity: 1; }
                  50% { opacity: 0.6; }
                  100% { opacity: 1; }
              }
              .log-area {
                  font-family: 'Consolas', monospace;
                  background: #000;
                  padding: 15px;
                  border-radius: 8px;
                  color: #0dcaf0;
                  font-size: 0.85rem;
                  margin-top: 20px;
                  width: 100%;
                  max-width: 900px;
                  height: 250px;
                  overflow-y: auto;
                  border: 1px solid #333;
                  line-height: 1.5;
              }
              .log-line { border-bottom: 1px solid #111; padding: 2px 0; }
              .log-time { color: var(--gray); margin-right: 10px; }
              .refresh-btn {
                  background: var(--primary);
                  border: none;
                  padding: 8px 20px;
                  border-radius: 6px;
                  font-weight: bold;
                  cursor: pointer;
                  transition: transform 0.1s;
              }
              .refresh-btn:active { transform: scale(0.95); }
              .table-card {
                  background: var(--card);
                  padding: 20px;
                  border-radius: 12px;
                  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                  border: 1px solid #333;
                  width: 100%;
                  max-width: 900px;
                  margin-top: 20px;
                  overflow-x: auto;
              }
              .table-card h3 { color: var(--poly-blue); font-size: 1.1rem; font-weight: 500; margin-top: 0; margin-bottom: 15px; }
              table {
                  width: 100%;
                  border-collapse: collapse;
                  text-align: left;
              }
              th {
                  color: var(--gray);
                  font-size: 0.85rem;
                  font-weight: 500;
                  padding: 10px;
                  border-bottom: 1px solid #333;
              }
              td {
                  padding: 12px 10px;
                  border-bottom: 1px solid #222;
                  font-size: 0.95rem;
              }
              tr:last-child td { border-bottom: none; }
              .pnl-pos { color: var(--green); font-weight: bold; }
              .pnl-neg { color: var(--red); font-weight: bold; }
          </style>
      </head>
      <body>
          <header>
              <div class="logo">Polymarket BTC Sniper</div>
              <button class="refresh-btn" onclick="update()">Refresh Now</button>
          </header>

          <div class="dashboard">
              <div class="card">
                  <h3>Portfolio</h3>
                  <div class="value" id="portfolio">--</div>
                  <div class="detail" id="wallet">Wallet: --</div>
              </div>
              <div class="card">
                  <h3>Cash</h3>
                  <div class="value" id="cash">--</div>
                  <div class="detail">Disponível para sniping (USDC)</div>
              </div>
              <div class="card">
                  <h3>Posições em Aberto</h3>
                  <div class="value" id="positionsStatus">Inativo</div>
                  <div class="detail" id="positionsCount">Nenhuma ordem ativa</div>
              </div>
              <div class="card">
                  <h3>Status Atual</h3>
                  <div class="value small" id="activeMarket">Aguardando mercado...</div>
                  <div style="margin-top:15px; display:flex; align-items:center; gap:10px;">
                    <span id="timeLeft" style="font-weight:bold; font-family:monospace;">--:--</span>
                    <span id="statusPill" class="status-pill">Idle</span>
                  </div>
              </div>
          </div>

          <div class="table-card">
              <h3>Placar das Estratégias (A/B Testing)</h3>
              <table>
                  <thead>
                      <tr>
                          <th>Estratégia</th>
                          <th>Entradas</th>
                          <th>Acertos</th>
                          <th>Erros</th>
                          <th style="text-align:right">PnL Simulado ($)</th>
                      </tr>
                  </thead>
                  <tbody id="strategyTbody">
                      <tr><td colspan="5" style="text-align:center; color:var(--gray)">Carregando...</td></tr>
                  </tbody>
              </table>
          </div>

          <script>
            function formatCurrency(val) {
                return new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                }).format(val);
            }

            let lastTime = "";

            async function update() {
                try {
                    const res = await fetch('/api/status');
                    if (res.status === 401) { location.reload(); return; }
                    const d = await res.json();
                    
                    const cashVal = d.account?.cash || 0;
                    const portVal = d.account?.portfolio || 0;

                    document.getElementById('portfolio').innerText = formatCurrency(portVal);
                    document.getElementById('cash').innerText = formatCurrency(cashVal);
                    document.getElementById('wallet').innerText = 'Wallet: ' + (d.account?.address || '--').slice(0, 10) + '...';
                    document.getElementById('activeMarket').innerText = d.activeMarket || "Sem mercado ativo";
                    document.getElementById('timeLeft').innerText = d.timeLeft;
                    
                    const pill = document.getElementById('statusPill');
                    if (d.sniperArmed) {
                        pill.innerText = 'SNIPER ARMED';
                        pill.className = 'status-pill armed';
                    } else {
                        pill.innerText = 'SCANNING';
                        pill.className = 'status-pill active';
                    }

                    const posEl = document.getElementById('positionsStatus');
                    const hasPos = d.account?.hasOpenPositions;
                    if (hasPos) {
                        posEl.innerText = 'ATIVO';
                        posEl.style.color = 'var(--poly-blue)';
                        document.getElementById('positionsCount').innerText = d.account.openPositionsCount + ' mercado(s) em aberto';
                    } else {
                        posEl.innerText = 'INATIVO';
                        posEl.style.color = 'var(--gray)';
                        document.getElementById('positionsCount').innerText = 'Nenhuma posição ativa';
                    }

                    const tbody = document.getElementById('strategyTbody');
                    if (d.strategies && d.strategies.length > 0) {
                        tbody.innerHTML = '';
                        d.strategies.forEach(st => {
                            const tr = document.createElement('tr');
                            const pnlClass = st.pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
                            const pnlFmt = (st.pnl >= 0 ? '+' : '') + formatCurrency(st.pnl);
                            tr.innerHTML = \`
                                <td><strong style="color:var(--text)">\${st.strategy}</strong></td>
                                <td>\${st.entries}</td>
                                <td style="color:var(--green)">\${st.wins}</td>
                                <td style="color:var(--red)">\${st.losses}</td>
                                <td style="text-align:right" class="\${pnlClass}">\${pnlFmt}</td>
                            \`;
                            tbody.appendChild(tr);
                        });
                    } else {
                        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--gray)">Nenhum resultado registrado ainda.</td></tr>';
                    }
                } catch(e) {
                    console.error('Falha no update:', e);
                }
            }
            setInterval(update, 5000);
            update();
          </script>
      </body>
      </html>
    `);
  });

  const server = app.listen(finalPort, "0.0.0.0", () => {
    console.log(`[DASHBOARD] Web Server rodando na porta ${finalPort}`);
  });
  
  return server;
}
