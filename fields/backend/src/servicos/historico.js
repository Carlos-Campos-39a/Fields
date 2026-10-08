// Histórico de mudanças das seis entidades (A1). É o que responde "quem mudou o quê, e por onde"
// — e é dele que o desfazer da A2 tira os valores `de` para reverter uma edição.
//
// Regra de uso: registrar() roda na MESMA transação da escrita (o serviço passa o cliente do tx).
// Escrita sem histórico, ou histórico de escrita que voltou atrás, é exatamente o que não pode
// existir: o desfazer reverteria uma mudança que não aconteceu, ou não acharia a que aconteceu.

import { ACOES_HISTORICO, ENTIDADES, ORIGENS } from "../dominio/enums.js";
import { calcularMudancas, valorDeHistorico } from "../dominio/mudancas.js";
import { recusa, sucesso } from "../lib/erros.js";

/**
 * Grava um evento. `campos` são os campos AUDITADOS da entidade (quem chama decide; updated_at,
 * por exemplo, nunca entra). ATUALIZADO sem mudança não grava nada — um PATCH que não muda nada
 * não é um evento — e devolve {registrado:false, motivo:"SEM_MUDANCA"}, nunca um null mudo.
 *
 * Valores errados aqui são erro de PROGRAMAÇÃO (o serviço montou mal o pedido), não recusa de
 * negócio: lançam, e o tx inteiro volta atrás.
 *
 * A2 — duas coisas novas no ctx, ambas opcionais (a rota REST não manda nenhuma):
 *  - ctx.registros (array): cada evento gravado é anotado ali ({id, entidade_tipo, entidade_id,
 *    acao}). É assim que o id do evento chega ao agente sem mudar o retorno de nenhum serviço — o
 *    JSON das rotas é contrato com o front e com o MCP, e o desfazer precisa do id para achar os
 *    valores `de` e para saber se alguém mexeu DEPOIS.
 *  - ctx.desfazId: o evento que esta escrita está desfazendo. Vai para historico.desfaz_id, que é o
 *    que distingue "o agente desfez" de "alguém mudou de novo" na guarda ALTERADO_DEPOIS.
 */
