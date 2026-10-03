import express from "express";
import { aw, ctxDe, responder, responderExclusaoLegada } from "../lib/rota.js";
import * as projetos from "../servicos/projetos.js";
import * as frentes from "../servicos/frentes.js";
import * as tarefas from "../servicos/tarefas.js";

const SUCESSO = () => ({ success: true });

// Projetos, frentes e tarefas. URLs e JSON idênticos aos do server.js monolítico.
// A1: + POST /{projects|frentes|tasks}/:id/restaurar. O DELETE passou a ser lógico e mantém o
// {success:true} de sempre, mesmo sem ter o que excluir (responderExclusaoLegada).
export function rotasProjetos({ db, estado }) {
  const r = express.Router();
  const ctx = (req) => ctxDe(req, estado);

  // ─── Projetos ───
  r.get("/projects", aw(async (req, res) => {
    res.json({ projects: await projetos.listarProjetos(db, ctx(req)) });
  }));

  r.post("/projects", aw(async (req, res) => {
    responder(res, await projetos.criarProjeto(db, ctx(req), req.body), 201, (project) => ({ project }));
  }));

  r.patch("/projects/:id", aw(async (req, res) => {
    responder(res, await projetos.atualizarProjeto(db, ctx(req), req.params.id, req.body), 200, SUCESSO);
  }));

  r.delete("/projects/:id", aw(async (req, res) => {
    responderExclusaoLegada(res, await projetos.excluirProjeto(db, ctx(req), req.params.id));
  }));

  r.post("/projects/:id/restaurar", aw(async (req, res) => {
    responder(res, await projetos.restaurarProjeto(db, ctx(req), req.params.id), 200, SUCESSO);
  }));

  // ─── Frentes ───
  r.post("/projects/:projectId/frentes", aw(async (req, res) => {
    responder(res, await frentes.criarFrente(db, ctx(req), req.params.projectId, req.body), 201, (frente) => ({ frente }));
  }));

  r.patch("/frentes/:id", aw(async (req, res) => {
    responder(res, await frentes.atualizarFrente(db, ctx(req), req.params.id, req.body), 200, SUCESSO);
  }));

  r.delete("/frentes/:id", aw(async (req, res) => {
    responderExclusaoLegada(res, await frentes.excluirFrente(db, ctx(req), req.params.id));
  }));

  r.post("/frentes/:id/restaurar", aw(async (req, res) => {
    responder(res, await frentes.restaurarFrente(db, ctx(req), req.params.id), 200, SUCESSO);
  }));

  // ─── Tarefas ───
  r.post("/frentes/:frenteId/tasks", aw(async (req, res) => {
    responder(res, await tarefas.criarTarefa(db, ctx(req), req.params.frenteId, req.body), 201, (task) => ({ task }));
  }));

  r.patch("/tasks/:id", aw(async (req, res) => {
    responder(res, await tarefas.atualizarTarefa(db, ctx(req), req.params.id, req.body), 200, SUCESSO);
  }));

  r.delete("/tasks/:id", aw(async (req, res) => {
    responderExclusaoLegada(res, await tarefas.excluirTarefa(db, ctx(req), req.params.id));
  }));

  r.post("/tasks/:id/restaurar", aw(async (req, res) => {
    responder(res, await tarefas.restaurarTarefa(db, ctx(req), req.params.id), 200, SUCESSO);
  }));

  return r;
}
