// Entradas (notas, eventos, lembretes, idiomas). Todo SQL de `entries` mora aqui.
// Assinatura: (db, ctx, ...args) — ctx = {origem, turnoId, comentariosMigrados} (lib/rota.js ctxDe).
// Quem pode dizer "não" devolve recusa(motivo), nunca null mudo.
//
// A1: toda leitura filtra deleted_at IS NULL (entrada excluída some de lista, busca, próximos,
// estatística, relacionadas e do GET por id); excluir é lógico (servicos/exclusao.js); toda escrita
// grava o histórico no mesmo tx; `threads` sai da tabela `comentarios` quando a migração rodou.

import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { hojeISO } from "../lib/datas.js";
import { sucesso, recusa } from "../lib/erros.js";
import { entradaDoAgente, toEntry } from "./serializadores.js";
import { padraoContem, sqlSemAcento } from "../lib/texto.js";
import { registrar } from "./historico.js";
import { excluirLogico, restaurarLogico } from "./exclusao.js";
import { comentariosMigrados, executarLegado, legadosDe, logarLegado, planejarLegado } from "./comentarios.js";

export const CAMPOS_EDITAVEIS_ENTRADA = ["type", "title", "content", "tags", "date", "time", "pinned", "threads"];
const CAMPOS_JSONB = ["tags", "threads"];

// O que o histórico audita: os editáveis (updated_at muda a todo PATCH e não é dado). `threads` só
// no modo legado — migrado, cada comentário tem o próprio histórico (entidade COMENTARIO), e a
// coluna jsonb é backup que ninguém escreve.
const camposAuditados = (migrados) => CAMPOS_EDITAVEIS_ENTRADA.filter((f) => !(migrados && f === "threads"));

/** Linhas → entradas da API; em modo migrado, os threads vêm da tabela numa consulta só. */
async function serializar(db, ctx, rows) {
  const threads = await legadosDe(db, ctx, "ENTRADA", rows.map((r) => r.id));
  return rows.map((r) => toEntry(r, threads?.get(r.id)));
}

export async function listarEntradas(db, ctx, { type, search } = {}) {
  let q    = "SELECT * FROM entries WHERE deleted_at IS NULL";
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
  return serializar(db, ctx, rows);
}

/** Eventos e lembretes de hoje (fuso de Brasília) em diante. */
export async function proximasEntradas(db, ctx, { limit } = {}) {
  const today = hojeISO();
  const limite = parseInt(limit) || 5;
  const { rows } = await db.query(
    `SELECT * FROM entries
     WHERE deleted_at IS NULL AND type IN ('event','reminder') AND date >= $1
     ORDER BY date ASC, COALESCE(time,'00:00') ASC
     LIMIT $2`,
    [today, limite]
  );
  return serializar(db, ctx, rows);
}

export async function estatisticasEntradas(db, _ctx) {
  const { rows } = await db.query("SELECT type, pinned FROM entries WHERE deleted_at IS NULL");
  const stats = { note: 0, event: 0, reminder: 0, lang_fr: 0, lang_jp: 0, pinned: 0, total: rows.length };
  rows.forEach(r => { if (stats[r.type] !== undefined) stats[r.type]++; if (r.pinned) stats.pinned++; });
  return stats;
}

