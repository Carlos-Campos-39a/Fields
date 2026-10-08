// Tarefas de uma frente. Assinatura: (db, ctx, ...args). Todo SQL de `tasks` mora aqui.
//
// A1: tarefa "existe" quando aparece em tarefas_visiveis (viva, com a frente e o projeto vivos).
// As leituras diretas de `tasks` que restam são travas de escrita ou a contagem da ordem, marcadas
// com "tabela-direta" (test/schema.test.js cobra a marca).

import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { sucesso, recusa } from "../lib/erros.js";
import { tarefaDoAgente, toTask } from "./serializadores.js";
import { registrar } from "./historico.js";
import { excluirLogico, restaurarLogico } from "./exclusao.js";
import { comentariosMigrados, executarLegado, legadosDe, logarLegado, planejarLegado } from "./comentarios.js";
import { COLUNAS_KANBAN, COLUNA_FEITO, STATUS_CONCLUIDO } from "../dominio/enums.js";
import { padraoContem, sqlSemAcento } from "../lib/texto.js";

export const CAMPOS_EDITAVEIS_TAREFA = ["name", "acao", "status", "stakeholder", "deadline", "holder", "sort_order", "comments", "kanban_status", "start_date"];

// Coluna jsonb recebe JSON.stringify. Um array JS cru vira LITERAL DE ARRAY do Postgres no pg
// ('{"a","b"}'), que não é jsonb válido: era o 500 de todo comentário de task — e o motivo de
// produção ter 31 tasks e zero comentários. O PATCH de meetings sempre serializou; este não.
const CAMPOS_JSONB = ["comments"];

// Auditados: os editáveis mais a frente (o desfazer da criação precisa saber onde a tarefa nasceu).
// `comments` só no modo legado — migrado, cada comentário tem o próprio histórico.
const camposAuditados = (migrados) =>
  ["frente_id", ...CAMPOS_EDITAVEIS_TAREFA].filter((f) => !(migrados && f === "comments"));

/**
 * Frente inexistente, excluída ou escondida por projeto excluído → 404 (até a A0: 500 da FK, ou
 * uma tarefa nascendo invisível). A frente fica travada (FOR SHARE) até o COMMIT.
 *
 * A2: aceita também kanban_status e start_date — a NovaTarefa do agente nasce na coluna e com o
 * início pedidos num evento CRIADO só. Antes as duas chaves eram ignoradas no POST (a tarefa nascia
 * em "A fazer" e o front movia com um PATCH); criar e depois editar gravaria dois eventos, e o
 * desfazer da criação veria o segundo como "alguém mexeu depois".
 */
export async function criarTarefa(db, ctx, frenteId, { name, acao = "", status = "Pendente", stakeholder = "", deadline = null, holder = "", kanban_status = COLUNAS_KANBAN[0], start_date = null } = {}) {
  if (!name) return recusa("NOME_OBRIGATORIO");
  const migrados = comentariosMigrados(ctx);
  const id = uuidv4();
  return tx(db, async (c) => {
    const { rows: frente } = await c.query(
      "SELECT 1 FROM frentes f WHERE f.id = $1 AND EXISTS (SELECT 1 FROM frentes_visiveis v WHERE v.id = f.id) FOR SHARE OF f", // tabela-direta: trava; a visibilidade vem da view
      [frenteId]
    );
    if (frente.length === 0) return recusa("NAO_ENCONTRADO");
    const { rows: cnt } = await c.query("SELECT COUNT(*) FROM tasks WHERE frente_id=$1", [frenteId]); // tabela-direta: só a ordem
    const { rows } = await c.query(
      "INSERT INTO tasks (id, frente_id, name, acao, status, stakeholder, deadline, holder, sort_order, kanban_status, start_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
      [id, frenteId, name, acao, status, stakeholder, deadline, holder, parseInt(cnt[0]?.count) || 0, kanban_status ?? COLUNAS_KANBAN[0], start_date ?? null] // null explícito do POST não fura o NOT NULL
    );
    await registrar(c, ctx, { entidade_tipo: "TAREFA", entidade_id: id, acao: "CRIADO", depois: rows[0], campos: camposAuditados(migrados) });
    return sucesso(toTask(rows[0], migrados ? [] : undefined));
  });
}

/**
 * Excluída, escondida ou inexistente → 404 (ver atualizarProjeto). Em modo migrado, `comments` (o
 * array inteiro) passa pelo adaptador de comentários no mesmo tx; os outros campos seguem valendo.
 */
