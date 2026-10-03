// Projetos — e a árvore projeto → frentes → tarefas que o GET /api/projects devolve.
// Assinatura: (db, ctx, ...args). Todo SQL de `projects` mora aqui.

import { v4 as uuidv4 } from "uuid";
import { sucesso, recusa } from "../lib/erros.js";
import { toProject, toFrente, toTask } from "./serializadores.js";

export const CAMPOS_EDITAVEIS_PROJETO = ["name", "status", "holder", "sort_order"];

export async function listarProjetos(db, _ctx) {
  const { rows: ps } = await db.query("SELECT * FROM projects ORDER BY sort_order, created_at");
  const { rows: fs } = await db.query("SELECT * FROM frentes ORDER BY sort_order, created_at");
  const { rows: ts } = await db.query("SELECT * FROM tasks ORDER BY sort_order, created_at");

  const fMap = {};
  fs.forEach(f => { fMap[f.id] = { ...toFrente(f), tasks: [] }; });
  ts.forEach(t => { if (fMap[t.frente_id]) fMap[t.frente_id].tasks.push(toTask(t)); });

  return ps.map(p => ({
    ...toProject(p),
    frentes: fs.filter(f => f.project_id === p.id).map(f => fMap[f.id] || { ...toFrente(f), tasks: [] }),
  }));
}

export async function criarProjeto(db, _ctx, { name, status = "Em andamento", holder = "Nós" } = {}) {
  if (!name) return recusa("NOME_OBRIGATORIO");
  const id = uuidv4();
  const { rows: cnt } = await db.query("SELECT COUNT(*) FROM projects");
  await db.query(
    "INSERT INTO projects (id, name, status, holder, sort_order) VALUES ($1,$2,$3,$4,$5)",
    [id, name, status, holder, parseInt(cnt[0].count) || 0]
  );
  const { rows } = await db.query("SELECT * FROM projects WHERE id=$1", [id]);
  return sucesso({ ...toProject(rows[0]), frentes: [] });
}

/** Id inexistente não é recusa: o UPDATE não casa nada e a resposta é a de sempre. */
export async function atualizarProjeto(db, _ctx, id, campos = {}) {
  const sets = []; const params = [];
  CAMPOS_EDITAVEIS_PROJETO.forEach(f => { if (campos[f] !== undefined) { params.push(campos[f]); sets.push(`${f} = $${params.length}`); } });
  if (!sets.length) return recusa("NADA_A_ATUALIZAR");
  params.push(id);
  await db.query(`UPDATE projects SET ${sets.join(",")} WHERE id=$${params.length}`, params);
  return sucesso(true);
}

/** DELETE físico com cascata (frentes e tarefas) — o soft-delete chega na A1. */
export async function excluirProjeto(db, _ctx, id) {
  await db.query("DELETE FROM projects WHERE id=$1", [id]);
  return sucesso(true);
}
