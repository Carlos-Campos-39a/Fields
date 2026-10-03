import express from "express";
import { log } from "../lib/log.js";
import { aw } from "../lib/rota.js";
import { COOKIE_SESSAO, DURACAO_SESSAO_S, emitirCookieSessao, verificarSenha } from "../auth/sessao.js";

const OPCOES_COOKIE = { httpOnly: true, secure: true, sameSite: "lax", path: "/" };

/**
 * POST /api/auth/login — PÚBLICA. {senha} → 204 + Set-Cookie fields_s.
 * O corpo é lido aqui, com teto pequeno: a rota é pública e não deve aceitar 1 MB de quem não
 * se autenticou.
 */
export function rotasLogin({ config, limitador }) {
  const r = express.Router();
  r.post("/auth/login", express.json({ limit: "10kb" }), aw(async (req, res) => {
    const ip = req.ip || "desconhecido";
    const bloqueio = limitador.bloqueio(ip);
    if (bloqueio) {
      log.warn("AUTH_LOGIN_FALHA", { motivo: bloqueio.motivo, ip });
      res.locals.motivo = bloqueio.motivo;
      res.set("Retry-After", String(Math.max(1, bloqueio.retryAfterS)));
      return res.status(429).json({ error: "muitas_tentativas" });
    }

    const senha = req.body?.senha;
    if (typeof senha !== "string" || !senha) {
      log.warn("AUTH_LOGIN_FALHA", { motivo: "SENHA_AUSENTE", ip });
      res.locals.motivo = "SENHA_AUSENTE";
      return res.status(400).json({ error: "senha_obrigatoria" });
    }

    // Reserva a vaga ANTES do scrypt e sem await desde o `bloqueio`: a tentativa em voo já conta,
    // então uma rajada concorrente não passa do teto (ver limitador.js). Errou → nada a fazer.
    const marca = limitador.reservar(ip);
    if (!(await verificarSenha(senha, config.senhaHash))) {
      log.warn("AUTH_LOGIN_FALHA", { motivo: "SENHA_ERRADA", ip });
      res.locals.motivo = "SENHA_ERRADA";
      return res.status(401).json({ error: "nao_autenticado" });
    }

    limitador.confirmarSucesso(ip, marca);
    res.cookie(COOKIE_SESSAO, emitirCookieSessao(config.segredoSessao), {
      ...OPCOES_COOKIE, maxAge: DURACAO_SESSAO_S * 1000,
    });
    log.info("AUTH_LOGIN_OK", { ip });
    return res.status(204).end();
  }));
  return r;
}

/** POST /api/auth/logout e GET /api/auth/me — atrás do exigirAuth. */
export function rotasAuth() {
  const r = express.Router();
  r.post("/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE_SESSAO, OPCOES_COOKIE);
    res.status(204).end();
  });
  r.get("/auth/me", (req, res) => {
    res.json({ autenticado: true, origem: req.origem });
  });
  return r;
}
