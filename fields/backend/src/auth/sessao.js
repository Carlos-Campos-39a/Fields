// Senha (scrypt) e cookie de sessão (HMAC). Sem dependência: só node:crypto.
// Toda comparação de segredo é em tempo constante — e timingSafeEqual LANÇA com tamanhos
// diferentes, então o tamanho é conferido (ou igualado) antes.

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

// N=2^14, r=8, p=5: o equivalente do OWASP Password Storage Cheat Sheet a N=2^17/p=1, com 16 MB
// de memória por hash em vez de 128 MB (cabe no maxmem padrão do Node e numa instância pequena).
export const PARAMS_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 5 });
export const TAMANHO_HASH = 64;
export const COOKIE_SESSAO = "fields_s";
export const DURACAO_SESSAO_S = 30 * 24 * 60 * 60; // 2592000 = Max-Age do cookie
const SENHA_MAX = 1024; // senha absurda não chega ao scrypt

const opcoesScrypt = ({ N, r, p }) => ({ N, r, p, maxmem: 256 * N * r }); // 2× o mínimo (128·N·r)

/**
 * "scrypt$<N>$<r>$<p>$<sal base64>$<hash base64>" — o formato de FIELDS_SENHA_HASH.
 * Os parâmetros vão DENTRO do hash: subir o custo depois não invalida o hash que já está no env.
 */
export async function gerarHashSenha(senha, sal = randomBytes(16)) {
  const { N, r, p } = PARAMS_SCRYPT;
  const hash = await scryptAsync(String(senha).normalize("NFC"), sal, TAMANHO_HASH, opcoesScrypt(PARAMS_SCRYPT));
  return `scrypt$${N}$${r}$${p}$${sal.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * {N, r, p, sal, hash} ou null. Os parâmetros são limitados mesmo vindo do env: um N absurdo
 * travaria o processo (e a memória) a cada tentativa de login.
 */
export function lerHashSenha(valor) {
  const partes = String(valor ?? "").split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return null;
  const [N, r, p] = partes.slice(1, 4).map(Number);
  const nValido = Number.isInteger(N) && N >= 2 ** 14 && N <= 2 ** 17 && (N & (N - 1)) === 0;
  if (!nValido || r !== 8 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  const sal = Buffer.from(partes[4], "base64");
  const hash = Buffer.from(partes[5], "base64");
  if (sal.length < 8 || hash.length !== TAMANHO_HASH) return null;
  return { N, r, p, sal, hash };
}

export async function verificarSenha(senha, hashFormatado) {
  if (typeof senha !== "string" || !senha || senha.length > SENHA_MAX) return false;
  const h = lerHashSenha(hashFormatado);
  if (!h) return false;
  const obtido = await scryptAsync(senha.normalize("NFC"), h.sal, TAMANHO_HASH, opcoesScrypt(h));
  return timingSafeEqual(obtido, h.hash); // os dois têm TAMANHO_HASH bytes, garantido acima
}

// ─── Cookie de sessão ─────────────────────────────────────────
// valor = base64url(JSON {exp, n}) + "." + base64url(HMAC-SHA256(segredo, payload)).
// Sem estado no servidor: trocar FIELDS_SEGREDO_SESSAO derruba todas as sessões.

const assinar = (payload, segredo) => createHmac("sha256", segredo).update(payload).digest();

export function emitirCookieSessao(segredo, agoraMs = Date.now()) {
  const exp = Math.floor(agoraMs / 1000) + DURACAO_SESSAO_S;
  const payload = Buffer.from(JSON.stringify({ exp, n: randomBytes(12).toString("base64url") })).toString("base64url");
  return `${payload}.${assinar(payload, segredo).toString("base64url")}`;
}

/** {ok:true, exp} ou {ok:false, motivo} — motivo ∈ AUSENTE, FORMATO, ASSINATURA, PAYLOAD, EXPIRADO. */
export function verificarCookieSessao(valor, segredo, agoraMs = Date.now()) {
  if (!valor) return { ok: false, motivo: "AUSENTE" };
  const partes = String(valor).split(".");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return { ok: false, motivo: "FORMATO" };
  const [payload, assinatura] = partes;
  const esperada = assinar(payload, segredo);
  const recebida = Buffer.from(assinatura, "base64url");
  if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) {
    return { ok: false, motivo: "ASSINATURA" };
  }
  let dados;
  try { dados = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return { ok: false, motivo: "PAYLOAD" }; }
  if (!dados || typeof dados.exp !== "number") return { ok: false, motivo: "PAYLOAD" };
  if (dados.exp * 1000 <= agoraMs) return { ok: false, motivo: "EXPIRADO" };
  return { ok: true, exp: dados.exp };
}

/**
 * Compara dois segredos em tempo constante, sem lançar com tamanhos diferentes e sem vazar o
 * tamanho pelo tempo: compara os SHA-256 dos dois (sempre 32 bytes).
 */
export function segredosIguais(recebido, esperado) {
  if (typeof recebido !== "string" || typeof esperado !== "string" || !esperado) return false;
  const a = createHash("sha256").update(recebido).digest();
  const b = createHash("sha256").update(esperado).digest();
  return timingSafeEqual(a, b) && recebido.length === esperado.length;
}

/** Lê um cookie do cabeçalho Cookie sem dependência (cookie-parser). */
export function lerCookie(cabecalho, nome) {
  if (!cabecalho) return null;
  for (const parte of String(cabecalho).split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim() || null;
  }
  return null;
}
