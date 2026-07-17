#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/hermes/.hermes/node/bin:$PATH"
cd /home/hermes/projects/BTC_polymkt

LOCK_FILE="/tmp/btc-polymkt-paper.lock"

set -a
source /home/hermes/projects/BTC_polymkt/.env.vps.paper.local
set +a
export GIT_COMMIT="$(/usr/bin/git rev-parse HEAD)"

if ! /usr/bin/flock -n "$LOCK_FILE" /home/hermes/.hermes/node/bin/npm start; then
  echo "[run_vps_paper] another instance is already running (lock: $LOCK_FILE)" >&2
  exit 1
fi
