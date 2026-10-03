// criarApp({config, db}) monta o Express sem abrir porta nem banco: o teste injeta um db falso e
// roda sem Postgres. O bootstrap (server.js) passa o pool real.
//
// Ordem: log de request → rotas públicas (health, login) → exigirAuth → JSON → rotas protegidas
// → tratador de erro. Sem pacote cors e sem cabeçalho CORS nenhum: o front chega pela mesma
// origem (rewrite da Vercel em produção, proxy do Vite em dev).

import express from "express";
import { log } from "./lib/log.js";
import { ErroDominio } from "./lib/erros.js";
import { rotaDe as rotaDaTabela, tabelaDeRotas } from "./lib/rota.js";
import { criarExigirAuth } from "./auth/middleware.js";
import { criarLimitador } from "./auth/limitador.js";
import { rotasSaude } from "./rotas/saude.js";
import { rotasAuth, rotasLogin } from "./rotas/auth.js";
import { rotasEntradas } from "./rotas/entradas.js";
import { rotasProjetos } from "./rotas/projetos.js";
import { rotasReunioes } from "./rotas/reunioes.js";

/** As únicas rotas que respondem sem credencial. Um teste trava esta lista. */
export const ROTAS_PUBLICAS = Object.freeze(["GET /api/health", "POST /api/auth/login"]);

const PG_CODIGO = /^[0-9A-Z]{5}$/; // SQLSTATE: seguro de logar, ao contrário da mensagem do pg

export function criarApp({ config, db, limitador = criarLimitador() } = {}) {
  if (!config) throw new TypeError("criarApp: config é obrigatória");
  if (!db) throw new TypeError("criarApp: db é obrigatório");

  const app = express();
  app.set("trust proxy", true); // Railway (e a Vercel na frente): req.ip vem do X-Forwarded-For
  app.disable("x-powered-by");

  const publicas = [rotasSaude(), rotasLogin({ config, limitador })];
  const protegidas = [rotasAuth(), rotasEntradas({ db }), rotasProjetos({ db }), rotasReunioes({ db })];
  const tabela = tabelaDeRotas("/api", [...publicas, ...protegidas]);
  const rotaDe = (req) => rotaDaTabela(req, tabela);
  app.locals.rotas = tabela.map(({ metodo, template }) => ({ metodo, template }));

  // ─── HTTP_REQ: uma linha por request, com o TEMPLATE da rota (nunca o path cru) ───
  app.use((req, res, next) => {
    const inicio = process.hrtime.bigint();
    res.on("finish", () => {
      const status = res.statusCode;
      const nivel = status >= 500 ? "erro" : status >= 400 ? "warn" : "info";
      log[nivel]("HTTP_REQ", {
        metodo: req.method,
        rota: rotaDe(req),
        status,
        duration_ms: Math.round(Number(process.hrtime.bigint() - inicio) / 1e5) / 10,
        origem: req.origem,
        motivo: res.locals.motivo,
      });
    });
    next();
  });

  app.use("/api", ...publicas);
  app.use("/api", criarExigirAuth({ config, rotaDe }), express.json({ limit: "1mb" }), ...protegidas);

  // ─── Tratador final ───
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof ErroDominio) {
      res.locals.motivo = err.codigo;
      return res.status(err.status).json({ error: err.mensagem, codigo: err.codigo });
    }

    // Erro do body-parser (JSON malformado, corpo grande demais…): é do cliente, com status 4xx.
    if (err?.expose && err.status >= 400 && err.status < 500) {
      res.locals.motivo = String(err.type ?? "REQUISICAO_INVALIDA").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      const error = err.type === "entity.parse.failed" ? "json_invalido"
        : err.type === "entity.too.large" ? "corpo_grande_demais" : "requisicao_invalida";
      return res.status(err.status).json({ error });
    }

    // A mensagem NUNCA vai ao cliente nem ao log: a do pg carrega valores ("invalid input syntax
    // for type json: <o dado>"). Vão o nome, o SQLSTATE e a pilha sem a primeira linha.
    log.erro("HTTP_ERRO", {
      metodo: req.method,
      rota: rotaDe(req),
      erro: err?.name ?? typeof err,
      pg_codigo: PG_CODIGO.test(err?.code ?? "") ? err.code : undefined,
      pilha: typeof err?.stack === "string" ? err.stack.split("\n").slice(1, 7).map((l) => l.trim()) : undefined,
    });
    return res.status(500).json({ error: "erro_interno" });
  });

  return app;
}
