import express from "express";
import { aw, ctxDe, responder } from "../lib/rota.js";
import * as entradas from "../servicos/entradas.js";

// URLs e JSON idênticos aos do server.js monolítico. /upcoming e /stats antes de /:id.
export function rotasEntradas({ db }) {
  const r = express.Router();

  r.get("/entries", aw(async (req, res) => {
    const lista = await entradas.listarEntradas(db, ctxDe(req), req.query);
    res.json({ entries: lista, total: lista.length });
  }));

  r.get("/entries/upcoming", aw(async (req, res) => {
    res.json({ entries: await entradas.proximasEntradas(db, ctxDe(req), req.query) });
  }));

  r.get("/entries/stats", aw(async (req, res) => {
    res.json(await entradas.estatisticasEntradas(db, ctxDe(req)));
  }));

  r.get("/entries/:id", aw(async (req, res) => {
    responder(res, await entradas.obterEntrada(db, ctxDe(req), req.params.id));
  }));

  r.post("/entries", aw(async (req, res) => {
    responder(res, await entradas.criarEntrada(db, ctxDe(req), req.body), 201, (entry) => ({ entry }));
  }));

  r.patch("/entries/:id", aw(async (req, res) => {
    responder(res, await entradas.atualizarEntrada(db, ctxDe(req), req.params.id, req.body), 200, (entry) => ({ entry }));
  }));

  r.delete("/entries/:id", aw(async (req, res) => {
    responder(res, await entradas.excluirEntrada(db, ctxDe(req), req.params.id), 200, () => ({ success: true }));
  }));

  return r;
}
