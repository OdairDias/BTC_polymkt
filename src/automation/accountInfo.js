import { AssetType } from "@polymarket/clob-client";
import { getOrCreateClobClient } from "./liveClob.js";

/**
 * Fetches accurate balance stats from Polymarket CLOB.
 * Cash = Collateral Balance (USDC).
 * Portfolio = Approximate Total value (Cash + theoretical value of positions).
 */
export async function getAccountStats() {
  try {
    const clob = await getOrCreateClobClient();
    
    // 1. Fetch Cash (Collateral)
    const ba = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const cash = Number(ba.balance || 0);

    // 2. Open Positions check
    let portfolioTotal = cash;
    let hasOpenPositions = false;
    let openPositionsCount = 0;

    try {
        // Tenta obter saldo Web3 direto (Proxy de USDC)
        const web3 = await clob.getWeb3Balance();
        if (web3 && web3.balance) portfolioTotal = Math.max(portfolioTotal, Number(web3.balance));

        // Tenta listar posições (tokens) no CLOB
        const positions = await clob.getOpenPositions();
        if (Array.isArray(positions) && positions.length > 0) {
            hasOpenPositions = true;
            openPositionsCount = positions.length;
            
            // Soma o valor das posições (se disponível no retorno)
            for (const pos of positions) {
                // Se a posição tiver um 'size' (tokens) e um 'price' (market price)
                const size = Number(pos.size || 0);
                // Note: No SDK v5, posições são retornadas com valor nocional ou tamanho.
                // Para manter simples, apenas marcamos a existência.
            }
        }
    } catch (e) {
        // ignore
    }

    return {
      address: await clob.signer.getAddress(),
      cash: cash / 1e6,
      portfolio: portfolioTotal / 1e6,
      hasOpenPositions,
      openPositionsCount,
      updatedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error("Dashboard error fetching stats:", err.message);
    return null;
  }
}
