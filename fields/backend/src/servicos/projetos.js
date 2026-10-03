// Projetos — e a árvore projeto → frentes → tarefas que o GET /api/projects devolve.
// Assinatura: (db, ctx, ...args). Todo SQL de `projects` mora aqui.
//
// A1: a árvore lê frentes e tarefas SÓ pelas views frentes_visiveis / tarefas_visiveis — é nelas
// que mora a cascata lógica (projeto excluído esconde as frentes e as tarefas sem carimbá-las).
// Ler `frentes` ou `tasks` direto num caminho de leitura faria a tarefa de um projeto excluído
// reaparecer; test/schema.test.js varre os serviços atrás disso.

import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { sucesso, recusa } from "../lib/erros.js";
import { toProject, toFrente, toTask } from "./serializadores.js";
import { registrar } from "./historico.js";
import { excluirLogico, restaurarLogico } from "./exclusao.js";
import { legadosDe } from "./comentarios.js";

export const CAMPOS_EDITAVEIS_PROJETO = ["name", "status", "holder", "sort_order"];

export async function listarProjetos(db, ctx) {
  const { rows: ps } = await db.query("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY sort_order, created_at");
  const { rows: fs } = await db.query("SELECT * FROM frentes_visiveis ORDER BY sort_order, created_at");
  const { rows: ts } = await db.query("SELECT * FROM tarefas_visiveis ORDER BY sort_order, created_at");
  const comentarios = await legadosDe(db, ctx, "TAREFA", ts.map((t) => t.id));

  const fMap = {};
  fs.forEach(f => { fMap[f.id] = { ...toFrente(f), tasks: [] }; });
  ts.forEach(t => { if (fMap[t.frente_id]) fMap[t.frente_id].tasks.push(toTask(t, comentarios?.get(t.id))); });

  return ps.map(p => ({
    ...toProject(p),
    frentes: fs.filter(f => f.project_id === p.id).map(f => fMap[f.id] || { ...toFrente(f), tasks: [] }),
  }));
}

export async function criarProjeto(db, ctx, { name, status = "Em andamento", holder = "Nós" } = {}) {
  if (!name) return recusa("NOME_OBRIGATORIO");
  const id = uuidv4();
  return tx(db, async (c) => {
    const { rows: cnt } = await c.query("SELECT COUNT(*) FROM projects");
    const { rows } = await c.query(
      "INSERT INTO projects (id, name, status, holder, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [id, name, status, holder, parseInt(cnt[0]?.count) || 0]
    );
    await registrar(c, ctx, { entidade_tipo: "PROJETO", entidade_id: id, acao: "CRIADO", depois: rows[0], campos: CAMPOS_EDITAVEIS_PROJETO });
    return sucesso({ ...toProject(rows[0]), frentes: [] });
  });
}

/**
 * Excluído ou inexistente → 404. Até a A0 o id inexistente respondia {success:true} (o UPDATE não
 * casava nada e ninguém sabia); a A1 precisa da linha de antes para o histórico, e um "deu certo"
 * para uma escrita que não aconteceu é a recusa muda que o desfazer não teria como explicar.
 */
export async function atualizarProjeto(db, ctx, id, campos = {}) {
  const sets = []; const params = [];
  CAMPOS_EDITAVEIS_PROJETO.forEach(f => { if (campos[f] !== undefined) { params.push(campos[f]); sets.push(`${f} = $${params.length}`); } });
  if (!sets.length) return recusa("NADA_A_ATUALIZAR");
  params.push(id);
  return tx(db, async (c) => {
    const { rows: [antes] } = await c.query("SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
    if (!antes) return recusa("NAO_ENCONTRADO");
    const { rows: [depois] } = await c.query(`UPDATE projects SET ${sets.join(",")} WHERE id=$${params.length} RETURNING *`, params);
    await registrar(c, ctx, { entidade_tipo: "PROJETO", entidade_id: id, acao: "ATUALIZADO", antes, depois, campos: CAMPOS_EDITAVEIS_PROJETO });
    return sucesso(true);
  });
}

/** Exclusão lógica SÓ do projeto: frentes e tarefas somem pela view e voltam com o restaurar. */
export async function excluirProjeto(db, ctx, id) {
  return excluirLogico(db, ctx, "PROJETO", id);
}

export async function restaurarProjeto(db, ctx, id) {
  return restaurarLogico(db, ctx, "PROJETO", id);
}
