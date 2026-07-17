function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export const EXIT_SHADOW_EXPERIMENT_KEY = "h1_exit_shadow_v1";
export const EXIT_SHADOW_EXECUTION_MODEL_VERSION = "paper_best_bid_penalty_v1";

export const EXIT_SHADOW_POLICIES = Object.freeze([
  Object.freeze({ key: "time_stop_15m", type: "time_stop", thresholdMinutes: 15 }),
  Object.freeze({ key: "time_stop_10m", type: "time_stop", thresholdMinutes: 10 }),
  Object.freeze({ key: "max_loss_025", type: "max_loss_usd", thresholdUsd: -0.25 }),
  Object.freeze({ key: "max_loss_040", type: "max_loss_usd", thresholdUsd: -0.40 })
]);

export function summarizeExitShadowPnl(values) {
  const pnl = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const grossWins = wins.reduce((sum, value) => sum + value, 0);
  const grossLosses = losses.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of pnl) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  const averageWin = wins.length ? grossWins / wins.length : null;
  const averageLoss = losses.length ? grossLosses / losses.length : null;
  return {
    entries: pnl.length,
    wins: wins.length,
    losses: losses.length,
    netPnl: cumulative,
    expectancy: pnl.length ? cumulative / pnl.length : null,
    averageWin,
    averageLoss,
    payoff: averageWin != null && averageLoss != null ? averageWin / Math.abs(averageLoss) : null,
    profitFactor: grossLosses < 0 ? grossWins / Math.abs(grossLosses) : null,
    maxDrawdown,
    worstTrade: pnl.length ? Math.min(...pnl) : null
  };
}

