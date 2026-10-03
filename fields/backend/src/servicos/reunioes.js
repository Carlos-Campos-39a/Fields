// Reuniões (Agenda). Assinatura: (db, ctx, ...args). Todo SQL de `meetings` mora aqui.

import { v4 as uuidv4 } from "uuid";
import { sucesso, recusa } from "../lib/erros.js";
import { toMeeting } from "./serializadores.js";

export const CAMPOS_EDITAVEIS_REUNIAO = ["title", "date", "start_time", "end_time", "description", "comments", "must"];
const CAMPOS_JSONB = ["comments"];

/** from+to → intervalo fechado; só from → dali em diante; nada → todas. */
export async function listarReunioes(db, _ctx, { from, to } = {}) {
  let q = "SELECT * FROM meetings";
  const params = [];
  if (from && to) {
    q += " WHERE date >= $1 AND date <= $2";
    params.push(from, to);
  } else if (from) {
    q += " WHERE date >= $1";
    params.push(from);
  }
  q += " ORDER BY date, start_time, created_at";
  const { rows } = await db.query(q, params);
  return rows.map(toMeeting);
}

// `must` passou a ser gravado na criação: antes o POST o descartava em silêncio e só o PATCH o
// aceitava — a reunião criada com "must" voltava com must "".
export async function criarReuniao(db, _ctx, { title, date, start_time = "", end_time = "", description = "", must = "" } = {}) {
  if (!title || !date) return recusa("TITULO_E_DATA_OBRIGATORIOS");
  const id = uuidv4();
  await db.query(
    "INSERT INTO meetings (id, title, date, start_time, end_time, description, comments, must) VALUES ($1,$2,$3,$4,$5,$6,'[]',$7)",
    [id, title, date, start_time, end_time, description, must ?? ""]
  );
  const { rows } = await db.query("SELECT * FROM meetings WHERE id=$1", [id]);
  return sucesso(toMeeting(rows[0]));
}

export async function atualizarReuniao(db, _ctx, id, campos = {}) {
  const sets = []; const params = [];
  CAMPOS_EDITAVEIS_REUNIAO.forEach(f => {
    if (campos[f] !== undefined) {
      params.push(CAMPOS_JSONB.includes(f) ? JSON.stringify(campos[f]) : campos[f]);
      sets.push(`${f} = $${params.length}`);
    }
  });
  if (!sets.length) return recusa("NADA_A_ATUALIZAR");
  params.push(id);
  const { rows } = await db.query(
    `UPDATE meetings SET ${sets.join(",")} WHERE id=$${params.length} RETURNING *`, params
  );
  if (rows.length === 0) return recusa("NAO_ENCONTRADO");
  return sucesso(toMeeting(rows[0]));
}

export async function excluirReuniao(db, _ctx, id) {
  await db.query("DELETE FROM meetings WHERE id=$1", [id]);
  return sucesso(true);
}
