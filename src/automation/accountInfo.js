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
        const address = await clob.signer.getAddress();
        
        // 1. Array de valor das posições
        const valRes = await fetch(`https://data-api.polymarket.com/value?user=${address}`);
        if (valRes.ok) {
            const valData = await valRes.json();
            if (Array.isArray(valData) && valData.length > 0 && valData[0].value !== undefined) {
                const posValueUsd = Number(valData[0].value);
                portfolioTotal += posValueUsd * 1e6;
            }
        }

        // 2. Tenta listar posições ativas para contagem
        const posRes = await fetch(`https://data-api.polymarket.com/positions?user=${address}`);
        if (posRes.ok) {
            const positions = await posRes.json();
            if (Array.isArray(positions)) {
                // Filtra posições que não estejam zeradas (size > 0)
                const active = positions.filter(p => Number(p.size) > 0);
                if (active.length > 0) {
                    hasOpenPositions = true;
                    openPositionsCount = active.length;
                }
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
