import { Side, OrderType } from "@polymarket/clob-client";
import { CONFIG } from "../config.js";
import { getOrCreateClobClient } from "./liveClob.js";
import { insertLiveOrder } from "../db/postgresStrategy.js";

/** Casas decimais da parte fracionária do tick (ex.: "0.01" → 2). */
function decimalsFromTickString(tickSize) {
  const s = String(tickSize).trim();
  const i = s.indexOf(".");
  if (i < 0) return 0;
  const frac = s.slice(i + 1).replace(/0+$/, "");
  return frac.length;
}

function roundDownDecimals(n, places) {
  if (!Number.isFinite(n)) return n;
  if (places <= 0) return Math.floor(n + 1e-12);
  const f = 10 ** places;
  return Math.floor((n + 1e-12) * f) / f;
}

/**
 * Preço máximo (tick) + USDC a gastar (2 dec), para `createAndPostMarketOrder`.
 * A API trata FOK como "market buy" e valida maker/taker com a rota de mercado —
 * ordem **limite** + FOK gerava "invalid amounts" mesmo com arredondamento.
 */
function capPriceAndAmountUsd(limitPrice, notionalUsd, tickSizeStr) {
  const tickDec = decimalsFromTickString(tickSizeStr);
  const capPrice = Number(roundDownDecimals(Number(limitPrice), tickDec).toFixed(tickDec));
  if (!Number.isFinite(capPrice) || capPrice <= 0) {
    throw new Error(`preço limite inválido após tick (${tickSizeStr})`);
  }
  const amountUsd = Number(roundDownDecimals(Number(notionalUsd), 2).toFixed(2));
  if (amountUsd < 0.01) {
    throw new Error("STRATEGY_NOTIONAL_USD < 0.01 após arredondar");
  }
  return { capPrice, amountUsd };
}

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
 * Envia BUY **mercado** FOK no CLOB (~`notionalUsd` USDC, teto = preço do paper),
 * via `createAndPostMarketOrder` (montantes alinhados à validação "market buy").
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

    const price0 = Number(limitPrice);
    const notional = Number(notionalUsd);
    if (!Number.isFinite(price0) || price0 <= 0 || !Number.isFinite(notional) || notional <= 0) {
      throw new Error("limitPrice ou notionalUsd inválidos para CLOB");
    }

    const { capPrice, amountUsd } = capPriceAndAmountUsd(price0, notional, tickSize);
    rowBase.limit_price = capPrice;
    rowBase.size_shares = Number(roundDownDecimals(amountUsd / capPrice, 2).toFixed(2));

    const result = await clob.createAndPostMarketOrder(
      {
        tokenID: String(tokenId),
        side: Side.BUY,
        amount: amountUsd,
        price: capPrice,
        orderType: OrderType.FOK
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
      line: `CLOB mercado FOK ok · order ${orderId ?? "(sem id na resposta)"}${statusHint}`
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
