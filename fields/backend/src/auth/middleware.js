// exigirAuth: toda rota de /api passa por aqui, exceto /api/health e o login.
//
// Duas portas, e a origem fica marcada em req.origem:
//   - cookie fields_s assinado        → 'web'  (o front, mesma origem pelo rewrite da Vercel)
//   - Authorization: Bearer <token>   → 'mcp'  (o servidor MCP; também a porta de recuperação)
// Com cabeçalho Authorization presente, ele decide sozinho: Bearer errado é 401 mesmo com cookie.
//
// CSRF: mutação autenticada por cookie exige Content-Type application/json. Um formulário de outro
// site não consegue mandar JSON sem preflight, e sem CORS o preflight falha; somado ao
// SameSite=Lax, a mutação forjada não chega. Bearer não viaja sozinho no navegador, então é isento.

import { log } from "../lib/log.js";
import { COOKIE_SESSAO, lerCookie, segredosIguais, verificarCookieSessao } from "./sessao.js";

const MUTACOES = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const ehJson = (req) =>
  String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json";

/** rotaDe(req) devolve o TEMPLATE da rota — o log nunca leva o path cru com ids. */
export function criarExigirAuth({ config, rotaDe }) {
  function negar(req, res, motivo, status = 401, corpo = { error: "nao_autenticado" }) {
    log.warn("AUTH_NEGADO", { motivo, rota: rotaDe(req), metodo: req.method });
    res.locals.motivo = motivo;
    return res.status(status).json(corpo);
  }

  return function exigirAuth(req, res, next) {
    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
      if (!m) return negar(req, res, "BEARER_MALFORMADO");
      if (!segredosIguais(m[1], config.apiToken)) return negar(req, res, "BEARER_INVALIDO");
      req.origem = "mcp";
      return next();
    }

    const valor = lerCookie(req.headers.cookie, COOKIE_SESSAO);
    if (!valor) return negar(req, res, "SEM_CREDENCIAL");
    const sessao = verificarCookieSessao(valor, config.segredoSessao);
    if (!sessao.ok) return negar(req, res, `COOKIE_${sessao.motivo}`);

    if (MUTACOES.has(req.method) && !ehJson(req)) {
      return negar(req, res, "CONTENT_TYPE_NAO_JSON", 415, { error: "content_type_invalido" });
    }
    req.origem = "web";
    return next();
  };
}
