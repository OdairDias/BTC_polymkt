import { Side, OrderType } from "@polymarket/clob-client";
import { CONFIG } from "../config.js";
import { getOrCreateClobClient } from "./liveClob.js";
import { insertLiveOrder } from "../db/postgresStrategy.js";

function extractOrderMeta(result) {
  if (result == null) {
    return { orderId: null, status: null, errorMsg: "resposta vazia" };
  }
  if (typeof result === "string") {
    return { orderId: result, status: null, errorMsg: null };
  }
  if (typeof result !== "object") {
    return { orderId: null, status: null, errorMsg: String(result) };
  }
  const errMsg = result.errorMsg != null ? String(result.errorMsg).trim() : "";
  if (result.success === false || errMsg) {
    return {
      orderId: null,
      status: result.status ?? null,
      errorMsg: errMsg || "success=false"
    };
  }
  const orderId =
    result.orderID ??
    result.orderId ??
    result.order_id ??
    result.id ??
    null;
  return { orderId, status: result.status ?? null, errorMsg: null };
}

/**
 * Envia ordem limite BUY FOK no CLOB após entrada da estratégia.
 * Grava linha em strategy_live_orders (sucesso ou erro).
 */
export async function tryPlaceLiveEntryOrder({
  pgClient,
  entryId,
  marketSlug,
  tokenId,
  limitPrice,
  sizeShares,
  notionalUsd
}) {
  const rowBase = {
    entry_id: entryId,
    market_slug: marketSlug,
    token_id: String(tokenId),
    side: "BUY",
    limit_price: limitPrice,
    size_shares: sizeShares,
    notional_usd: notionalUsd
  };

  try {
    const clob = await getOrCreateClobClient();
    const tickSize = await clob.getTickSize(String(tokenId));
    const negRisk = await clob.getNegRisk(String(tokenId));

    const size = Number(sizeShares);
    const price = Number(limitPrice);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
      throw new Error("size ou price inválidos para CLOB");
    }

    const result = await clob.createAndPostOrder(
      {
        tokenID: String(tokenId),
        price,
        size,
        side: Side.BUY
      },
      { tickSize, negRisk },
      OrderType.FOK
    );

    const meta = extractOrderMeta(result);
    if (meta.errorMsg) {
      throw new Error(meta.errorMsg);
    }

    const orderId = meta.orderId;
    const statusHint = meta.status ? ` · status ${meta.status}` : "";

    await insertLiveOrder(pgClient, {
      ...rowBase,
      clob_order_id: orderId != null ? String(orderId) : null,
      status: "SUBMITTED",
      error_message: null,
      raw_response: result
    });

    return {
      ok: true,
      line: `CLOB FOK ok · order ${orderId ?? "(sem id na resposta)"}${statusHint}`
    };
  } catch (err) {
    const msg = err?.message ?? String(err);
    try {
      await insertLiveOrder(pgClient, {
        ...rowBase,
        clob_order_id: null,
        status: "ERROR",
        error_message: msg.slice(0, 2000),
        raw_response: err?.response?.data ?? { message: msg }
      });
    } catch {
      // ignore duplicate insert etc.
    }
    return { ok: false, line: `CLOB erro: ${msg.slice(0, 120)}` };
  }
}

/**
 * Deve enviar ordem real? Dry-run desligado + armação explícita + chave presente.
 */
export function shouldAttemptLiveOrder() {
  const s = CONFIG.strategy;
  const pk = (CONFIG.live.privateKey || "").trim();
  return !s.dryRun && s.liveArmed && Boolean(pk);
}