export async function atualizarTarefa(db, ctx, id, campos = {}) {
  const migrados = comentariosMigrados(ctx);
  const comArrayLegado = migrados && campos.comments !== undefined;

  const sets = []; const params = [];
  CAMPOS_EDITAVEIS_TAREFA.forEach(f => {
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
      "SELECT t.* FROM tasks t WHERE t.id = $1 AND EXISTS (SELECT 1 FROM tarefas_visiveis v WHERE v.id = t.id) FOR UPDATE OF t", // tabela-direta: trava; a visibilidade vem da view
      [id]
    );
    if (!antes) return { resultado: recusa("NAO_ENCONTRADO") };

    // O plano sai ANTES de qualquer escrita: array ilegível vira 400 sem nada gravado.
    let plano = null;
    if (comArrayLegado) {
      const p = await planejarLegado(c, "TAREFA", id, campos.comments);
      if (!p.ok) return { resultado: recusa(p.motivo) };
      plano = p.plano;
    }

    if (sets.length) {
      const { rows: [depois] } = await c.query(`UPDATE tasks SET ${sets.join(",")} WHERE id=$${params.length} RETURNING *`, params);
      await registrar(c, ctx, { entidade_tipo: "TAREFA", entidade_id: id, acao: "ATUALIZADO", antes, depois, campos: camposAuditados(migrados) });
    }
    const legado = plano ? await executarLegado(c, ctx, "TAREFA", id, plano) : null;
    return { resultado: sucesso(true), legado };
  });

  logarLegado(saida.legado);
  return saida.resultado;
}

export async function excluirTarefa(db, ctx, id) {
  return excluirLogico(db, ctx, "TAREFA", id);
}

export async function restaurarTarefa(db, ctx, id) {
  return restaurarLogico(db, ctx, "TAREFA", id);
}

// ─── A2 · leituras do agente ───
// Pelas views, como toda leitura de tarefa (a cascata lógica mora nelas), e com a frente e o
// projeto juntos: o agente desambigua "tarefa › frente › projeto" pelo NOME.

const SQL_TAREFA_COM_PAIS = `
  SELECT t.*, f.name AS frente_nome, p.id AS projeto_id, p.name AS projeto_nome
  FROM tarefas_visiveis t
  JOIN frentes_visiveis f ON f.id = t.frente_id
  JOIN projects p ON p.id = f.project_id`;

// Prazo só conta quando é uma data ISO: a coluna é TEXT desde a A0, e um "15/10" digitado à mão
// compararia como texto e cairia em "atrasada" para sempre.
const PRAZO_ISO = "t.deadline ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'";

/** A tarefa (visível) com frente, projeto e comentários. Excluída ou escondida → NAO_ENCONTRADO. */
export async function obterTarefa(db, ctx, id) {
  const { rows } = await db.query(`${SQL_TAREFA_COM_PAIS} WHERE t.id = $1`, [id]);
  if (rows.length === 0) return recusa("NAO_ENCONTRADO");
  const comentarios = await legadosDe(db, ctx, "TAREFA", [id]);
  return sucesso({ ...tarefaDoAgente(rows[0]), comentarios: comentarios?.get(id) ?? rows[0].comments ?? [] });
}

/**
 * Busca com filtros, todos opcionais. `abertas` = nem status Concluído nem coluna Feito (os dois
 * eixos são independentes; arrastar para "Feito" na tela não muda o status, e uma tarefa assim não
 * deve aparecer como atrasada). Sem filtro de status, as concluídas vêm por último.
 */
export async function buscarTarefas(db, _ctx, {
  texto, projetoId, frenteId, status, coluna, prazoDe, prazoAte, atrasadasEm, abertas = false, limite = 30,
} = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  if (texto) {
    const t = p(padraoContem(texto));
    where.push(`(${sqlSemAcento("t.name")} LIKE ${t} OR ${sqlSemAcento("t.acao")} LIKE ${t} OR ${sqlSemAcento("t.stakeholder")} LIKE ${t})`);
  }
  if (projetoId) where.push(`p.id = ${p(projetoId)}`);
  if (frenteId) where.push(`f.id = ${p(frenteId)}`);
  if (status) where.push(`t.status = ${p(status)}`);
  if (coluna) where.push(`t.kanban_status = ${p(coluna)}`);
  if (prazoDe) where.push(`${PRAZO_ISO} AND t.deadline >= ${p(prazoDe)}`);
  if (prazoAte) where.push(`${PRAZO_ISO} AND t.deadline <= ${p(prazoAte)}`);
  if (atrasadasEm) where.push(`${PRAZO_ISO} AND t.deadline < ${p(atrasadasEm)}`);
  if (abertas || atrasadasEm) {
    where.push(`t.status <> ${p(STATUS_CONCLUIDO)} AND t.kanban_status <> ${p(COLUNA_FEITO)}`);
  }

  const concluida = `(t.status = ${p(STATUS_CONCLUIDO)})`;
  const sql = `${SQL_TAREFA_COM_PAIS}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${concluida}, (CASE WHEN ${PRAZO_ISO} THEN t.deadline END) ASC NULLS LAST,
             p.sort_order, f.sort_order, t.sort_order, t.created_at
    LIMIT ${p(limite)}`;
  const { rows } = await db.query(sql, params);
  return rows.map(tarefaDoAgente);
}
