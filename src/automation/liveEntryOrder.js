import { AssetType, OrderType, Side } from "@polymarket/clob-client";
import { CONFIG } from "../config.js";
import { insertLiveExit, insertLiveOrder } from "../db/postgresStrategy.js";
import { getOrCreateClobClient, isRelayerBuilderConfigured } from "./liveClob.js";

const LIVE_DEBUG = process.env.STRATEGY_LIVE_DEBUG === "true";
const ERR_MSG_MAX = 8000;

function explainClobFailure(err) {
  const name = err?.name;
  const hasApiShape =
    name === "ApiError" || (err?.status != null && err?.data !== undefined && !err?.response);
  if (hasApiShape) {
    const dataStr =
      typeof err.data === "string" ? err.data : JSON.stringify(err.data ?? null, null, 0);
    const clip = dataStr.length > 2000 ? `${dataStr.slice(0, 2000)}...` : dataStr;
    const msg = String(err.message || "ApiError").trim();
    return {
      line: `${msg} | HTTP ${err.status ?? "?"} | ${clip}`,
      raw: { kind: "ApiError", message: msg, status: err.status ?? null, data: err.data ?? null }
    };
  }
  const ax = err?.response;
  if (ax) {
    const body = ax.data;
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body ?? {});
    return {
      line: `${err.message} | HTTP ${ax.status} | ${bodyStr.slice(0, 2000)}`,
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

function capPriceAndAmountUsd(limitPrice, notionalUsd, tickSizeStr) {
  const tickDec = decimalsFromTickString(tickSizeStr);
  const capPrice = Number(roundDownDecimals(Number(limitPrice), tickDec).toFixed(tickDec));
  if (!Number.isFinite(capPrice) || capPrice <= 0) {
    throw new Error(`preco limite invalido apos tick (${tickSizeStr})`);
  }
  const amountUsd = Number(roundDownDecimals(Number(notionalUsd), 2).toFixed(2));
  if (amountUsd < 0.01) {
    throw new Error("STRATEGY_NOTIONAL_USD < 0.01 apos arredondar");
  }
  const sizeShares = Number(roundDownDecimals(amountUsd / capPrice, 2).toFixed(2));
  return { capPrice, amountUsd, sizeShares };
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

export async function tryPlaceLiveEntryOrder({
  pgClient,
  entryId,
  marketSlug,
  tokenId,
  limitPrice,
  sizeShares,
  notionalUsd,
  expiration
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
      throw new Error("limitPrice ou notionalUsd invalidos para CLOB");
    }

    const { capPrice, amountUsd, sizeShares: finalSize } = capPriceAndAmountUsd(price0, notional, tickSize);
    rowBase.limit_price = capPrice;
    rowBase.size_shares = finalSize;

    const funderRaw = (CONFIG.live.funderAddress || "").trim();
    const ctxLog = {
      market_slug: marketSlug,
      token_id_len: String(tokenId).length,
      token_id_prefix: `${String(tokenId).slice(0, 20)}...`,
      capPrice,
      amountUsd,
      tickSize,
      negRisk,
      signatureType: CONFIG.live.signatureType,
      funder: funderRaw ? `${funderRaw.slice(0, 6)}...${funderRaw.slice(-4)}` : null,
      relayerBuilderHeaders: isRelayerBuilderConfigured()
    };
    if (LIVE_DEBUG) {
      console.error("[STRATEGY_LIVE_DEBUG] createAndPostOrder context:", JSON.stringify(ctxLog));
    }

    const expirationSec = expiration ? Math.floor(new Date(expiration).getTime() / 1000) : 0;
    const orderType = expirationSec > 0 ? OrderType.GTD : OrderType.GTC;
    const result = await clob.createAndPostOrder(
      {
        tokenID: String(tokenId),
        side: Side.BUY,
        price: capPrice,
        size: finalSize,
        expiration: expirationSec > 0 ? expirationSec : undefined
      },
      { tickSize, negRisk },
      orderType
    );

    const meta = extractOrderMeta(result);
    if (meta.errorMsg) throw new Error(meta.errorMsg);

    const orderId = meta.orderId;
    const statusHint = meta.status ? ` | status ${meta.status}` : "";

    await insertLiveOrder(pgClient, {
      ...rowBase,
      clob_order_id: orderId != null ? String(orderId) : null,
      status: "SUBMITTED",
      error_message: null,
      raw_response: result
    });

    return {
      ok: true,
      line: `CLOB Limit Maker ok | price ${capPrice} | order ${orderId ?? "(sem id na resposta)"}${statusHint}`
    };
  } catch (err) {
    const explained = explainClobFailure(err);
    let msg = explained.line;
    if (/balance|allowance|not enough|collateral|insufficient/i.test(msg)) {
      try {
        const c = await getOrCreateClobClient();
        const ba = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        msg = `${msg} | collateral balance=${ba.balance} allowance=${ba.allowance ?? JSON.stringify(ba.allowances ?? "-")}`;
      } catch {
        // ignore diagnostic failure
      }
    }
    const rawOut = {
      ...explained.raw,
      requestContext: {
        market_slug: marketSlug,
        token_id_prefix: `${String(tokenId).slice(0, 24)}...`,
        signatureType: CONFIG.live.signatureType,
        funder_masked: (CONFIG.live.funderAddress || "").trim()
          ? `${String(CONFIG.live.funderAddress).trim().slice(0, 6)}...${String(CONFIG.live.funderAddress).trim().slice(-4)}`
          : null,
        relayer_builder_headers: isRelayerBuilderConfigured()
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

export function shouldAttemptLiveOrder() {
  const s = CONFIG.strategy;
  const pk = (CONFIG.live.privateKey || "").trim();
  return !s.dryRun && s.liveArmed && Boolean(pk);
}

export async function tryPlaceSniperFokOrder({
  pgClient,
  entryId,
  marketSlug,
  tokenId,
  limitPrice,
  notionalUsd
}) {
  const rowBase = {
    entry_id: entryId,
    market_slug: marketSlug,
    token_id: String(tokenId),
    side: "BUY",
    limit_price: limitPrice,
    size_shares: null,
    notional_usd: notionalUsd
  };

  try {
    const clob = await getOrCreateClobClient();
    const tickSize = await clob.getTickSize(String(tokenId));
    const negRisk = await clob.getNegRisk(String(tokenId));

    const price0 = Number(limitPrice);
    const notional = Number(notionalUsd);
    if (!Number.isFinite(price0) || price0 <= 0 || !Number.isFinite(notional) || notional <= 0) {
      throw new Error("limitPrice ou notionalUsd invalidos para CLOB");
    }

    const { capPrice, amountUsd, sizeShares: finalSize } = capPriceAndAmountUsd(price0, notional, tickSize);
    rowBase.limit_price = capPrice;
    rowBase.size_shares = finalSize;

    const funderRaw = (CONFIG.live.funderAddress || "").trim();
    const ctxLog = {
      market_slug: marketSlug,
      amountUsd,
      capPrice,
      f: "SNIPER_FOK",
      funder: funderRaw ? `${funderRaw.slice(0, 6)}...` : null
    };
    if (LIVE_DEBUG) console.error("[STRATEGY_LIVE_DEBUG] FOK:", JSON.stringify(ctxLog));

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
    if (meta.errorMsg) throw new Error(meta.errorMsg);

    const orderId = meta.orderId;
    const statusHint = meta.status ? ` | status ${meta.status}` : "";

    await insertLiveOrder(pgClient, {
      ...rowBase,
      clob_order_id: orderId != null ? String(orderId) : null,
      status: "SUBMITTED",
      error_message: null,
      raw_response: result
    });

    return {
      ok: true,
      line: `CLOB SNIPER FOK ok | price ${capPrice} | amt $${amountUsd} | order ${orderId ?? "(sem id)"}${statusHint}`,
      sizeShares: finalSize,
      filledPrice: capPrice
    };
  } catch (err) {
    const explained = explainClobFailure(err);
    const msg = explained.line.slice(0, 400);
    try {
      await insertLiveOrder(pgClient, {
        ...rowBase,
        clob_order_id: null,
        status: "ERROR",
        error_message: msg.slice(0, ERR_MSG_MAX),
        raw_response: explained.raw
      });
    } catch {
      // ignore duplicate insert etc.
    }
    return { ok: false, line: `CLOB Sniper erro: ${msg}` };
  }
}

export async function tryPlaceTakeProfitExitOrder({
  pgClient,
  entryId,
  strategyKey,
  marketSlug,
  tokenId,
  targetPrice,
  sizeShares,
  notionalUsd
}) {
  const rowBase = {
    entry_id: entryId,
    strategy_key: strategyKey ?? "default",
    market_slug: marketSlug,
    token_id: String(tokenId),
    side: "SELL",
    trigger_price: targetPrice,
    exit_price: targetPrice,
    size_shares: sizeShares,
    notional_usd: notionalUsd
  };

  try {
    const clob = await getOrCreateClobClient();
    const tickSize = await clob.getTickSize(String(tokenId));
    const negRisk = await clob.getNegRisk(String(tokenId));

    const target = Number(targetPrice);
    const wantedShares = Number(sizeShares);
    if (!Number.isFinite(target) || target <= 0 || target >= 1) {
      throw new Error("takeProfitPrice invalido para saida live");
    }
    if (!Number.isFinite(wantedShares) || wantedShares <= 0) {
      throw new Error("sizeShares invalido para saida live");
    }

    const tickDec = decimalsFromTickString(tickSize);
    const floorPrice = Number(roundDownDecimals(target, tickDec).toFixed(tickDec));
    let finalShares = Number(roundDownDecimals(wantedShares, 2).toFixed(2));

    try {
      const conditionalBalance = await clob.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: String(tokenId)
      });
      const availableShares = Number(conditionalBalance?.balance ?? NaN);
      if (Number.isFinite(availableShares) && availableShares > 0) {
        finalShares = Number(roundDownDecimals(Math.min(wantedShares, availableShares), 2).toFixed(2));
      }
    } catch {
      // fallback to tracked shares
    }

    if (!Number.isFinite(finalShares) || finalShares < 0.01) {
      throw new Error("saldo insuficiente para executar take profit");
    }

    rowBase.exit_price = floorPrice;
    rowBase.size_shares = finalShares;

    const result = await clob.createAndPostMarketOrder(
      {
        tokenID: String(tokenId),
        side: Side.SELL,
        amount: finalShares,
        price: floorPrice,
        orderType: OrderType.FOK
      },
      { tickSize, negRisk },
      OrderType.FOK
    );

    const meta = extractOrderMeta(result);
    if (meta.errorMsg) throw new Error(meta.errorMsg);

    const orderId = meta.orderId;
    const statusHint = meta.status ? ` | status ${meta.status}` : "";

    await insertLiveExit(pgClient, {
      ...rowBase,
      clob_order_id: orderId != null ? String(orderId) : null,
      status: "EXECUTED",
      error_message: null,
      raw_response: result
    });

    return {
      ok: true,
      line: `CLOB TAKE PROFIT ok | sell ${finalShares} @ ${floorPrice} | order ${orderId ?? "(sem id)"}${statusHint}`,
      sizeShares: finalShares,
      filledPrice: floorPrice
    };
  } catch (err) {
    const explained = explainClobFailure(err);
    const msg = explained.line.slice(0, 400);
    try {
      await insertLiveExit(pgClient, {
        ...rowBase,
        clob_order_id: null,
        status: "ERROR",
        error_message: msg.slice(0, ERR_MSG_MAX),
        raw_response: explained.raw
      });
    } catch {
      // ignore insert failure
    }
    return { ok: false, line: `CLOB Take Profit erro: ${msg}` };
  }
}
