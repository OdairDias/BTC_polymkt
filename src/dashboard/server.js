import express from "express";
import cors from "cors";
import basicAuth from "express-basic-auth";
import { getAccountStats } from "../automation/accountInfo.js";

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
      res.json({
          ...dashboardState,
          account: stats
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
                  --text: #eaecef;
                  --primary: #f0b90b;
                  --red: #f6465d;
                  --green: #0ecb81;
                  --gray: #848e9c;
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
              .card h3 { color: var(--gray); font-size: 0.9rem; margin-top: 0; cursor: default; }
              .card .value { font-size: 2.2rem; font-weight: 700; color: var(--green); margin: 10px 0; }
              .card .value.small { font-size: 1.1rem; color: var(--text); white-space: normal; line-height: 1.4; }
              .card .detail { color: var(--gray); font-size: 0.85rem; }
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
                  <div class="value" id="portfolio">$ --.--</div>
                  <div class="detail" id="wallet">Address: --...--</div>
              </div>
              <div class="card">
                  <h3>Cash (USDC)</h3>
                  <div class="value" id="cash">$ --.--</div>
                  <div class="detail">Disponível para sniping</div>
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

          <div class="log-area" id="logs">
              <div class="log-line">> Painel iniciado. Aguardando conexão com o robô...</div>
          </div>

          <script>
            function formatCurrency(val) {
                return new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
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

                    if (d.timeLeft !== lastTime) {
                        const logs = document.getElementById('logs');
                        const line = document.createElement('div');
                        line.className = 'log-line';
                        line.innerHTML = '<span class="log-time">[' + d.timeLeft + ']</span> ' + d.activeMarket + ' | Balance: ' + formatCurrency(cashVal);
                        logs.prepend(line);
                        lastTime = d.timeLeft;
                        
                        // Manter apenas os últimos 50 logs para não pesar
                        while (logs.children.length > 50) logs.lastChild.remove();
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
