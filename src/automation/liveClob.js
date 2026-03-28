import { ClobClient, SignatureType } from "@polymarket/clob-client";
import axios from "axios";
import { Wallet, getAddress } from "ethers";
import { CONFIG } from "../config.js";

/** id do interceptor Axios (workaround #248); só regista uma vez. */
let polyProxyPolyAddressInterceptor = null;

/**
 * Polymarket/clob-client#248: com carteira proxy (`signatureType` 1), pedidos L2 devem usar
 * `POLY_ADDRESS` = funder (proxy). O cliente oficial envia sempre a EOA → API pode responder
 * `invalid signature` no postOrder. Corrigimos no mesmo Axios que o clob-client usa.
 * @see https://github.com/Polymarket/clob-client/issues/248
 */
function ensurePolyProxyPolyAddressHeader(funderChecksummed) {
  if (polyProxyPolyAddressInterceptor != null) return;
  polyProxyPolyAddressInterceptor = axios.interceptors.request.use((config) => {
    if (!funderChecksummed) return config;
    const headers = config.headers;
    if (!headers) return config;
    const apiKey =
      typeof headers.get === "function"
        ? headers.get("POLY_API_KEY")
        : headers.POLY_API_KEY ?? headers["POLY_API_KEY"];
    if (!apiKey) return config;
    if (typeof headers.set === "function") {
      headers.set("POLY_ADDRESS", funderChecksummed);
    } else {
      headers.POLY_ADDRESS = funderChecksummed;
    }
    return config;
  });
}

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
      const funderRaw = (CONFIG.live.funderAddress || "").trim();
      let funderNorm;
      if (funderRaw) {
        try {
          funderNorm = getAddress(funderRaw);
        } catch {
          throw new Error(
            "POLYMARKET_FUNDER_ADDRESS inválido: tem de ser um endereço EVM (0x + 40 hex). Copia do perfil Polymarket."
          );
        }
      }
      if (CONFIG.live.signatureType === SignatureType.POLY_PROXY && funderNorm) {
        ensurePolyProxyPolyAddressHeader(funderNorm);
      }
      // throwOnError=true: respostas com campo `error` passam a lançar (evita “sucesso” falso).
      return new ClobClient(
        host,
        chainId,
        signer,
        creds,
        CONFIG.live.signatureType,
        funderNorm,
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
