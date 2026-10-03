// Frentes de um projeto. Assinatura: (db, ctx, ...args). Todo SQL de `frentes` mora aqui.
//
// A1: frente "existe" quando aparece em frentes_visiveis (viva E com o projeto vivo). As leituras
// diretas de `frentes` que restam são travas de escrita ou a contagem da ordem, marcadas com
// "tabela-direta" (test/schema.test.js cobra a marca).

import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { sucesso, recusa } from "../lib/erros.js";
import { toFrente } from "./serializadores.js";
import { registrar } from "./historico.js";
import { excluirLogico, restaurarLogico } from "./exclusao.js";

export const CAMPOS_EDITAVEIS_FRENTE = ["name", "sort_order"];
const CAMPOS_AUDITADOS_FRENTE = ["project_id", ...CAMPOS_EDITAVEIS_FRENTE];

/**
 * Projeto inexistente ou excluído → 404. Até a A0 estourava na FK (500); excluído não estouraria
 * nada — a frente nasceria escondida pela view, e o "criei" seria mentira.
 * O projeto fica travado (FOR SHARE) até o COMMIT: uma exclusão concorrente espera a frente nascer.
 */
export async function criarFrente(db, ctx, projectId, { name } = {}) {
  if (!name) return recusa("NOME_OBRIGATORIO");
  const id = uuidv4();
  return tx(db, async (c) => {
    const { rows: projeto } = await c.query(
      "SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL FOR SHARE", [projectId]
    );
    if (projeto.length === 0) return recusa("NAO_ENCONTRADO");
    const { rows: cnt } = await c.query("SELECT COUNT(*) FROM frentes WHERE project_id=$1", [projectId]); // tabela-direta: só a ordem
    const { rows } = await c.query(
      "INSERT INTO frentes (id, project_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING *",
      [id, projectId, name, parseInt(cnt[0]?.count) || 0]
    );
    await registrar(c, ctx, { entidade_tipo: "FRENTE", entidade_id: id, acao: "CRIADO", depois: rows[0], campos: CAMPOS_AUDITADOS_FRENTE });
    return sucesso({ ...toFrente(rows[0]), tasks: [] });
  });
}

/** Excluída, escondida por projeto excluído ou inexistente → 404 (ver atualizarProjeto). */
export async function atualizarFrente(db, ctx, id, campos = {}) {
  const sets = []; const params = [];
  CAMPOS_EDITAVEIS_FRENTE.forEach(f => { if (campos[f] !== undefined) { params.push(campos[f]); sets.push(`${f} = $${params.length}`); } });
  if (!sets.length) return recusa("NADA_A_ATUALIZAR");
  params.push(id);
  return tx(db, async (c) => {
    const { rows: [antes] } = await c.query(
      "SELECT f.* FROM frentes f WHERE f.id = $1 AND EXISTS (SELECT 1 FROM frentes_visiveis v WHERE v.id = f.id) FOR UPDATE OF f", // tabela-direta: trava; a visibilidade vem da view
      [id]
    );
    if (!antes) return recusa("NAO_ENCONTRADO");
    const { rows: [depois] } = await c.query(`UPDATE frentes SET ${sets.join(",")} WHERE id=$${params.length} RETURNING *`, params);
    await registrar(c, ctx, { entidade_tipo: "FRENTE", entidade_id: id, acao: "ATUALIZADO", antes, depois, campos: CAMPOS_AUDITADOS_FRENTE });
    return sucesso(true);
  });
}

/** Exclusão lógica SÓ da frente: as tarefas somem por tarefas_visiveis e voltam com o restaurar. */
export async function excluirFrente(db, ctx, id) {
  return excluirLogico(db, ctx, "FRENTE", id);
}

export async function restaurarFrente(db, ctx, id) {
  return restaurarLogico(db, ctx, "FRENTE", id);
}
