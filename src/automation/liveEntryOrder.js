import { AssetType, OrderType, Side } from "@polymarket/clob-client";
import { CONFIG } from "../config.js";
import { getOrCreateClobClient } from "./liveClob.js";
import { insertLiveOrder } from "../db/postgresStrategy.js";

const LIVE_DEBUG = process.env.STRATEGY_LIVE_DEBUG === "true";
const ERR_MSG_MAX = 8000;

/** O @polymarket/clob-client usa ApiError { status, data }, não axios.response. */
function explainClobFailure(err) {
  const name = err?.name;
  const hasApiShape =
    name === "ApiError" || (err?.status != null && err?.data !== undefined && !err?.response);
  if (hasApiShape) {
    const dataStr =
      typeof err.data === "string" ? err.data : JSON.stringify(err.data ?? null, null, 0);
    const clip = dataStr.length > 2000 ? `${dataStr.slice(0, 2000)}…` : dataStr;
    const msg = String(err.message || "ApiError").trim();
    return {
      line: `${msg} · HTTP ${err.status ?? "?"} · ${clip}`,
      raw: { kind: "ApiError", message: msg, status: err.status ?? null, data: err.data ?? null }
    };
  }
  const ax = err?.response;
  if (ax) {
    const body = ax.data;
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body ?? {});
    return {
      line: `${err.message} · HTTP ${ax.status} · ${bodyStr.slice(0, 2000)}`,
      raw: { kind: "axiosLike", message: err.message, status: ax.status, data: ax.data }
    };
  }
  return {
    line: err?.message ?? String(err),
    raw: {
      kind: "Error",
      message: err?.message ?? String(err),
      name: err?.name,
      stack: typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 12).join("\n") : undefined
    }
  };
}

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

    const funderRaw = (CONFIG.live.funderAddress || "").trim();
    const ctxLog = {
      market_slug: marketSlug,
      token_id_len: String(tokenId).length,
      token_id_prefix: `${String(tokenId).slice(0, 20)}…`,
      capPrice,
      amountUsd,
      tickSize,
      negRisk,
      signatureType: CONFIG.live.signatureType,
      funder: funderRaw ? `${funderRaw.slice(0, 6)}…${funderRaw.slice(-4)}` : null
    };
    if (LIVE_DEBUG) {
      console.error("[STRATEGY_LIVE_DEBUG] createAndPostMarketOrder context:", JSON.stringify(ctxLog));
    }

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
    const explained = explainClobFailure(err);
    let msg = explained.line;
    if (/balance|allowance|not enough|collateral|insufficient/i.test(msg)) {
      try {
        const c = await getOrCreateClobClient();
        const ba = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        msg = `${msg} · collateral balance=${ba.balance} allowance=${ba.allowance ?? JSON.stringify(ba.allowances ?? "—")}`;
      } catch {
        // ignora falha do diagnóstico
      }
    }
    const rawOut = {
      ...explained.raw,
      requestContext: {
        market_slug: marketSlug,
        token_id_prefix: `${String(tokenId).slice(0, 24)}…`,
        signatureType: CONFIG.live.signatureType,
        funder_masked: (CONFIG.live.funderAddress || "").trim()
          ? `${String(CONFIG.live.funderAddress).trim().slice(0, 6)}…${String(CONFIG.live.funderAddress).trim().slice(-4)}`
          : null
      }
    };
    if (LIVE_DEBUG) {
      console.error("[STRATEGY_LIVE_DEBUG] CLOB failure:", JSON.stringify(rawOut).slice(0, 12000));
    }
    try {
      await insertLiveOrder(pgClient, {
        ...rowBase,
        clob_order_id: null,
        status: "ERROR",
        error_message: msg.slice(0, ERR_MSG_MAX),
        raw_response: rawOut
      });
    } catch {
      // ignore duplicate insert etc.
    }
    return { ok: false, line: `CLOB erro: ${msg.slice(0, 400)}` };
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
