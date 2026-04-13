import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

function parseArgs(argv) {
  const out = {
    days: 30,
    strategy: null,
    testHours: 24,
    minTrainTrades: 120,
    minFoldTrades: 10,
    minCandidateTrades: 20,
    json: false
  };
  for (const arg of argv) {
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg.startsWith("--days=")) {
      const n = Number(arg.slice("--days=".length));
      if (Number.isFinite(n) && n > 0) out.days = Math.max(1, Math.floor(n));
      continue;
    }
    if (arg.startsWith("--strategy=")) {
      const key = String(arg.slice("--strategy=".length)).trim();
      out.strategy = key || null;
      continue;
    }
    if (arg.startsWith("--test-hours=")) {
      const n = Number(arg.slice("--test-hours=".length));
      if (Number.isFinite(n) && n > 0) out.testHours = Math.max(1, Math.floor(n));
      continue;
    }
    if (arg.startsWith("--min-train-trades=")) {
      const n = Number(arg.slice("--min-train-trades=".length));
      if (Number.isFinite(n) && n > 0) out.minTrainTrades = Math.max(20, Math.floor(n));
      continue;
    }
    if (arg.startsWith("--min-fold-trades=")) {
      const n = Number(arg.slice("--min-fold-trades=".length));
      if (Number.isFinite(n) && n > 0) out.minFoldTrades = Math.max(1, Math.floor(n));
      continue;
    }
    if (arg.startsWith("--min-candidate-trades=")) {
      const n = Number(arg.slice("--min-candidate-trades=".length));
      if (Number.isFinite(n) && n > 0) out.minCandidateTrades = Math.max(5, Math.floor(n));
      continue;
    }
  }
  return out;
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fmt(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

function fmtPct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtMoney(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(digits)}`;
}

function printTable({ title, rows, columns }) {
  if (title) console.log(`\n=== ${title} ===`);
  if (!rows.length) {
    console.log("(sem dados)");
    return;
  }
  const widths = columns.map((col) => {
    const headerW = col.label.length;
    const bodyW = rows.reduce((acc, row) => {
      const raw = typeof col.render === "function" ? col.render(row) : row[col.key];
      return Math.max(acc, String(raw ?? "-").length);
    }, 0);
    return Math.max(headerW, bodyW);
  });
  console.log(columns.map((c, i) => c.label.padEnd(widths[i])).join(" | "));
  console.log(columns.map((_, i) => "-".repeat(widths[i])).join("-+-"));
  for (const row of rows) {
    console.log(
      columns
        .map((c, i) => {
          const raw = typeof c.render === "function" ? c.render(row) : row[c.key];
          return String(raw ?? "-").padEnd(widths[i]);
        })
        .join(" | ")
    );
  }
}

function calcMetrics(rows) {
  if (!rows.length) {
    return {
      trades: 0,
      totalPnl: 0,
      evPerTrade: null,
      hitRate: null,
      brier: null,
      avgEdge: null,
      avgPredProb: null
    };
  }
  let totalPnl = 0;
  let wins = 0;
  let brierSum = 0;
  let brierCount = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  let predSum = 0;
  let predCount = 0;
  for (const r of rows) {
    const pnl = toNum(r.pnl);
    const y = toNum(r.y);
    const pred = toNum(r.predictedProb);
    const edge = toNum(r.edgeValue);
    if (pnl != null) totalPnl += pnl;
    if (y != null) wins += y > 0.5 ? 1 : 0;
    if (pred != null && y != null) {
      brierSum += (pred - y) ** 2;
      brierCount += 1;
    }
    if (edge != null) {
      edgeSum += edge;
      edgeCount += 1;
    }
    if (pred != null) {
      predSum += pred;
      predCount += 1;
    }
  }
  return {
    trades: rows.length,
    totalPnl,
    evPerTrade: rows.length ? totalPnl / rows.length : null,
    hitRate: rows.length ? wins / rows.length : null,
    brier: brierCount ? brierSum / brierCount : null,
    avgEdge: edgeCount ? edgeSum / edgeCount : null,
    avgPredProb: predCount ? predSum / predCount : null
  };
}

function filterByThresholds(rows, { minEdge, minProb }) {
  return rows.filter((r) => {
    const edge = toNum(r.edgeValue);
    const prob = toNum(r.predictedProb);
    if (edge == null || prob == null) return false;
    return edge >= minEdge && prob >= minProb;
  });
}

function quantile(values, q) {
  const nums = values.map(toNum).filter((n) => n != null).sort((a, b) => a - b);
  if (!nums.length) return null;
  if (q <= 0) return nums[0];
  if (q >= 1) return nums[nums.length - 1];
  const pos = (nums.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = nums[base + 1] ?? nums[base];
  return nums[base] + rest * (next - nums[base]);
}

function buildEdgeGrid(trainRows) {
  const base = [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08];
  const q20 = quantile(trainRows.map((r) => r.edgeValue), 0.2);
  const q40 = quantile(trainRows.map((r) => r.edgeValue), 0.4);
  const q60 = quantile(trainRows.map((r) => r.edgeValue), 0.6);
  const q80 = quantile(trainRows.map((r) => r.edgeValue), 0.8);
  const merged = [...base, q20, q40, q60, q80]
    .map((n) => toNum(n))
    .filter((n) => n != null && n >= 0)
    .map((n) => Number(n.toFixed(4)));
  return Array.from(new Set(merged)).sort((a, b) => a - b);
}

function optimizeThresholds(trainRows, { minCandidateTrades }) {
  const probGrid = [];
  for (let p = 0.5; p <= 0.75; p += 0.01) {
    probGrid.push(Number(p.toFixed(2)));
  }
  const edgeGrid = buildEdgeGrid(trainRows);

  let best = null;
  for (const minProb of probGrid) {
    for (const minEdge of edgeGrid) {
      const sample = filterByThresholds(trainRows, { minEdge, minProb });
      if (sample.length < minCandidateTrades) continue;
      const m = calcMetrics(sample);
      const score = toNum(m.evPerTrade) ?? Number.NEGATIVE_INFINITY;
      if (!best) {
        best = { minEdge, minProb, score, ...m };
        continue;
      }
      if (score > best.score) {
        best = { minEdge, minProb, score, ...m };
        continue;
      }
      if (score === best.score && (m.totalPnl ?? 0) > (best.totalPnl ?? 0)) {
        best = { minEdge, minProb, score, ...m };
      }
    }
  }
  if (best) return best;
  return {
    minEdge: 0,
    minProb: 0.5,
    score: Number.NEGATIVE_INFINITY,
    ...calcMetrics(trainRows)
  };
}

function buildWalkForwardFolds(rows, { testHours, minTrainTrades, minFoldTrades, minCandidateTrades }) {
  if (rows.length < minTrainTrades + minFoldTrades) return [];
  const testMs = testHours * 60 * 60 * 1000;
  const firstFoldStart = rows[minTrainTrades - 1].createdAtMs;
  const lastTs = rows[rows.length - 1].createdAtMs;
  const folds = [];

  for (let foldStart = firstFoldStart; foldStart <= lastTs; foldStart += testMs) {
    const foldEnd = foldStart + testMs;
    const train = rows.filter((r) => r.createdAtMs < foldStart);
    const test = rows.filter((r) => r.createdAtMs >= foldStart && r.createdAtMs < foldEnd);
    if (train.length < minTrainTrades || test.length < minFoldTrades) continue;

    const tuned = optimizeThresholds(train, { minCandidateTrades });
    const baseline = calcMetrics(test);
    const selected = calcMetrics(
      filterByThresholds(test, { minEdge: tuned.minEdge, minProb: tuned.minProb })
    );
    folds.push({
      foldStartIso: new Date(foldStart).toISOString(),
      foldEndIso: new Date(foldEnd).toISOString(),
      trainTrades: train.length,
      testTrades: test.length,
      tunedMinEdge: tuned.minEdge,
      tunedMinProb: tuned.minProb,
      baseline,
      selected
    });
  }
  return folds;
}

function aggregateFoldMetric(folds, key) {
  let trades = 0;
  let totalPnl = 0;
  let weightedHit = 0;
  let weightedBrier = 0;
  let brierTrades = 0;
  for (const f of folds) {
    const m = f[key];
    const t = Number(m?.trades) || 0;
    if (!t) continue;
    trades += t;
    totalPnl += Number(m?.totalPnl) || 0;
    if (toNum(m?.hitRate) != null) weightedHit += t * Number(m.hitRate);
    if (toNum(m?.brier) != null) {
      weightedBrier += t * Number(m.brier);
      brierTrades += t;
    }
  }
  return {
    trades,
    totalPnl,
    evPerTrade: trades ? totalPnl / trades : null,
    hitRate: trades ? weightedHit / trades : null,
    brier: brierTrades ? weightedBrier / brierTrades : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) {
    console.error("ERRO: DATABASE_URL ausente.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 10_000
  });

  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT
        s.created_at,
        s.strategy_key,
        COALESCE(
          s.selected_model_prob,
          CASE
            WHEN s.chosen_side = 'UP' THEN s.model_prob_up
            WHEN s.chosen_side = 'DOWN' AND s.model_prob_up IS NOT NULL THEN 1 - s.model_prob_up
            ELSE NULL
          END
        )::float8 AS predicted_prob,
        COALESCE(
          s.selected_edge,
          CASE
            WHEN s.chosen_side = 'UP' AND s.model_prob_up IS NOT NULL AND s.market_prob_up IS NOT NULL
              THEN s.model_prob_up - s.market_prob_up
            WHEN s.chosen_side = 'DOWN' AND s.model_prob_up IS NOT NULL AND s.market_prob_up IS NOT NULL
              THEN (1 - s.model_prob_up) - (1 - s.market_prob_up)
            ELSE NULL
          END
        )::float8 AS edge_value,
        o.pnl_simulated_usd::float8 AS pnl,
        CASE
          WHEN o.entry_correct IS TRUE THEN 1.0
          WHEN o.entry_correct IS FALSE THEN 0.0
          ELSE NULL
        END::float8 AS y
      FROM strategy_paper_signals s
      JOIN strategy_paper_outcomes o ON o.entry_id = s.id
      WHERE s.created_at >= NOW() - ($1::text || ' days')::interval
        AND s.chosen_side IN ('UP', 'DOWN')
        AND o.entry_correct IS NOT NULL
        AND o.pnl_simulated_usd IS NOT NULL
        AND ($2::text IS NULL OR s.strategy_key = $2)
      ORDER BY s.created_at ASC
      `,
      [String(args.days), args.strategy]
    );

    const rows = res.rows
      .map((r) => {
        const ts = new Date(r.created_at).getTime();
        return {
          strategyKey: String(r.strategy_key || "default"),
          createdAtMs: Number.isFinite(ts) ? ts : null,
          predictedProb: toNum(r.predicted_prob),
          edgeValue: toNum(r.edge_value),
          pnl: toNum(r.pnl),
          y: toNum(r.y)
        };
      })
      .filter((r) => r.createdAtMs != null && r.predictedProb != null && r.edgeValue != null && r.pnl != null && r.y != null);

    if (!rows.length) {
      console.log("Sem dados suficientes para walk-forward.");
      return;
    }

    const folds = buildWalkForwardFolds(rows, {
      testHours: args.testHours,
      minTrainTrades: args.minTrainTrades,
      minFoldTrades: args.minFoldTrades,
      minCandidateTrades: args.minCandidateTrades
    });

    const baselineAgg = aggregateFoldMetric(folds, "baseline");
    const selectedAgg = aggregateFoldMetric(folds, "selected");
    const upliftEv =
      toNum(selectedAgg.evPerTrade) != null && toNum(baselineAgg.evPerTrade) != null
        ? selectedAgg.evPerTrade - baselineAgg.evPerTrade
        : null;

    const payload = {
      meta: {
        generated_at: new Date().toISOString(),
        strategy_filter: args.strategy,
        days: args.days,
        test_hours: args.testHours,
        min_train_trades: args.minTrainTrades,
        min_fold_trades: args.minFoldTrades,
        min_candidate_trades: args.minCandidateTrades,
        source_rows: rows.length,
        folds: folds.length
      },
      aggregate: {
        baseline: baselineAgg,
        selected: selectedAgg,
        uplift_ev_per_trade: upliftEv
      },
      folds
    };

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log("Walk-forward OOS - Estrategia");
    console.log(`Estrategia: ${args.strategy ?? "todas"}`);
    console.log(`Janela historica: ${args.days} dias | Fold de teste: ${args.testHours}h`);
    console.log(`Rows: ${rows.length} | Folds validos: ${folds.length}`);

    printTable({
      title: "Agregado OOS",
      rows: [
        {
          mode: "baseline",
          ...baselineAgg
        },
        {
          mode: "selected",
          ...selectedAgg
        }
      ],
      columns: [
        { key: "mode", label: "mode" },
        { key: "trades", label: "trades" },
        { key: "evPerTrade", label: "ev_trade", render: (r) => fmtMoney(r.evPerTrade, 5) },
        { key: "totalPnl", label: "total_pnl", render: (r) => fmtMoney(r.totalPnl, 5) },
        { key: "hitRate", label: "hit_rate", render: (r) => fmtPct(r.hitRate, 2) },
        { key: "brier", label: "brier", render: (r) => fmt(r.brier, 6) }
      ]
    });

    console.log(`\nUplift EV/trade (selected - baseline): ${fmtMoney(upliftEv, 6)}`);

    printTable({
      title: "Folds",
      rows: folds.map((f) => ({
        fold: `${f.foldStartIso.slice(0, 16)} -> ${f.foldEndIso.slice(0, 16)}`,
        trainTrades: f.trainTrades,
        testTrades: f.testTrades,
        minEdge: f.tunedMinEdge,
        minProb: f.tunedMinProb,
        evBase: f.baseline.evPerTrade,
        evSel: f.selected.evPerTrade,
        pnlBase: f.baseline.totalPnl,
        pnlSel: f.selected.totalPnl
      })),
      columns: [
        { key: "fold", label: "fold_utc" },
        { key: "trainTrades", label: "train" },
        { key: "testTrades", label: "test" },
        { key: "minEdge", label: "min_edge", render: (r) => fmt(r.minEdge, 4) },
        { key: "minProb", label: "min_prob", render: (r) => fmtPct(r.minProb, 1) },
        { key: "evBase", label: "ev_base", render: (r) => fmtMoney(r.evBase, 5) },
        { key: "evSel", label: "ev_sel", render: (r) => fmtMoney(r.evSel, 5) },
        { key: "pnlBase", label: "pnl_base", render: (r) => fmtMoney(r.pnlBase, 4) },
        { key: "pnlSel", label: "pnl_sel", render: (r) => fmtMoney(r.pnlSel, 4) }
      ]
    });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
