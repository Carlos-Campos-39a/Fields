import express from "express";
import { aw, ctxDe, responder, responderExclusaoLegada } from "../lib/rota.js";
import * as reunioes from "../servicos/reunioes.js";

// Agenda. URLs e JSON idênticos aos do server.js monolítico (mais o `must` aceito no POST).
// A1: + POST /meetings/:id/restaurar. O DELETE passou a ser lógico, com o {success:true} de sempre.
export function rotasReunioes({ db, estado }) {
  const r = express.Router();
  const ctx = (req) => ctxDe(req, estado);

  // GET /api/meetings?from=YYYY-MM-DD&to=YYYY-MM-DD
  r.get("/meetings", aw(async (req, res) => {
    res.json({ meetings: await reunioes.listarReunioes(db, ctx(req), req.query) });
  }));

  r.post("/meetings", aw(async (req, res) => {
    responder(res, await reunioes.criarReuniao(db, ctx(req), req.body), 201, (meeting) => ({ meeting }));
  }));

  r.patch("/meetings/:id", aw(async (req, res) => {
    responder(res, await reunioes.atualizarReuniao(db, ctx(req), req.params.id, req.body), 200, (meeting) => ({ meeting }));
  }));

  r.delete("/meetings/:id", aw(async (req, res) => {
    responderExclusaoLegada(res, await reunioes.excluirReuniao(db, ctx(req), req.params.id));
  }));

  r.post("/meetings/:id/restaurar", aw(async (req, res) => {
    responder(res, await reunioes.restaurarReuniao(db, ctx(req), req.params.id), 200, () => ({ success: true }));
  }));

  return r;
}
