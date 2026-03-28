import { ClobClient } from "@polymarket/clob-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { Wallet, getAddress } from "ethers";
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
 * Credenciais locais do Builder (Polymarket UI: Relayer / Builder API Keys).
 * O SDK exige key + secret + passphrase. Variáveis Railway sugeridas:
 * - RELAYER_API_KEY_ADDRESS → campo `key` (no UI costuma ser o id da key ou o endereço indicado)
 * - RELAYER_API_SECRET + RELAYER_API_PASSPHRASE → secret e passphrase (mostrados uma vez ao criar a key)
 * - Ou RELAYER_API_KEY = JSON: {"secret":"...","passphrase":"..."}
 * - Fallback: RELAYER_API_KEY numa linha = secret e passphrase iguais (raro; só se o site exportar um único segredo)
 */
export function parseRelayerBuilderCreds() {
  const r = CONFIG.relayer;
  const key = String(r.apiKeyAddress || "").trim();
  if (!key) return null;

  let secret = String(r.apiSecret || "").trim();
  let passphrase = String(r.apiPassphrase || "").trim();
  const blob = String(r.apiKeyBlob || "").trim();

  if ((!secret || !passphrase) && blob) {
    try {
      const o = JSON.parse(blob);
      if (o && typeof o.secret === "string" && typeof o.passphrase === "string") {
        secret = o.secret.trim();
        passphrase = o.passphrase.trim();
      }
    } catch {
      const lines = blob
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.length >= 2) {
        secret = lines[0];
        passphrase = lines[1];
      } else if (blob.length > 0) {
        secret = blob;
        passphrase = blob;
      }
    }
  }

  if (!secret || !passphrase) return null;
  return { key, secret, passphrase };
}

export function tryCreateRelayerBuilderConfig() {
  const creds = parseRelayerBuilderCreds();
  if (!creds) return undefined;
  try {
    return new BuilderConfig({ localBuilderCreds: creds });
  } catch (e) {
    throw new Error(
      `RELAYER/Builder: credenciais inválidas para BuilderConfig (${e?.message ?? e}). ` +
        "Confirma key + secret + passphrase (ver RELAYER_API_SECRET / RELAYER_API_PASSPHRASE ou JSON em RELAYER_API_KEY)."
    );
  }
}

/** Indica se o ambiente tem dados suficientes para tentar injetar cabeçalhos Builder no postOrder. */
export function isRelayerBuilderConfigured() {
  return parseRelayerBuilderCreds() != null;
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
      // Mesmo useServerTime que no cliente final: L1 (derivar API key) e L2 alinham ao relógio do CLOB.
      const temp = new ClobClient(host, chainId, signer, undefined, undefined, undefined, undefined, true);
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
      const builderConfig = tryCreateRelayerBuilderConfig();

      // useServerTime: timestamps L2 alinhados ao servidor (menos falhas opacas).
      // Não forçar POLY_ADDRESS=funder: a API responde *order signer address has to be the address of the API KEY* (EOA).
      // Com BuilderConfig válido, postOrder injeta POLY_BUILDER_* (Relayer / Builder API no painel Polymarket).
      return new ClobClient(
        host,
        chainId,
        signer,
        creds,
        CONFIG.live.signatureType,
        funderNorm,
        undefined,
        true,
        builderConfig,
        undefined,
        undefined,
        undefined,
        true
      );
    })();
  }

  return clientPromise;
}