export async function registrar(db, ctx, { entidade_tipo, entidade_id, acao, antes = null, depois = null, campos = [] }) {
  if (!ENTIDADES.includes(entidade_tipo)) throw new TypeError(`historico: entidade_tipo fora de ENTIDADES (${String(entidade_tipo)})`);
  if (!ACOES_HISTORICO.includes(acao)) throw new TypeError(`historico: acao fora de ACOES_HISTORICO (${String(acao)})`);
  if (!ORIGENS.includes(ctx?.origem)) throw new TypeError(`historico: origem fora de ORIGENS (${String(ctx?.origem)})`);
  if (typeof entidade_id !== "string" || !entidade_id) throw new TypeError("historico: entidade_id obrigatório");

  const mudancas = calcularMudancas(acao, antes, depois, campos);
  if (acao === "ATUALIZADO" && mudancas.length === 0) return { registrado: false, motivo: "SEM_MUDANCA" };

  const { rows } = await db.query(
    `INSERT INTO historico (entidade_tipo, entidade_id, acao, mudancas, origem, turno_id, desfaz_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [entidade_tipo, entidade_id, acao, JSON.stringify(mudancas), ctx.origem, ctx.turnoId ?? null, ctx.desfazId ?? null]
  );
  const bruto = rows[0]?.id;
  const id = bruto == null ? null : Number(bruto);
  if (Array.isArray(ctx.registros)) ctx.registros.push({ id, entidade_tipo, entidade_id, acao });
  return { registrado: true, id };
}

function toEvento(r) {
  return {
    id: Number(r.id),
    entidade_tipo: r.entidade_tipo,
    entidade_id: r.entidade_id,
    acao: r.acao,
    mudancas: r.mudancas ?? [],
    origem: r.origem,
    turno_id: r.turno_id,
    desfaz_id: r.desfaz_id == null ? null : Number(r.desfaz_id),
    criado_em: valorDeHistorico(r.criado_em),
  };
}

/**
 * GET /api/historico/:tipo/:id — mais novo primeiro. Entidade excluída continua com histórico
 * (é justamente quando ele mais importa); id que nunca existiu devolve lista vazia.
 */
export async function listarHistorico(db, _ctx, tipo, id) {
  if (!ENTIDADES.includes(tipo)) return recusa("TIPO_INVALIDO");
  const { rows } = await db.query(
    `SELECT id, entidade_tipo, entidade_id, acao, mudancas, origem, turno_id, desfaz_id, criado_em
     FROM historico WHERE entidade_tipo = $1 AND entidade_id = $2
     ORDER BY id DESC`,
    [tipo, id]
  );
  return sucesso(rows.map(toEvento));
}

// ─── A2 · o que o desfazer precisa ler ───

/** Um evento pelo id, ou null (quem chama decide a recusa: o desfazer responde NADA_A_DESFAZER). */
export async function obterEvento(db, id) {
  const { rows } = await db.query(
    `SELECT id, entidade_tipo, entidade_id, acao, mudancas, origem, turno_id, desfaz_id, criado_em
     FROM historico WHERE id = $1`,
    [id]
  );
  return rows.length ? toEvento(rows[0]) : null;
}

/**
 * Os eventos da entidade gravados DEPOIS de `depoisDeId`, do mais antigo ao mais novo. É a guarda
 * ALTERADO_DEPOIS: se alguém (a tela, o MCP, outro turno) mexeu no registro depois da escrita do
 * agente, desfazer apagaria o trabalho dessa outra pessoa sem nada na tela dizer isso.
 */
export async function eventosDepois(db, entidadeTipo, entidadeId, depoisDeId) {
  const { rows } = await db.query(
    `SELECT id, entidade_tipo, entidade_id, acao, mudancas, origem, turno_id, desfaz_id, criado_em
     FROM historico WHERE entidade_tipo = $1 AND entidade_id = $2 AND id > $3
     ORDER BY id`,
    [entidadeTipo, entidadeId, depoisDeId]
  );
  return rows.map(toEvento);
}

/**
 * Como eventosDepois, mas também sobre o que vive DENTRO da entidade — a guarda ALTERADO_DEPOIS do
 * inverso EXCLUIR. Excluir não apaga só a linha: esconde a árvore (as views da cascata) e os
 * comentários do alvo. Olhar só a própria entidade deixava passar o caso que a guarda existe para
 * pegar: o agente cria a frente, o Carlos cria três tarefas nela pela tela, e o "desfazer" da frente
 * as tira da tela sem uma palavra.
 *
 *   PROJETO → as frentes dele, as tarefas dessas frentes e os comentários dessas tarefas;
 *   FRENTE  → as tarefas dela e os comentários delas;
 *   TAREFA, ENTRADA, REUNIAO → os comentários sobre ela.
 *
 * Pelas TABELAS, não pelas views: um filho criado depois e já excluído também é trabalho de alguém
 * depois da escrita — e esconder o pai não pode ser decidido como se ele nunca tivesse existido.
 */
export async function eventosDepoisNaArvore(db, entidadeTipo, entidadeId, depoisDeId) {
  if (!ENTIDADES.includes(entidadeTipo)) throw new TypeError(`historico: entidade_tipo fora de ENTIDADES (${String(entidadeTipo)})`);
  const { rows } = await db.query(
    `WITH frentes_da_arvore AS (
       SELECT f.id FROM frentes f WHERE $1::text = 'PROJETO' AND f.project_id = $2::text -- tabela-direta: auditoria da árvore, inclusive o já excluído
       UNION SELECT $2::text WHERE $1::text = 'FRENTE'
     ),
     tarefas_da_arvore AS (
       SELECT t.id FROM tasks t WHERE t.frente_id IN (SELECT id FROM frentes_da_arvore) -- tabela-direta: idem
       UNION SELECT $2::text WHERE $1::text = 'TAREFA'
     ),
     comentados AS (
       SELECT 'TAREFA'::text AS alvo_tipo, id AS alvo_id FROM tarefas_da_arvore
       UNION ALL SELECT $1::text, $2::text WHERE $1::text IN ('ENTRADA', 'REUNIAO')
     ),
     comentarios_da_arvore AS (
       SELECT c.id FROM comentarios c JOIN comentados a ON a.alvo_tipo = c.alvo_tipo AND a.alvo_id = c.alvo_id
     )
     SELECT h.id, h.entidade_tipo, h.entidade_id, h.acao, h.mudancas, h.origem, h.turno_id, h.desfaz_id, h.criado_em
     FROM historico h
     WHERE h.id > $3 AND (
       (h.entidade_tipo = $1::text AND h.entidade_id = $2::text)
       OR (h.entidade_tipo = 'FRENTE' AND h.entidade_id IN (SELECT id FROM frentes_da_arvore))
       OR (h.entidade_tipo = 'TAREFA' AND h.entidade_id IN (SELECT id FROM tarefas_da_arvore))
       OR (h.entidade_tipo = 'COMENTARIO' AND h.entidade_id IN (SELECT id FROM comentarios_da_arvore))
     )
     ORDER BY h.id`,
    [entidadeTipo, entidadeId, depoisDeId]
  );
  return rows.map(toEvento);
}
