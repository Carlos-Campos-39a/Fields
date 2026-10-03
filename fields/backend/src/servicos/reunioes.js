// Reuniões (Agenda). Assinatura: (db, ctx, ...args). Todo SQL de `meetings` mora aqui.
//
// A1: toda leitura filtra deleted_at IS NULL; excluir é lógico; toda escrita grava o histórico no
// mesmo tx; `comments` sai da tabela `comentarios` quando a migração rodou.

import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { sucesso, recusa } from "../lib/erros.js";
import { toMeeting } from "./serializadores.js";
import { registrar } from "./historico.js";
import { excluirLogico, restaurarLogico } from "./exclusao.js";
import { comentariosMigrados, executarLegado, legadosDe, logarLegado, planejarLegado } from "./comentarios.js";

export const CAMPOS_EDITAVEIS_REUNIAO = ["title", "date", "start_time", "end_time", "description", "comments", "must"];
const CAMPOS_JSONB = ["comments"];

// `comments` só é auditado no modo legado — migrado, cada comentário tem o próprio histórico.
const camposAuditados = (migrados) => CAMPOS_EDITAVEIS_REUNIAO.filter((f) => !(migrados && f === "comments"));

async function serializar(db, ctx, rows) {
  const comentarios = await legadosDe(db, ctx, "REUNIAO", rows.map((r) => r.id));
  return rows.map((r) => toMeeting(r, comentarios?.get(r.id)));
}

/** from+to → intervalo fechado; só from → dali em diante; nada → todas. */
export async function listarReunioes(db, ctx, { from, to } = {}) {
  let q = "SELECT * FROM meetings WHERE deleted_at IS NULL";
  const params = [];
  if (from && to) {
    q += " AND date >= $1 AND date <= $2";
    params.push(from, to);
  } else if (from) {
    q += " AND date >= $1";
    params.push(from);
  }
  q += " ORDER BY date, start_time, created_at";
  const { rows } = await db.query(q, params);
  return serializar(db, ctx, rows);
}

// `must` passou a ser gravado na criação: antes o POST o descartava em silêncio e só o PATCH o
// aceitava — a reunião criada com "must" voltava com must "".
export async function criarReuniao(db, ctx, { title, date, start_time = "", end_time = "", description = "", must = "" } = {}) {
  if (!title || !date) return recusa("TITULO_E_DATA_OBRIGATORIOS");
  const migrados = comentariosMigrados(ctx);
  const id = uuidv4();
  return tx(db, async (c) => {
    await c.query(
      "INSERT INTO meetings (id, title, date, start_time, end_time, description, comments, must) VALUES ($1,$2,$3,$4,$5,$6,'[]',$7)",
      [id, title, date, start_time, end_time, description, must ?? ""]
    );
    const { rows } = await c.query("SELECT * FROM meetings WHERE id=$1", [id]);
    await registrar(c, ctx, { entidade_tipo: "REUNIAO", entidade_id: id, acao: "CRIADO", depois: rows[0], campos: camposAuditados(migrados) });
    return sucesso(toMeeting(rows[0], migrados ? [] : undefined));
  });
}

/**
 * Excluída ou inexistente → 404 (como o inexistente sempre foi). Em modo migrado, `comments` (o
 * array inteiro) passa pelo adaptador de comentários no mesmo tx; os outros campos seguem valendo.
 */
export async function atualizarReuniao(db, ctx, id, campos = {}) {
  const migrados = comentariosMigrados(ctx);
  const comArrayLegado = migrados && campos.comments !== undefined;

  const sets = []; const params = [];
  CAMPOS_EDITAVEIS_REUNIAO.forEach(f => {
    if (migrados && f === "comments") return; // a tabela é a verdade; a coluna é backup
    if (campos[f] !== undefined) {
      params.push(CAMPOS_JSONB.includes(f) ? JSON.stringify(campos[f]) : campos[f]);
      sets.push(`${f} = $${params.length}`);
    }
  });
  if (!sets.length && !comArrayLegado) return recusa("NADA_A_ATUALIZAR");
  params.push(id);

  const saida = await tx(db, async (c) => {
    const { rows: [antes] } = await c.query(
      "SELECT * FROM meetings WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]
    );
    if (!antes) return { resultado: recusa("NAO_ENCONTRADO") };

    // O plano sai ANTES de qualquer escrita: array ilegível vira 400 sem nada gravado.
    let plano = null;
    if (comArrayLegado) {
      const p = await planejarLegado(c, "REUNIAO", id, campos.comments);
      if (!p.ok) return { resultado: recusa(p.motivo) };
      plano = p.plano;
    }

    let depois = antes;
    if (sets.length) {
      ({ rows: [depois] } = await c.query(
        `UPDATE meetings SET ${sets.join(",")} WHERE id=$${params.length} RETURNING *`, params
      ));
      await registrar(c, ctx, { entidade_tipo: "REUNIAO", entidade_id: id, acao: "ATUALIZADO", antes, depois, campos: camposAuditados(migrados) });
    }
    const legado = plano ? await executarLegado(c, ctx, "REUNIAO", id, plano) : null;
    const [meeting] = await serializar(c, ctx, [depois]);
    return { resultado: sucesso(meeting), legado };
  });

  logarLegado(saida.legado);
  return saida.resultado;
}

export async function excluirReuniao(db, ctx, id) {
  return excluirLogico(db, ctx, "REUNIAO", id);
}

export async function restaurarReuniao(db, ctx, id) {
  return restaurarLogico(db, ctx, "REUNIAO", id);
}
