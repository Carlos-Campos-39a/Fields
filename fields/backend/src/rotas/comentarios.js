import express from "express";
import { aw, ctxDe, responder } from "../lib/rota.js";
import * as comentarios from "../servicos/comentarios.js";

const SUCESSO = () => ({ success: true });

// A1: comentários como linhas próprias. Com a migração comentarios_v1 falhada (modo legado), as
// quatro respondem 503 comentarios_indisponiveis — os arrays legados seguem funcionando pelo PATCH
// da entidade, como na A0.
export function rotasComentarios({ db, estado }) {
  const r = express.Router();
  const ctx = (req) => ctxDe(req, estado);

  // GET /api/comentarios?alvo_tipo=TAREFA&alvo_id=<id>
  r.get("/comentarios", aw(async (req, res) => {
    const { alvo_tipo, alvo_id } = req.query;
    responder(res, await comentarios.listarComentarios(db, ctx(req), { alvo_tipo, alvo_id }), 200, (lista) => ({ comentarios: lista }));
  }));

  r.post("/comentarios", aw(async (req, res) => {
    responder(res, await comentarios.criarComentario(db, ctx(req), req.body ?? {}), 201, (comentario) => ({ comentario }));
  }));

  r.delete("/comentarios/:id", aw(async (req, res) => {
    responder(res, await comentarios.excluirComentario(db, ctx(req), req.params.id), 200, SUCESSO);
  }));

  r.post("/comentarios/:id/restaurar", aw(async (req, res) => {
    responder(res, await comentarios.restaurarComentario(db, ctx(req), req.params.id), 200, SUCESSO);
  }));

  return r;
}
