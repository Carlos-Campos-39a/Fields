import express from "express";
import { aw, ctxDe, responder } from "../lib/rota.js";
import * as entradas from "../servicos/entradas.js";

const SUCESSO = () => ({ success: true });

// URLs e JSON idênticos aos do server.js monolítico. /upcoming e /stats antes de /:id.
// A1: + POST /entries/:id/restaurar. O DELETE passou a ser lógico, com as respostas de sempre.
export function rotasEntradas({ db, estado }) {
  const r = express.Router();
  const ctx = (req) => ctxDe(req, estado);

  r.get("/entries", aw(async (req, res) => {
    const lista = await entradas.listarEntradas(db, ctx(req), req.query);
    res.json({ entries: lista, total: lista.length });
  }));

  r.get("/entries/upcoming", aw(async (req, res) => {
    res.json({ entries: await entradas.proximasEntradas(db, ctx(req), req.query) });
  }));

  r.get("/entries/stats", aw(async (req, res) => {
    res.json(await entradas.estatisticasEntradas(db, ctx(req)));
  }));

  r.get("/entries/:id", aw(async (req, res) => {
    responder(res, await entradas.obterEntrada(db, ctx(req), req.params.id));
  }));

  r.post("/entries", aw(async (req, res) => {
    responder(res, await entradas.criarEntrada(db, ctx(req), req.body), 201, (entry) => ({ entry }));
  }));

  r.patch("/entries/:id", aw(async (req, res) => {
    responder(res, await entradas.atualizarEntrada(db, ctx(req), req.params.id, req.body), 200, (entry) => ({ entry }));
  }));

  // Inexistente ou já excluída → 404, como o DELETE físico sempre respondeu.
  r.delete("/entries/:id", aw(async (req, res) => {
    responder(res, await entradas.excluirEntrada(db, ctx(req), req.params.id), 200, SUCESSO);
  }));

  r.post("/entries/:id/restaurar", aw(async (req, res) => {
    responder(res, await entradas.restaurarEntrada(db, ctx(req), req.params.id), 200, SUCESSO);
  }));

  return r;
}
