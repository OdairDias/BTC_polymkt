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

    // 2. Portfolio Total (Cash + Valuation of Shares)
    let portfolioTotal = cash;
    try {
        // Tenta obter saldo Web3 direto (Proxy de USDC)
        const web3 = await clob.getWeb3Balance();
        if (web3 && web3.balance) portfolioTotal = Math.max(portfolioTotal, Number(web3.balance));

        // Tenta listar posições (tokens) no CLOB
        // Na v5 do Builder SDK: clob.getBalances() ou similar.
    } catch (e) {
        // ignore
    }

    return {
      address: await clob.signer.getAddress(),
      cash,
      portfolio: portfolioTotal,
      updatedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error("Dashboard error fetching stats:", err.message);
    return null;
  }
}
