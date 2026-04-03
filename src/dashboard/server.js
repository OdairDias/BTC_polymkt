import express from "express";
import cors from "cors";
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
  const finalPort = Number(port) || 9090;
  const app = express();
  app.use(cors());
  app.use(express.json());

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
                  border-bottom: 1px solid var(--gray);
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
              .card .value { font-size: 2rem; font-weight: 700; color: var(--green); margin: 10px 0; }
              .card .value.small { font-size: 1.2rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
              .card .detail { color: var(--gray); font-size: 0.85rem; }
              .market-info {
                  grid-column: 1 / -1;
              }
              .status-pill {
                  padding: 4px 12px;
                  border-radius: 20px;
                  font-size: 0.75rem;
                  background: var(--gray);
                  color: white;
              }
              .status-pill.active { background: var(--green); }
              .status-pill.armed { background: var(--primary); color: black; animation: pulse 1.5s infinite; }
              @keyframes pulse {
                  0% { opacity: 1; }
                  50% { opacity: 0.5; }
                  100% { opacity: 1; }
              }
              .log-area {
                  font-family: monospace;
                  background: black;
                  padding: 15px;
                  border-radius: 8px;
                  color: #00ff00;
                  font-size: 0.8rem;
                  margin-top: 20px;
                  width: 100%;
                  max-width: 900px;
                  height: 150px;
                  overflow-y: auto;
              }
              .refresh-btn {
                  background: var(--primary);
                  border: none;
                  padding: 8px 16px;
                  border-radius: 6px;
                  font-weight: bold;
                  cursor: pointer;
                  transition: opacity 0.2s;
              }
              .refresh-btn:hover { opacity: 0.8; }
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
                  <div class="detail">Available for sniper</div>
              </div>
              <div class="card">
                  <h3>Status Atual</h3>
                  <div class="value small" id="activeMarket">Loading...</div>
                  <div class="detail">
                    <span id="timeLeft">--:--</span> | 
                    <span id="statusPill" class="status-pill">Idle</span>
                  </div>
              </div>
          </div>

          <div class="log-area" id="logs">
              > Dashboard initialized...
          </div>

          <script>
            async function update() {
                try {
                    const res = await fetch('/api/status');
                    const d = await res.json();
                    
                    document.getElementById('portfolio').innerText = '$' + (d.account?.portfolio || 0).toFixed(2);
                    document.getElementById('cash').innerText = '$' + (d.account?.cash || 0).toFixed(2);
                    document.getElementById('wallet').innerText = 'Wallet: ' + (d.account?.address || '--').slice(0, 10) + '...';
                    document.getElementById('activeMarket').innerText = d.activeMarket;
                    document.getElementById('timeLeft').innerText = d.timeLeft;
                    
                    const pill = document.getElementById('statusPill');
                    if (d.sniperArmed) {
                        pill.innerText = 'ARMED';
                        pill.className = 'status-pill armed';
                    } else {
                        pill.innerText = 'SCANNING';
                        pill.className = 'status-pill active';
                    }

                    // Add a log line if change detected
                    const logs = document.getElementById('logs');
                    const line = document.createElement('div');
                    line.innerText = '> ' + d.timeLeft + ' | ' + d.activeMarket + ' | P: ' + (d.account?.cash || 0).toFixed(2);
                    logs.prepend(line);
                } catch(e) {
                    console.error('Update fail', e);
                }
            }
            setInterval(update, 5000); // 5 segundos
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
