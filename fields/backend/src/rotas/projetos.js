import express from "express";
import { aw, ctxDe, responder } from "../lib/rota.js";
import * as projetos from "../servicos/projetos.js";
import * as frentes from "../servicos/frentes.js";
import * as tarefas from "../servicos/tarefas.js";

const SUCESSO = () => ({ success: true });

// Projetos, frentes e tarefas. URLs e JSON idênticos aos do server.js monolítico.
export function rotasProjetos({ db }) {
  const r = express.Router();

  // ─── Projetos ───
  r.get("/projects", aw(async (req, res) => {
    res.json({ projects: await projetos.listarProjetos(db, ctxDe(req)) });
  }));

  r.post("/projects", aw(async (req, res) => {
    responder(res, await projetos.criarProjeto(db, ctxDe(req), req.body), 201, (project) => ({ project }));
  }));

  r.patch("/projects/:id", aw(async (req, res) => {
    responder(res, await projetos.atualizarProjeto(db, ctxDe(req), req.params.id, req.body), 200, SUCESSO);
  }));

  r.delete("/projects/:id", aw(async (req, res) => {
    responder(res, await projetos.excluirProjeto(db, ctxDe(req), req.params.id), 200, SUCESSO);
  }));

  // ─── Frentes ───
  r.post("/projects/:projectId/frentes", aw(async (req, res) => {
    responder(res, await frentes.criarFrente(db, ctxDe(req), req.params.projectId, req.body), 201, (frente) => ({ frente }));
  }));

  r.patch("/frentes/:id", aw(async (req, res) => {
    responder(res, await frentes.atualizarFrente(db, ctxDe(req), req.params.id, req.body), 200, SUCESSO);
  }));

  r.delete("/frentes/:id", aw(async (req, res) => {
    responder(res, await frentes.excluirFrente(db, ctxDe(req), req.params.id), 200, SUCESSO);
  }));

  // ─── Tarefas ───
  r.post("/frentes/:frenteId/tasks", aw(async (req, res) => {
    responder(res, await tarefas.criarTarefa(db, ctxDe(req), req.params.frenteId, req.body), 201, (task) => ({ task }));
  }));

  r.patch("/tasks/:id", aw(async (req, res) => {
    responder(res, await tarefas.atualizarTarefa(db, ctxDe(req), req.params.id, req.body), 200, SUCESSO);
  }));

  r.delete("/tasks/:id", aw(async (req, res) => {
    responder(res, await tarefas.excluirTarefa(db, ctxDe(req), req.params.id), 200, SUCESSO);
  }));

  return r;
}
