import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "../config.js";

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Chave privada EVM (Polygon) = 32 bytes em hex (64 caracteres), opcional prefixo 0x.
 * Base58 / Solana / texto aleatório falha aqui com mensagem clara.
 */
export function normalizeEvmPrivateKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const body = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  return body;
}

export function assertValidEvmPrivateKeyForClob(raw) {
  const body = normalizeEvmPrivateKey(raw);
  if (!body) {
    throw new Error("POLYMARKET_PRIVATE_KEY ausente");
  }
  if (!HEX64.test(body)) {
    throw new Error(
      "POLYMARKET_PRIVATE_KEY inválida: tem de ser 64 caracteres hexadecimais (0-9, a-f), " +
        "opcionalmente com prefixo 0x — é a chave da conta Ethereum/Polygon no Phantom, não o address público nem chave Solana/Base58."
    );
  }
  return `0x${body}`;
}

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
  const pkRaw = (CONFIG.live.privateKey || "").trim();
  const pk = assertValidEvmPrivateKeyForClob(pkRaw);

  if (!clientPromise) {
    clientPromise = (async () => {
      const wallet = new Wallet(pk);
      const signer = walletToClobSigner(wallet);
      const host = CONFIG.clobBaseUrl.replace(/\/$/, "");
      const chainId = CONFIG.live.chainId;
      const temp = new ClobClient(host, chainId, signer);
      const creds = await temp.createOrDeriveApiKey();
      const funder = (CONFIG.live.funderAddress || "").trim();
      // throwOnError=true: respostas com campo `error` passam a lançar (evita “sucesso” falso).
      return new ClobClient(
        host,
        chainId,
        signer,
        creds,
        CONFIG.live.signatureType,
        funder || undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true
      );
    })();
  }

  return clientPromise;
}
