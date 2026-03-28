import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "../config.js";

/** Adapta ethers v6 (signTypedData) ao formato esperado pelo CLOB ( _signTypedData ). */
export function walletToClobSigner(wallet) {
  return {
    getAddress: () => wallet.getAddress(),
    _signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value)
  };
}

let clientPromise = null;

export function resetLiveClobClient() {
  clientPromise = null;
}

/**
 * Cliente assinado com API L2 (createOrDeriveApiKey na primeira chamada).
 */
export async function getOrCreateClobClient() {
  const pk = (CONFIG.live.privateKey || "").trim();
  if (!pk) {
    throw new Error("POLYMARKET_PRIVATE_KEY ausente");
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
      const signer = walletToClobSigner(wallet);
      const host = CONFIG.clobBaseUrl.replace(/\/$/, "");
      const chainId = CONFIG.live.chainId;
      const temp = new ClobClient(host, chainId, signer);
      const creds = await temp.createOrDeriveApiKey();
      const funder = (CONFIG.live.funderAddress || "").trim();
      return new ClobClient(
        host,
        chainId,
        signer,
        creds,
        CONFIG.live.signatureType,
        funder || undefined
      );
    })();
  }

  return clientPromise;
}
