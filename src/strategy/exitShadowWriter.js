import pg from "pg";
import { insertExitShadowSnapshot } from "../db/postgresStrategy.js";

const { Pool } = pg;
const writerByDatabaseUrl = new Map();

export function createExitShadowWriter({
  write,
  maxQueue = 64,
  onError = (error) => console.warn(`[exit-shadow] async writer dropped snapshot: ${error?.message || error}`)
}) {
  if (typeof write !== "function") throw new Error("exit shadow writer requires write(snapshot)");
  const queue = [];
  const lastBucketByEntry = new Map();
  let draining = false;
  let dropped = 0;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const snapshot = queue.shift();
        try {
          await write(snapshot);
        } catch (error) {
          dropped += 1;
          onError(error);
        }
      }
    } finally {
      draining = false;
      if (queue.length) queueMicrotask(drain);
    }
  }

  function enqueue(snapshot) {
    if (!snapshot) return false;
    const cacheKey = `${snapshot.experiment_key}:${snapshot.entry_id}`;
    if (lastBucketByEntry.get(cacheKey) === snapshot.snapshot_bucket) return true;
    if (queue.length >= maxQueue) {
      dropped += 1;
      return false;
    }
    const immutableSnapshot = Object.freeze({ ...snapshot });
    queue.push(immutableSnapshot);
    lastBucketByEntry.set(cacheKey, snapshot.snapshot_bucket);
    queueMicrotask(drain);
    return true;
  }

  return {
    enqueue,
    stats: () => ({ queued: queue.length, draining, dropped })
  };
}

function getProductionWriter(databaseUrl) {
  const key = String(databaseUrl || "");
  if (!key) return null;
  if (!writerByDatabaseUrl.has(key)) {
    const pool = new Pool({
      connectionString: key,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 30_000,
      query_timeout: 2000,
      statement_timeout: 2000
    });
    writerByDatabaseUrl.set(key, createExitShadowWriter({
      write: (snapshot) => insertExitShadowSnapshot(pool, snapshot)
    }));
  }
  return writerByDatabaseUrl.get(key);
}

export function enqueueExitShadowSnapshot(databaseUrl, snapshot) {
  try {
    return getProductionWriter(databaseUrl)?.enqueue(snapshot) ?? false;
  } catch (error) {
    console.warn(`[exit-shadow] async writer unavailable: ${error?.message || error}`);
    return false;
  }
}
