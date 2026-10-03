// Tarefas de uma frente. Assinatura: (db, ctx, ...args). Todo SQL de `tasks` mora aqui.

import { v4 as uuidv4 } from "uuid";
import { sucesso, recusa } from "../lib/erros.js";
import { toTask } from "./serializadores.js";

export const CAMPOS_EDITAVEIS_TAREFA = ["name", "acao", "status", "stakeholder", "deadline", "holder", "sort_order", "comments", "kanban_status", "start_date"];

// Coluna jsonb recebe JSON.stringify. Um array JS cru vira LITERAL DE ARRAY do Postgres no pg
// ('{"a","b"}'), que não é jsonb válido: era o 500 de todo comentário de task — e o motivo de
// produção ter 31 tasks e zero comentários. O PATCH de meetings sempre serializou; este não.
const CAMPOS_JSONB = ["comments"];

export async function criarTarefa(db, _ctx, frenteId, { name, acao = "", status = "Pendente", stakeholder = "", deadline = null, holder = "" } = {}) {
  if (!name) return recusa("NOME_OBRIGATORIO");
  const id = uuidv4();
  const { rows: cnt } = await db.query("SELECT COUNT(*) FROM tasks WHERE frente_id=$1", [frenteId]);
  await db.query(
    "INSERT INTO tasks (id, frente_id, name, acao, status, stakeholder, deadline, holder, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id, frenteId, name, acao, status, stakeholder, deadline, holder, parseInt(cnt[0].count) || 0]
  );
  const { rows } = await db.query("SELECT * FROM tasks WHERE id=$1", [id]);
  return sucesso(toTask(rows[0]));
}

export async function atualizarTarefa(db, _ctx, id, campos = {}) {
  const sets = []; const params = [];
  CAMPOS_EDITAVEIS_TAREFA.forEach(f => {
    if (campos[f] !== undefined) {
      params.push(CAMPOS_JSONB.includes(f) ? JSON.stringify(campos[f]) : campos[f]);
      sets.push(`${f} = $${params.length}`);
    }
  });
  if (!sets.length) return recusa("NADA_A_ATUALIZAR");
  params.push(id);
  await db.query(`UPDATE tasks SET ${sets.join(",")} WHERE id=$${params.length}`, params);
  return sucesso(true);
}

export async function excluirTarefa(db, _ctx, id) {
  await db.query("DELETE FROM tasks WHERE id=$1", [id]);
  return sucesso(true);
}
