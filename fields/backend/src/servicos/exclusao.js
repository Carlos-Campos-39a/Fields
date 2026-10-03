// Exclusão LÓGICA e restauração das entidades (A1). Excluir é carimbar deleted_at; restaurar é
// apagar o carimbo. Nada some do banco: é o que permite o "Excluído · Desfazer" do front e o
// RESTAURAR do agente (A2).
//
// Excluir projeto ou frente NÃO carimba os filhos: eles somem pelas views frentes_visiveis /
// tarefas_visiveis (db/schema.js), e voltam quando o pai volta. Um filho excluído sozinho antes
// tem o próprio carimbo — e continua excluído depois que o pai é restaurado.
//
// Por isso o filho ESCONDIDO é inexistente também para o DELETE, como já é para PATCH e POST: só se
// carimba frente ou tarefa que a view ainda mostra. Sem isso, uma aba desatualizada (ou o MCP) que
// excluísse a tarefa de um projeto já excluído gravaria uma exclusão individual sobre algo que
// ninguém via — e restaurar o projeto devolveria a árvore SEM essa tarefa.

import { tx } from "../db/pool.js";
import { recusa, sucesso } from "../lib/erros.js";
import { registrar } from "./historico.js";

// Lista FECHADA: o nome da tabela entra no SQL por interpolação, então nunca vem de fora.
const TABELAS = Object.freeze({
  ENTRADA: "entries",
  PROJETO: "projects",
  FRENTE: "frentes",
  TAREFA: "tasks",
  REUNIAO: "meetings",
  COMENTARIO: "comentarios",
});

// As entidades que um PAI excluído esconde, e a view que decide se a linha está visível. O nome da
// view também entra por interpolação: lista fechada, como TABELAS.
const VISIBILIDADE = Object.freeze({
  FRENTE: "frentes_visiveis",
  TAREFA: "tarefas_visiveis",
});

function tabelaDe(entidadeTipo) {
  const tabela = TABELAS[entidadeTipo];
  if (!tabela) throw new TypeError(`exclusao: entidade sem tabela (${String(entidadeTipo)})`);
  return tabela;
}

/**
 * UPDATE ... SET deleted_at = NOW() só na linha viva E visível. Já excluída, escondida pelo pai
 * excluído ou inexistente → NAO_ENCONTRADO (as rotas legadas respondem {success:true} mesmo assim;
 * o motivo vai ao HTTP_REQ).
 */
export async function excluirLogico(db, ctx, entidadeTipo, id) {
  const tabela = tabelaDe(entidadeTipo);
  const view = VISIBILIDADE[entidadeTipo];
  const visivel = view ? ` AND EXISTS (SELECT 1 FROM ${view} v WHERE v.id = ${tabela}.id)` : "";
  return tx(db, async (c) => {
    const { rows } = await c.query(
      `UPDATE ${tabela} SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL${visivel} RETURNING id, deleted_at`,
      [id]
    );
    if (rows.length === 0) return recusa("NAO_ENCONTRADO");
    await registrar(c, ctx, {
      entidade_tipo: entidadeTipo, entidade_id: id, acao: "EXCLUIDO",
      antes: { deleted_at: null }, depois: rows[0],
    });
    return sucesso(true);
  });
}

/**
 * Apaga o carimbo. Inexistente ou não excluída → NAO_ENCONTRADO. A linha é lida antes (FOR UPDATE)
 * para o histórico guardar QUANDO ela tinha saído.
 * Restaurar um filho cujo pai continua excluído é aceito: o filho volta a ter deleted_at nulo e
 * segue escondido pela view até o pai voltar.
 */
export async function restaurarLogico(db, ctx, entidadeTipo, id) {
  const tabela = tabelaDe(entidadeTipo);
  return tx(db, async (c) => {
    const { rows: [antes] } = await c.query(
      `SELECT id, deleted_at FROM ${tabela} WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE`, // tabela-direta: trava da escrita
      [id]
    );
    if (!antes) return recusa("NAO_ENCONTRADO");
    const { rows: [depois] } = await c.query(
      `UPDATE ${tabela} SET deleted_at = NULL WHERE id = $1 RETURNING id, deleted_at`,
      [id]
    );
    await registrar(c, ctx, { entidade_tipo: entidadeTipo, entidade_id: id, acao: "RESTAURADO", antes, depois });
    return sucesso(true);
  });
}
