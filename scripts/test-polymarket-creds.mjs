/**
 * Testa credenciais Polymarket CLOB sem enviar ordens:
 * - rede / CLOB up
 * - chave → endereço signer
 * - createOrDeriveApiKey (L1)
 * - getBalanceAllowance + getOpenOrders (L2 + HMAC)
 *
 * Uso (na raiz do projeto):
 *   npx dotenv -e .env -- node scripts/test-polymarket-creds.mjs
 * ou com .env já carregado pelo shell / Railway:
 *   node scripts/test-polymarket-creds.mjs
 */
import "dotenv/config";
import { Wallet, getAddress } from "ethers";
import { AssetType, OrderType, Side } from "@polymarket/clob-client";
import { CONFIG } from "../src/config.js";
import {
  assertValidEvmPrivateKeyForClob,
  getOrCreateClobClient
} from "../src/automation/liveClob.js";

function maskAddr(a) {
  const s = String(a || "");
  if (s.length < 12) return s || "(vazio)";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

async function main() {
  console.log("=== Polymarket CLOB — teste de credenciais (sem postOrder) ===\n");

  const host = CONFIG.clobBaseUrl.replace(/\/$/, "");
  console.log(`Host:     ${host}`);
  console.log(`chainId:  ${CONFIG.live.chainId}`);
  console.log(`signatureType (env): ${CONFIG.live.signatureType}`);

  const pk = (CONFIG.live.privateKey || "").trim();
  if (!pk) {
    console.log("\nERRO: POLYMARKET_PRIVATE_KEY ausente (carrega .env na raiz ou exporta no shell).");
    process.exit(1);
  }

  let signerAddr;
  try {
    signerAddr = new Wallet(assertValidEvmPrivateKeyForClob(pk)).address;
  } catch (e) {
    console.log("\nERRO na chave privada:", e?.message ?? e);
    process.exit(1);
  }
  console.log(`Signer:   ${signerAddr}  (EOA derivada da POLYMARKET_PRIVATE_KEY)`);

  const funderRaw = (CONFIG.live.funderAddress || "").trim();
  let funderNorm = "";
  if (funderRaw) {
    try {
      funderNorm = getAddress(funderRaw);
    } catch {
      console.log("\nERRO: POLYMARKET_FUNDER_ADDRESS não é um 0x válido.");
      process.exit(1);
    }
  }
  console.log(
    funderNorm
      ? `Funder:   ${funderNorm}  (proxy / perfil Polymarket; resumo ${maskAddr(funderNorm)})`
      : "Funder:   (vazio — modo EOA puro)"
  );

  if (signerAddr.toLowerCase() === funderNorm.toLowerCase() && CONFIG.live.signatureType === 1) {
    console.log(
      "\nAVISO: com signatureType=1 costuma-se usar funder ≠ signer. Se funder = signer, confirma se é intencional.\n"
    );
  }

  let clob;
  try {
    clob = await getOrCreateClobClient();
  } catch (e) {
    console.log("\nERRO ao criar ClobClient / derive API key (L1):", e?.message ?? e);
    process.exit(1);
  }
  console.log("\n✓ Cliente CLOB criado e API key L2 obtida (createOrDeriveApiKey).");

  try {
    const ok = await clob.getOk();
    console.log("✓ getOk():", typeof ok === "object" ? JSON.stringify(ok).slice(0, 120) : ok);
  } catch (e) {
    console.error("✗ getOk():", e?.message ?? e);
  }

  try {
    const t = await clob.getServerTime();
    console.log("✓ getServerTime():", t);
  } catch (e) {
    console.error("✗ getServerTime():", e?.message ?? e);
  }

  try {
    const ba = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("✓ getBalanceAllowance(COLLATERAL):", JSON.stringify(ba));
  } catch (e) {
    console.error("✗ getBalanceAllowance:", e?.message ?? e);
  }

  try {
    const orders = await clob.getOpenOrders({}, true);
    const n = Array.isArray(orders) ? orders.length : 0;
    console.log(`✓ getOpenOrders (1ª página): ${n} ordem(ns) aberta(s).`);
  } catch (e) {
    console.error("✗ getOpenOrders:", e?.message ?? e);
  }

  const testToken = (process.env.POLYMARKET_TEST_TOKEN_ID || "").trim();
  if (testToken) {
    try {
      const tickSize = await clob.getTickSize(testToken);
      const negRisk = await clob.getNegRisk(testToken);
      const signed = await clob.createMarketOrder(
        {
          tokenID: testToken,
          side: Side.BUY,
          amount: 1,
          price: 0.5,
          orderType: OrderType.FOK
        },
        { tickSize, negRisk }
      );
      console.log(
        "✓ createMarketOrder (assinatura local, sem enviar): maker=",
        signed.maker,
        "signer=",
        signed.signer,
        "sigType=",
        signed.signatureType,
        "sig(len)=",
        signed.signature?.length ?? 0
      );
    } catch (e) {
      console.error("✗ createMarketOrder (teste local):", e?.message ?? e);
    }
  }

  console.log(`
--- Interpretação rápida ---
• Se L1 falhou: chave errada ou rede / CLOB indisponível.
• Se L2 (balance / open orders) falhou: API key ou headers L2 (ex.: relógio) — não é o mesmo que "invalid signature" no postOrder.
• "invalid signature" no bot aparece só ao POST da ordem (EIP-712 da ordem). Este script não envia ordens.

Opcional: POLYMARKET_TEST_TOKEN_ID no .env — monta e assina uma ordem de mercado localmente (não faz POST).
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
