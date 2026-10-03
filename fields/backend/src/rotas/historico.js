import express from "express";
import { aw, ctxDe, responder } from "../lib/rota.js";
import { listarHistorico } from "../servicos/historico.js";

// A1: GET /api/historico/:tipo/:id — tipo ∈ ENTIDADES (senão 400 tipo_invalido); mais novo primeiro.
export function rotasHistorico({ db, estado }) {
  const r = express.Router();

  r.get("/historico/:tipo/:id", aw(async (req, res) => {
    const resultado = await listarHistorico(db, ctxDe(req, estado), req.params.tipo, req.params.id);
    responder(res, resultado, 200, (eventos) => ({ eventos }));
  }));

  return r;
}