export function computeExitShadowCoverage({
  entryCreatedAt,
  finalExitAt,
  snapshots,
  maxDelaySeconds = 45
}) {
  const times = (Array.isArray(snapshots) ? snapshots : [])
    .map((snapshot) => new Date(snapshot?.observed_at).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const entryMs = new Date(entryCreatedAt).getTime();
  const finalMs = finalExitAt == null ? Number.NaN : new Date(finalExitAt).getTime();
  const firstDelaySeconds = times.length && Number.isFinite(entryMs)
    ? Math.max(0, (times[0] - entryMs) / 1000)
    : null;
  const maxGapSeconds = times.length > 1
    ? Math.max(...times.slice(1).map((time, index) => (time - times[index]) / 1000))
    : null;
  const finalCoverageDelaySeconds = times.length && Number.isFinite(finalMs)
    ? Math.max(0, (finalMs - times[times.length - 1]) / 1000)
    : null;
  return {
    firstDelaySeconds,
    maxGapSeconds,
    finalCoverageDelaySeconds,
    complete:
      times.length >= 2 &&
      firstDelaySeconds != null && firstDelaySeconds <= maxDelaySeconds &&
      maxGapSeconds != null && maxGapSeconds <= maxDelaySeconds &&
      finalCoverageDelaySeconds != null && finalCoverageDelaySeconds <= maxDelaySeconds
  };
}

export function buildExitShadowSnapshot({
  state,
  experimentKey = EXIT_SHADOW_EXPERIMENT_KEY,
  strategyKey,
  marketSlug,
  settlementLeftMin,
  bidPrice,
  executableBidPrice,
  bidDepthShares,
  hasLiquidity,
  higherPriorityExitDue = false,
  realizedIfExit,
  intervalSeconds = 15,
  observedAt = new Date(),
  gitCommit = "unknown",
  configHash = null
}) {
  const entryId = toFiniteNumber(state?.entryId);
  const remainingShares = toFiniteNumber(state?.sizeShares);
  const remainingNotionalUsd = toFiniteNumber(state?.notionalUsd);
  const initialNotionalUsd = toFiniteNumber(state?.initialNotionalUsd);
  const observedMs = observedAt instanceof Date ? observedAt.getTime() : Number.NaN;
  if (
    entryId == null || entryId <= 0 ||
    remainingShares == null || remainingShares <= 0 ||
    remainingNotionalUsd == null || remainingNotionalUsd <= 0 ||
    initialNotionalUsd == null || initialNotionalUsd <= 0 ||
    !Number.isFinite(observedMs)
  ) {
    return null;
  }

  const safeIntervalSeconds = Math.max(5, Math.floor(Number(intervalSeconds) || 15));
  const realized = realizedIfExit && typeof realizedIfExit === "object" ? realizedIfExit : {};
  return {
    entry_id: Math.floor(entryId),
    experiment_key: String(experimentKey || EXIT_SHADOW_EXPERIMENT_KEY),
    strategy_key: String(strategyKey || "default"),
    market_slug: String(marketSlug || state?.marketSlug || ""),
    observed_at: new Date(observedMs),
    snapshot_bucket: Math.floor(observedMs / (safeIntervalSeconds * 1000)),
    interval_seconds: safeIntervalSeconds,
    side: state?.side ?? null,
    seconds_left: toFiniteNumber(settlementLeftMin) != null ? Math.max(0, Number(settlementLeftMin) * 60) : null,
    bid_price: toFiniteNumber(bidPrice),
    executable_bid_price: toFiniteNumber(executableBidPrice),
    bid_depth_shares: toFiniteNumber(bidDepthShares),
    execution_model_version: EXIT_SHADOW_EXECUTION_MODEL_VERSION,
    initial_notional_usd: initialNotionalUsd,
    remaining_shares: remainingShares,
    remaining_notional_usd: remainingNotionalUsd,
    next_level_index: Math.max(0, Math.floor(Number(state?.nextLevelIndex) || 0)),
    next_target_price: toFiniteNumber(state?.targetPrice),
    higher_priority_exit_due: Boolean(higherPriorityExitDue),
    highest_bid_seen: toFiniteNumber(state?.highestBidSeen),
    has_bid_liquidity: Boolean(hasLiquidity),
    gross_pnl_if_exit_usd: toFiniteNumber(realized.grossPnl),
    entry_fee_if_exit_usd: toFiniteNumber(realized.entryFeeUsd),
    exit_fee_if_exit_usd: toFiniteNumber(realized.exitFeeUsd),
    total_fee_if_exit_usd: toFiniteNumber(realized.totalFeeUsd),
    net_pnl_if_exit_usd: toFiniteNumber(realized.pnl),
    git_commit: String(gitCommit || "unknown"),
    config_hash: configHash == null ? null : String(configHash)
  };
}

function policySnapshotEvaluable(policy, snapshot) {
  if (!snapshot?.has_bid_liquidity || toFiniteNumber(snapshot?.executable_bid_price) == null) return false;
  if (policy?.type === "time_stop") return toFiniteNumber(snapshot.seconds_left) != null;
  if (policy?.type === "max_loss_usd") return toFiniteNumber(snapshot.total_net_pnl_if_exit_usd) != null;
  return false;
}

function policyTriggered(policy, snapshot) {
  if (!policySnapshotEvaluable(policy, snapshot)) return false;
  if (snapshot.higher_priority_exit_due) return false;
  if (policy.type === "time_stop") {
    const secondsLeft = toFiniteNumber(snapshot.seconds_left);
    const bidPrice = toFiniteNumber(snapshot.bid_price);
    const nextTargetPrice = toFiniteNumber(snapshot.next_target_price);
    const takeProfitHasPriority =
      bidPrice != null && nextTargetPrice != null && bidPrice >= nextTargetPrice;
    return !takeProfitHasPriority && secondsLeft != null && secondsLeft <= Number(policy.thresholdMinutes) * 60;
  }
  if (policy.type === "max_loss_usd") {
    const totalPnl = toFiniteNumber(snapshot.total_net_pnl_if_exit_usd);
    return totalPnl != null && totalPnl <= Number(policy.thresholdUsd);
  }
  return false;
}

export function evaluateExitShadowPolicyPath(policy, snapshots) {
  const ordered = [...(Array.isArray(snapshots) ? snapshots : [])]
    .sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
  const diagnostics = {
    missingExecutableBidSnapshots: ordered.filter((snapshot) => toFiniteNumber(snapshot?.executable_bid_price) == null).length,
    insufficientLiquiditySnapshots: ordered.filter((snapshot) => !snapshot?.has_bid_liquidity).length
  };
  let observedNonTriggered = false;
  let validSnapshots = 0;
  for (const snapshot of ordered) {
    if (!policySnapshotEvaluable(policy, snapshot)) continue;
    validSnapshots += 1;
    const triggered = policyTriggered(policy, snapshot);
    if (triggered && !observedNonTriggered) {
      return { status: "left_censored", trigger: null, validSnapshots, ...diagnostics };
    }
    if (triggered) {
      return { status: "triggered", trigger: snapshot, validSnapshots, ...diagnostics };
    }
    observedNonTriggered = true;
  }
  return {
    status: validSnapshots > 0 ? "not_triggered" : "non_evaluable",
    trigger: null,
    validSnapshots,
    ...diagnostics
  };
}

export function findFirstObservedPolicyTrigger(policy, snapshots) {
  return evaluateExitShadowPolicyPath(policy, snapshots).trigger;
}
