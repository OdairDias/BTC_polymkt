import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

function parseArgs(argv) {
  const out = {
    days: 60,
    strategy: null,
    iterations: 3000,
    learningRate: 0.05,
    l2: 0.001,
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
    if (arg.startsWith("--iterations=")) {
      const n = Number(arg.slice("--iterations=".length));
      if (Number.isFinite(n) && n > 0) out.iterations = Math.max(100, Math.floor(n));
      continue;
    }
    if (arg.startsWith("--lr=")) {
      const n = Number(arg.slice("--lr=".length));
      if (Number.isFinite(n) && n > 0) out.learningRate = n;
      continue;
    }
    if (arg.startsWith("--l2=")) {
      const n = Number(arg.slice("--l2=".length));
      if (Number.isFinite(n) && n >= 0) out.l2 = n;
      continue;
    }
  }
  return out;
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sigmoid(x) {
  if (x < -30) return 0;
  if (x > 30) return 1;
  return 1 / (1 + Math.exp(-x));
}

function fmt(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

function fmtPct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(digits)}%`;
}

function standardizeMatrix(rows, featureKeys) {
  const means = {};
  const stds = {};
  for (const k of featureKeys) {
    const vals = rows.map((r) => r[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance) || 1;
    means[k] = mean;
    stds[k] = std;
  }
  return { means, stds };
}

function vectorize(rows, featureKeys, means, stds) {
  return rows.map((r) => featureKeys.map((k) => (r[k] - means[k]) / stds[k]));
}

function evaluateMetrics(X, y, weights, bias) {
  if (!X.length) {
    return {
      samples: 0,
      accuracy: null,
      brier: null,
      logloss: null
    };
  }
  let correct = 0;
  let brier = 0;
  let logloss = 0;
  for (let i = 0; i < X.length; i += 1) {
    const xi = X[i];
    const yi = y[i];
    let z = bias;
    for (let j = 0; j < xi.length; j += 1) z += weights[j] * xi[j];
    const p = clampProb(sigmoid(z));
    if ((p >= 0.5 && yi === 1) || (p < 0.5 && yi === 0)) correct += 1;
    brier += (p - yi) ** 2;
    logloss += -yi * Math.log(p) - (1 - yi) * Math.log(1 - p);
  }
  return {
    samples: X.length,
    accuracy: correct / X.length,
    brier: brier / X.length,
    logloss: logloss / X.length
  };
}

function clampProb(p) {
  return Math.min(1 - 1e-7, Math.max(1e-7, p));
}

function trainLogisticRegression({ X, y, iterations, learningRate, l2 }) {
  const features = X[0]?.length ?? 0;
  const weights = new Array(features).fill(0);
  let bias = 0;
  const n = X.length;

  for (let iter = 0; iter < iterations; iter += 1) {
    const gradW = new Array(features).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i += 1) {
      const xi = X[i];
      const yi = y[i];
      let z = bias;
      for (let j = 0; j < features; j += 1) z += weights[j] * xi[j];
      const p = sigmoid(z);
      const err = p - yi;
      gradB += err;
      for (let j = 0; j < features; j += 1) gradW[j] += err * xi[j];
    }

    for (let j = 0; j < features; j += 1) {
      const reg = l2 * weights[j];
      weights[j] -= learningRate * ((gradW[j] / n) + reg);
    }
    bias -= learningRate * (gradB / n);
  }

  return { weights, bias };
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
        )::float8 AS selected_model_prob,
        COALESCE(
          s.selected_edge,
          CASE
            WHEN s.chosen_side = 'UP' AND s.model_prob_up IS NOT NULL AND s.market_prob_up IS NOT NULL
              THEN s.model_prob_up - s.market_prob_up
            WHEN s.chosen_side = 'DOWN' AND s.model_prob_up IS NOT NULL AND s.market_prob_up IS NOT NULL
              THEN (1 - s.model_prob_up) - (1 - s.market_prob_up)
            ELSE NULL
          END
        )::float8 AS selected_edge,
        s.ptb_delta_usd::float8 AS ptb_delta_usd,
        s.vol_atr_usd::float8 AS vol_atr_usd,
        s.book_imbalance::float8 AS book_imbalance,
        s.selected_spread::float8 AS selected_spread,
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
        AND ($2::text IS NULL OR s.strategy_key = $2)
      ORDER BY s.created_at ASC
      `,
      [String(args.days), args.strategy]
    );

    const rows = res.rows
      .map((r) => ({
        createdAtMs: new Date(r.created_at).getTime(),
        strategyKey: String(r.strategy_key || "default"),
        selected_model_prob: toNum(r.selected_model_prob),
        selected_edge: toNum(r.selected_edge),
        ptb_delta_usd: toNum(r.ptb_delta_usd),
        vol_atr_usd: toNum(r.vol_atr_usd),
        book_imbalance: toNum(r.book_imbalance),
        selected_spread: toNum(r.selected_spread),
        y: toNum(r.y)
      }))
      .filter((r) =>
        r.createdAtMs &&
        r.selected_model_prob != null &&
        r.selected_edge != null &&
        r.ptb_delta_usd != null &&
        r.vol_atr_usd != null &&
        r.book_imbalance != null &&
        r.selected_spread != null &&
        r.y != null
      );

    if (rows.length < 80) {
      console.log("Dados insuficientes para treino offline (min recomendado: 80 linhas).");
      return;
    }

    const splitIndex = Math.max(1, Math.floor(rows.length * 0.8));
    const trainRows = rows.slice(0, splitIndex);
    const testRows = rows.slice(splitIndex);
    if (trainRows.length < 50 || testRows.length < 10) {
      console.log("Split temporal insuficiente para avaliação OOS.");
      return;
    }

    const featureKeys = [
      "selected_model_prob",
      "selected_edge",
      "ptb_delta_usd",
      "vol_atr_usd",
      "book_imbalance",
      "selected_spread"
    ];
    const scaler = standardizeMatrix(trainRows, featureKeys);
    const XTrain = vectorize(trainRows, featureKeys, scaler.means, scaler.stds);
    const yTrain = trainRows.map((r) => r.y);
    const XTest = vectorize(testRows, featureKeys, scaler.means, scaler.stds);
    const yTest = testRows.map((r) => r.y);

    const model = trainLogisticRegression({
      X: XTrain,
      y: yTrain,
      iterations: args.iterations,
      learningRate: args.learningRate,
      l2: args.l2
    });

    const trainMetrics = evaluateMetrics(XTrain, yTrain, model.weights, model.bias);
    const testMetrics = evaluateMetrics(XTest, yTest, model.weights, model.bias);

    const payload = {
      meta: {
        generated_at: new Date().toISOString(),
        strategy_filter: args.strategy,
        days: args.days,
        rows_total: rows.length,
        rows_train: trainRows.length,
        rows_test: testRows.length,
        iterations: args.iterations,
        learning_rate: args.learningRate,
        l2: args.l2
      },
      features: featureKeys.map((key, idx) => ({
        feature: key,
        mean: scaler.means[key],
        std: scaler.stds[key],
        weight: model.weights[idx]
      })),
      bias: model.bias,
      metrics: {
        train: trainMetrics,
        test: testMetrics
      }
    };

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log("Treino Offline - Modelo Logistico");
    console.log(`Estrategia: ${args.strategy ?? "todas"} | Janela: ${args.days} dias`);
    console.log(`Train/Test: ${trainRows.length}/${testRows.length}`);

    console.log("\nMetricas");
    console.log(
      `Train -> acc ${fmtPct(trainMetrics.accuracy, 2)} | brier ${fmt(trainMetrics.brier, 6)} | logloss ${fmt(trainMetrics.logloss, 6)}`
    );
    console.log(
      `Test  -> acc ${fmtPct(testMetrics.accuracy, 2)} | brier ${fmt(testMetrics.brier, 6)} | logloss ${fmt(testMetrics.logloss, 6)}`
    );

    console.log("\nCoeficientes");
    for (const f of payload.features) {
      console.log(
        `${f.feature.padEnd(20)} w=${fmt(f.weight, 6)} | mean=${fmt(f.mean, 6)} | std=${fmt(f.std, 6)}`
      );
    }
    console.log(`bias=${fmt(model.bias, 6)}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
