// Entradas (notas, eventos, lembretes, idiomas). Todo SQL de `entries` mora aqui.
// Assinatura: (db, ctx, ...args) — ctx = {origem: 'web'|'mcp', turnoId} (o histórico da A1 usa).
// Quem pode dizer "não" devolve recusa(motivo), nunca null mudo.

import { v4 as uuidv4 } from "uuid";
import { hojeISO } from "../lib/datas.js";
import { sucesso, recusa } from "../lib/erros.js";
import { toEntry } from "./serializadores.js";

export const CAMPOS_EDITAVEIS_ENTRADA = ["type", "title", "content", "tags", "date", "time", "pinned", "threads"];
const CAMPOS_JSONB = ["tags", "threads"];

export async function listarEntradas(db, _ctx, { type, search } = {}) {
  let q    = "SELECT * FROM entries WHERE 1=1";
  const params = [];

  if (type && type !== "all") {
    if (type === "pinned") {
      q += " AND pinned = true";
    } else {
      params.push(type);
      q += ` AND type = $${params.length}`;
    }
  }

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const n = params.length;
    q += ` AND (LOWER(title) LIKE $${n} OR LOWER(content) LIKE $${n} OR LOWER(tags::text) LIKE $${n})`;
  }

  q += " ORDER BY pinned DESC, created_at DESC";

  const { rows } = await db.query(q, params);
  return rows.map(toEntry);
}

/** Eventos e lembretes de hoje (fuso de Brasília) em diante. */
export async function proximasEntradas(db, _ctx, { limit } = {}) {
  const today = hojeISO();
  const limite = parseInt(limit) || 5;
  const { rows } = await db.query(
    `SELECT * FROM entries
     WHERE type IN ('event','reminder') AND date >= $1
     ORDER BY date ASC, COALESCE(time,'00:00') ASC
     LIMIT $2`,
    [today, limite]
  );
  return rows.map(toEntry);
}

export async function estatisticasEntradas(db, _ctx) {
  const { rows } = await db.query("SELECT type, pinned FROM entries");
  const stats = { note: 0, event: 0, reminder: 0, lang_fr: 0, lang_jp: 0, pinned: 0, total: rows.length };
  rows.forEach(r => { if (stats[r.type] !== undefined) stats[r.type]++; if (r.pinned) stats.pinned++; });
  return stats;
}

/** A entrada e até 4 relacionadas por tag em comum. */
export async function obterEntrada(db, _ctx, id) {
  const { rows } = await db.query("SELECT * FROM entries WHERE id = $1", [id]);
  if (rows.length === 0) return recusa("NAO_ENCONTRADO");
  const entry = toEntry(rows[0]);

  const { rows: rel } = await db.query(
    `SELECT * FROM entries WHERE id != $1 AND tags ?| $2::text[] LIMIT 4`,
    [entry.id, entry.tags]
  );
  return sucesso({ entry, related: rel.map(toEntry) });
}

export async function criarEntrada(db, _ctx, { type, title, content, tags, date, time, pinned } = {}) {
  if (!title || !content) return recusa("TITULO_E_CONTEUDO_OBRIGATORIOS");

  const id = uuidv4();
  await db.query(
    `INSERT INTO entries (id, type, title, content, tags, date, time, pinned, threads)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]')`,
    [id, type || "note", title.trim(), content.trim(),
     JSON.stringify(Array.isArray(tags) ? tags : []),
     date || hojeISO(),
     time || null, pinned || false]
  );
  const { rows } = await db.query("SELECT * FROM entries WHERE id = $1", [id]);
  return sucesso(toEntry(rows[0]));
}

/** Sem campo editável, só toca updated_at (comportamento de sempre). */
export async function atualizarEntrada(db, _ctx, id, campos = {}) {
  const sets = ["updated_at = NOW()"];
  const params = [];

  CAMPOS_EDITAVEIS_ENTRADA.forEach(f => {
    if (campos[f] !== undefined) {
      params.push(CAMPOS_JSONB.includes(f) ? JSON.stringify(campos[f]) : campos[f]);
      sets.push(`${f} = $${params.length}`);
    }
  });

  params.push(id);
  const { rows } = await db.query(
    `UPDATE entries SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (rows.length === 0) return recusa("NAO_ENCONTRADO");
  return sucesso(toEntry(rows[0]));
}

export async function excluirEntrada(db, _ctx, id) {
  const { rowCount } = await db.query("DELETE FROM entries WHERE id = $1", [id]);
  if (rowCount === 0) return recusa("NAO_ENCONTRADO");
  return sucesso(true);
}
