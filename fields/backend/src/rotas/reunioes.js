import express from "express";
import { aw, ctxDe, responder } from "../lib/rota.js";
import * as reunioes from "../servicos/reunioes.js";

// Agenda. URLs e JSON idênticos aos do server.js monolítico (mais o `must` aceito no POST).
export function rotasReunioes({ db }) {
  const r = express.Router();

  // GET /api/meetings?from=YYYY-MM-DD&to=YYYY-MM-DD
  r.get("/meetings", aw(async (req, res) => {
    res.json({ meetings: await reunioes.listarReunioes(db, ctxDe(req), req.query) });
  }));

  r.post("/meetings", aw(async (req, res) => {
    responder(res, await reunioes.criarReuniao(db, ctxDe(req), req.body), 201, (meeting) => ({ meeting }));
  }));

  r.patch("/meetings/:id", aw(async (req, res) => {
    responder(res, await reunioes.atualizarReuniao(db, ctxDe(req), req.params.id, req.body), 200, (meeting) => ({ meeting }));
  }));

  r.delete("/meetings/:id", aw(async (req, res) => {
    responder(res, await reunioes.excluirReuniao(db, ctxDe(req), req.params.id), 200, () => ({ success: true }));
  }));

  return r;
}