/** A entrada e até 4 relacionadas por tag em comum. Excluída → 404, e nunca aparece como relacionada. */
export async function obterEntrada(db, ctx, id) {
  const { rows } = await db.query("SELECT * FROM entries WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (rows.length === 0) return recusa("NAO_ENCONTRADO");
  const linha = rows[0];

  const { rows: rel } = await db.query(
    `SELECT * FROM entries WHERE id != $1 AND deleted_at IS NULL AND tags ?| $2::text[] LIMIT 4`,
    [linha.id, linha.tags ?? []]
  );
  const [entry, ...related] = await serializar(db, ctx, [linha, ...rel]);
  return sucesso({ entry, related });
}

export async function criarEntrada(db, ctx, { type, title, content, tags, date, time, pinned } = {}) {
  if (!title || !content) return recusa("TITULO_E_CONTEUDO_OBRIGATORIOS");
  const migrados = comentariosMigrados(ctx);

  const id = uuidv4();
  return tx(db, async (c) => {
    await c.query(
      `INSERT INTO entries (id, type, title, content, tags, date, time, pinned, threads)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]')`,
      [id, type || "note", title.trim(), content.trim(),
       JSON.stringify(Array.isArray(tags) ? tags : []),
       date || hojeISO(),
       time || null, pinned || false]
    );
    const { rows } = await c.query("SELECT * FROM entries WHERE id = $1", [id]);
    await registrar(c, ctx, { entidade_tipo: "ENTRADA", entidade_id: id, acao: "CRIADO", depois: rows[0], campos: camposAuditados(migrados) });
    return sucesso(toEntry(rows[0], migrados ? [] : undefined));
  });
}

/**
 * Sem campo editável, só toca updated_at (comportamento de sempre). Excluída ou inexistente → 404.
 * Em modo migrado, `threads` (o array inteiro que o front e o MCP mandam) passa pelo adaptador:
 * vira inserção, edição e exclusão de linhas em `comentarios`, no mesmo tx; o resto do PATCH segue
 * valendo na mesma request.
 */
export async function atualizarEntrada(db, ctx, id, campos = {}) {
  const migrados = comentariosMigrados(ctx);
  const comArrayLegado = migrados && campos.threads !== undefined;

  const saida = await tx(db, async (c) => {
    const { rows: [antes] } = await c.query(
      "SELECT * FROM entries WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]
    );
    if (!antes) return { resultado: recusa("NAO_ENCONTRADO") };

    // O plano sai ANTES de qualquer escrita: array ilegível vira 400 sem nada gravado.
    let plano = null;
    if (comArrayLegado) {
      const p = await planejarLegado(c, "ENTRADA", id, campos.threads);
      if (!p.ok) return { resultado: recusa(p.motivo) };
      plano = p.plano;
    }

    const sets = ["updated_at = NOW()"];
    const params = [];
    CAMPOS_EDITAVEIS_ENTRADA.forEach(f => {
      if (migrados && f === "threads") return; // a tabela é a verdade; a coluna é backup
      if (campos[f] !== undefined) {
        params.push(CAMPOS_JSONB.includes(f) ? JSON.stringify(campos[f]) : campos[f]);
        sets.push(`${f} = $${params.length}`);
      }
    });
    params.push(id);
    const { rows: [depois] } = await c.query(
      `UPDATE entries SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    await registrar(c, ctx, { entidade_tipo: "ENTRADA", entidade_id: id, acao: "ATUALIZADO", antes, depois, campos: camposAuditados(migrados) });
    const legado = plano ? await executarLegado(c, ctx, "ENTRADA", id, plano) : null;
    const [entry] = await serializar(c, ctx, [depois]);
    return { resultado: sucesso(entry), legado };
  });

  logarLegado(saida.legado);
  return saida.resultado;
}

/** Exclusão lógica. Inexistente ou já excluída → 404 (o DELETE de entrada sempre respondeu 404). */
export async function excluirEntrada(db, ctx, id) {
  return excluirLogico(db, ctx, "ENTRADA", id);
}

export async function restaurarEntrada(db, ctx, id) {
  return restaurarLogico(db, ctx, "ENTRADA", id);
}

/**
 * A2 · a busca do agente: texto sem caixa nem acento (título, conteúdo e tags), tipos, intervalo de
 * data (inclusivo, sobre o TEXT ISO de entries.date), fixadas. Mais nova primeiro.
 */
export async function buscarEntradas(db, _ctx, { texto, tipos, de, ate, fixadas, limite = 20 } = {}) {
  const where = ["deleted_at IS NULL"];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (texto) {
    const t = p(padraoContem(texto));
    where.push(`(${sqlSemAcento("title")} LIKE ${t} OR ${sqlSemAcento("content")} LIKE ${t} OR ${sqlSemAcento("tags::text")} LIKE ${t})`);
  }
  if (Array.isArray(tipos) && tipos.length) where.push(`type = ANY(${p(tipos)})`);
  if (de) where.push(`date >= ${p(de)}`);
  if (ate) where.push(`date <= ${p(ate)}`);
  if (typeof fixadas === "boolean") where.push(`pinned = ${p(fixadas)}`);
  const { rows } = await db.query(
    `SELECT * FROM entries WHERE ${where.join(" AND ")}
     ORDER BY date DESC NULLS LAST, COALESCE(time, '') DESC, created_at DESC
     LIMIT ${p(limite)}`,
    params
  );
  return rows.map(entradaDoAgente);
}
