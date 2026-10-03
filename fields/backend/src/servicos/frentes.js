// Frentes de um projeto. Assinatura: (db, ctx, ...args). Todo SQL de `frentes` mora aqui.

import { v4 as uuidv4 } from "uuid";
import { sucesso, recusa } from "../lib/erros.js";
import { toFrente } from "./serializadores.js";

export const CAMPOS_EDITAVEIS_FRENTE = ["name", "sort_order"];

/** Projeto inexistente estoura na FK (500), como sempre estourou. */
export async function criarFrente(db, _ctx, projectId, { name } = {}) {
  if (!name) return recusa("NOME_OBRIGATORIO");
  const id = uuidv4();
  const { rows: cnt } = await db.query("SELECT COUNT(*) FROM frentes WHERE project_id=$1", [projectId]);
  await db.query(
    "INSERT INTO frentes (id, project_id, name, sort_order) VALUES ($1,$2,$3,$4)",
    [id, projectId, name, parseInt(cnt[0].count) || 0]
  );
  const { rows } = await db.query("SELECT * FROM frentes WHERE id=$1", [id]);
  return sucesso({ ...toFrente(rows[0]), tasks: [] });
}

export async function atualizarFrente(db, _ctx, id, campos = {}) {
  const sets = []; const params = [];
  CAMPOS_EDITAVEIS_FRENTE.forEach(f => { if (campos[f] !== undefined) { params.push(campos[f]); sets.push(`${f} = $${params.length}`); } });
  if (!sets.length) return recusa("NADA_A_ATUALIZAR");
  params.push(id);
  await db.query(`UPDATE frentes SET ${sets.join(",")} WHERE id=$${params.length}`, params);
  return sucesso(true);
}

export async function excluirFrente(db, _ctx, id) {
  await db.query("DELETE FROM frentes WHERE id=$1", [id]);
  return sucesso(true);
}
