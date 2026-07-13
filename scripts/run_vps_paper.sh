#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/hermes/.hermes/node/bin:$PATH"
cd /home/hermes/projects/BTC_polymkt
set -a
source /home/hermes/projects/BTC_polymkt/.env.vps.paper.local
set +a
exec /home/hermes/.hermes/node/bin/npm start
