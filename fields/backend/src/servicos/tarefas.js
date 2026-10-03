// Tarefas de uma frente. Assinatura: (db, ctx, ...args). Todo SQL de `tasks` mora aqui.
//
// A1: tarefa "existe" quando aparece em tarefas_visiveis (viva, com a frente e o projeto vivos).
// As leituras diretas de `tasks` que restam são travas de escrita ou a contagem da ordem, marcadas
// com "tabela-direta" (test/schema.test.js cobra a marca).

import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { sucesso, recusa } from "../lib/erros.js";
import { toTask } from "./serializadores.js";
import { registrar } from "./historico.js";
import { excluirLogico, restaurarLogico } from "./exclusao.js";
import { comentariosMigrados, executarLegado, logarLegado, planejarLegado } from "./comentarios.js";

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
 */
export async function criarTarefa(db, ctx, frenteId, { name, acao = "", status = "Pendente", stakeholder = "", deadline = null, holder = "" } = {}) {
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
      "INSERT INTO tasks (id, frente_id, name, acao, status, stakeholder, deadline, holder, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [id, frenteId, name, acao, status, stakeholder, deadline, holder, parseInt(cnt[0]?.count) || 0]
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
