// Comentários (A1): uma linha por comentário em `comentarios`, com alvo ENTRADA | TAREFA | REUNIAO.
// Antes eram arrays jsonb dentro da entidade (entries.threads, tasks.comments, meetings.comments);
// a migração comentarios_v1 (db/migracoes.js) copiou esses arrays para cá, e as colunas ficaram
// como backup intocado.
//
// DOIS MODOS, decididos no boot e levados no ctx (ctx.comentariosMigrados):
//   - migrado (true): a tabela é a verdade. O GET monta os arrays legados a partir dela, a API nova
//     responde, e o PATCH legado com array inteiro passa pelo adaptador (diff → linhas).
//   - legado (false): a migração FALHOU (MIGRACAO_FALHOU no log). Tudo continua como na A0 — GET e
//     PATCH nas colunas jsonb — e a API nova responde 503 comentarios_indisponiveis. Escrever na
//     tabela nesse modo criaria uma segunda verdade que a próxima migração não saberia juntar.

import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { log } from "../lib/log.js";
import { recusa, sucesso } from "../lib/erros.js";
import { ALVOS_COMENTARIO } from "../dominio/enums.js";
import { candidatosDeId, isoDe, paraFormatoLegado, planejarArrayLegado } from "../dominio/comentarios_legado.js";
import { registrar } from "./historico.js";
import { excluirLogico, restaurarLogico } from "./exclusao.js";

export const TEXTO_MAX = 5000;
export const CAMPOS_AUDITADOS_COMENTARIO = Object.freeze(["alvo_tipo", "alvo_id", "texto", "criado_em"]);

/**
 * O modo do ctx. Ausente é erro de programação, não "legado": um chamador que esquecesse o flag
 * num banco migrado escreveria no jsonb, e o comentário sumiria da tela sem erro nenhum.
 */
export function comentariosMigrados(ctx) {
  if (typeof ctx?.comentariosMigrados !== "boolean") {
    throw new TypeError("ctx.comentariosMigrados ausente: monte o ctx com ctxDe(req, estado)");
  }
  return ctx.comentariosMigrados;
}

// Alvo visível = existe, não foi excluído e, se tarefa, não está escondido por frente ou projeto
// excluído (a view). Com `travar`, segura a linha do alvo (FOR SHARE) enquanto o comentário nasce:
// um PATCH legado concorrente, que trava o alvo FOR UPDATE, espera em vez de cruzar.
const SQL_ALVO = {
  ENTRADA: "SELECT 1 FROM entries WHERE id = $1 AND deleted_at IS NULL",
  REUNIAO: "SELECT 1 FROM meetings WHERE id = $1 AND deleted_at IS NULL",
  TAREFA: "SELECT 1 FROM tarefas_visiveis WHERE id = $1",
};
const SQL_ALVO_TRAVADO = {
  ENTRADA: "SELECT 1 FROM entries WHERE id = $1 AND deleted_at IS NULL FOR SHARE",
  REUNIAO: "SELECT 1 FROM meetings WHERE id = $1 AND deleted_at IS NULL FOR SHARE",
  TAREFA: "SELECT 1 FROM tasks t WHERE t.id = $1 AND EXISTS (SELECT 1 FROM tarefas_visiveis v WHERE v.id = t.id) FOR SHARE OF t", // tabela-direta: trava; quem decide a visibilidade é a view
};

async function alvoVisivel(db, alvoTipo, alvoId, { travar = false } = {}) {
  const { rows } = await db.query((travar ? SQL_ALVO_TRAVADO : SQL_ALVO)[alvoTipo], [alvoId]);
  return rows.length > 0;
}

function validarAlvo(alvo_tipo, alvo_id) {
  if (!ALVOS_COMENTARIO.includes(alvo_tipo)) return false;
  return typeof alvo_id === "string" && alvo_id !== "";
}

function toComentario(r) {
  return { id: r.id, alvo_tipo: r.alvo_tipo, alvo_id: r.alvo_id, texto: r.texto, criado_em: isoDe(r.criado_em), origem: r.origem };
}

/**
 * INSERT que nunca perde comentário: tenta os ids candidatos em ordem (o original, o alias
 * `${alvo_tipo}:${alvo_id}:${id}`, alias:2…) e, esgotados, um uuid. ON CONFLICT DO NOTHING não
 * aborta a transação, então uma colisão é só "tente o próximo".
 * criadoEm null → NOW().
 */
export async function inserirSemPerder(c, { alvoTipo, alvoId, id, texto, criadoEm = null, origem }) {
  const tentativas = [...candidatosDeId(alvoTipo, alvoId, id), uuidv4()];
  for (const candidato of tentativas) {
    const { rows } = await c.query(
      `INSERT INTO comentarios (id, alvo_tipo, alvo_id, texto, criado_em, origem)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [candidato, alvoTipo, alvoId, texto, criadoEm, origem]
    );
    if (rows.length) return { linha: rows[0], remapeado: candidato !== id };
  }
  // Inalcançável na prática (o último candidato é um uuid novo); se acontecer, o tx volta atrás.
  throw new Error("comentarios: nenhum id livre, nem o uuid");
}

/**
 * Os arrays no formato legado de vários alvos de uma vez (uma consulta): Map alvo_id → [{id, text,
 * createdAt|created_at}], só comentários vivos, em ordem de criação. Modo legado → null, e o
 * serializador usa a coluna jsonb como sempre.
 */
export async function legadosDe(db, ctx, alvoTipo, alvoIds) {
  if (!comentariosMigrados(ctx)) return null;
  const mapa = new Map(alvoIds.map((id) => [id, []]));
  if (alvoIds.length === 0) return mapa;
  const { rows } = await db.query(
    `SELECT id, alvo_id, texto, criado_em FROM comentarios
     WHERE alvo_tipo = $1 AND alvo_id = ANY($2) AND deleted_at IS NULL
     ORDER BY criado_em, id`,
    [alvoTipo, alvoIds]
  );
  for (const r of rows) mapa.get(r.alvo_id)?.push(paraFormatoLegado(alvoTipo, r));
  return mapa;
}

// ─── API nova: /api/comentarios ───

export async function listarComentarios(db, ctx, { alvo_tipo, alvo_id } = {}) {
  if (!comentariosMigrados(ctx)) return recusa("COMENTARIOS_INDISPONIVEIS");
  if (!validarAlvo(alvo_tipo, alvo_id)) return recusa("ALVO_INVALIDO");
  if (!(await alvoVisivel(db, alvo_tipo, alvo_id))) return recusa("NAO_ENCONTRADO");
  const { rows } = await db.query(
    `SELECT * FROM comentarios WHERE alvo_tipo = $1 AND alvo_id = $2 AND deleted_at IS NULL
     ORDER BY criado_em, id`,
    [alvo_tipo, alvo_id]
  );
  return sucesso(rows.map(toComentario));
}

export async function criarComentario(db, ctx, { alvo_tipo, alvo_id, texto } = {}) {
  if (!comentariosMigrados(ctx)) return recusa("COMENTARIOS_INDISPONIVEIS");
  if (!validarAlvo(alvo_tipo, alvo_id)) return recusa("ALVO_INVALIDO");
  if (typeof texto !== "string" || !texto.trim()) return recusa("TEXTO_OBRIGATORIO");
  const limpo = texto.trim();
  if (limpo.length > TEXTO_MAX) return recusa("TEXTO_LONGO_DEMAIS");

  return tx(db, async (c) => {
    if (!(await alvoVisivel(c, alvo_tipo, alvo_id, { travar: true }))) return recusa("NAO_ENCONTRADO");
    const { linha } = await inserirSemPerder(c, {
      alvoTipo: alvo_tipo, alvoId: alvo_id, id: uuidv4(), texto: limpo, origem: ctx.origem,
    });
    await registrar(c, ctx, {
      entidade_tipo: "COMENTARIO", entidade_id: linha.id, acao: "CRIADO",
      depois: linha, campos: CAMPOS_AUDITADOS_COMENTARIO,
    });
    return sucesso(toComentario(linha));
  });
}

// Comentário de alvo excluído — ou escondido pela view, como a tarefa de um projeto excluído — é
// inexistente para escrita, o mesmo critério do POST. Sem isso o DELETE carimbava o comentário, e
// restaurar o alvo trazia de volta um fio já mutilado por uma escrita que ninguém via.
async function alvoDoComentarioVisivel(db, id) {
  const { rows } = await db.query("SELECT alvo_tipo, alvo_id FROM comentarios WHERE id = $1", [id]);
  if (rows.length === 0) return true; // inexistente: o 404 é decidido por excluirLogico/restaurarLogico
  return alvoVisivel(db, rows[0].alvo_tipo, rows[0].alvo_id);
}

export async function excluirComentario(db, ctx, id) {
  if (!comentariosMigrados(ctx)) return recusa("COMENTARIOS_INDISPONIVEIS");
  if (!(await alvoDoComentarioVisivel(db, id))) return recusa("NAO_ENCONTRADO");
  return excluirLogico(db, ctx, "COMENTARIO", id);
}

export async function restaurarComentario(db, ctx, id) {
  if (!comentariosMigrados(ctx)) return recusa("COMENTARIOS_INDISPONIVEIS");
  if (!(await alvoDoComentarioVisivel(db, id))) return recusa("NAO_ENCONTRADO");
  return restaurarLogico(db, ctx, "COMENTARIO", id);
}

// ─── Adaptador do PATCH legado (array inteiro) ───
// O front e o MCP de hoje mandam `threads`/`comments` como o array COMPLETO — muitas vezes montado
// sobre um retrato velho (ver planejarArrayLegado: a intenção é derivada, o array não é a verdade).
// Em modo migrado, o serviço da entidade chama planejarLegado() logo depois de travar o alvo (FOR
// UPDATE) e ANTES de qualquer escrita — item ilegível ou remoção ambígua vira recusa sem nada
// gravado —, executa com executarLegado() no mesmo tx, e só depois do COMMIT chama logarLegado():
// log de algo que voltou atrás mente.

export async function planejarLegado(c, alvoTipo, alvoId, novos) {
  const { rows: linhas } = await c.query(
    "SELECT id, texto, deleted_at FROM comentarios WHERE alvo_tipo = $1 AND alvo_id = $2 FOR UPDATE",
    [alvoTipo, alvoId]
  );
  const p = planejarArrayLegado({ alvoTipo, alvoId, linhas, novos });
  if (!p.ok && p.motivo === "COMENTARIOS_DESATUALIZADOS") {
    // O HTTP_REQ leva o motivo; aqui vão os números que o motivaram. Nada foi escrito (a recusa
    // sai antes de qualquer escrita), então logar antes do COMMIT não mente.
    log.warn("LEGADO_REMOCAO_AMBIGUA", {
      alvo_tipo: alvoTipo, remocoes: p.remocoes, vivas: linhas.filter((l) => !l.deleted_at).length,
    });
  }
  return p;
}

export async function executarLegado(c, ctx, alvoTipo, alvoId, plano) {
  const base = { entidade_tipo: "COMENTARIO" };
  let remapeados = 0;

  for (const i of plano.inserir) {
    const { linha, remapeado } = await inserirSemPerder(c, {
      alvoTipo, alvoId, id: i.id, texto: i.texto, criadoEm: i.criadoEm, origem: ctx.origem,
    });
    if (remapeado) remapeados++;
    await registrar(c, ctx, { ...base, entidade_id: linha.id, acao: "CRIADO", depois: linha, campos: CAMPOS_AUDITADOS_COMENTARIO });
  }

  for (const e of plano.editar) {
    const { rows: [depois] } = await c.query(
      "UPDATE comentarios SET texto = $2 WHERE id = $1 RETURNING *", [e.id, e.para]
    );
    await registrar(c, ctx, { ...base, entidade_id: e.id, acao: "ATUALIZADO", antes: { texto: e.de }, depois, campos: ["texto"] });
  }

  for (const r of plano.remover) {
    const { rows: [depois] } = await c.query(
      "UPDATE comentarios SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, deleted_at", [r.id]
    );
    if (depois) await registrar(c, ctx, { ...base, entidade_id: r.id, acao: "EXCLUIDO", antes: { deleted_at: null }, depois });
  }

  return {
    alvo_tipo: alvoTipo,
    inseridos: plano.inserir.length,
    removidos: plano.remover.length,
    editados: plano.editar.length,
    remapeados,
    duplicados: plano.duplicados,
    campos_extras: plano.camposExtras,
    remocoes_ignoradas: plano.remocoesIgnoradas,
    restauros_ignorados: plano.restaurosIgnorados,
  };
}

/**
 * LEGADO_ARRAY_PATCH: quanto o adaptador ainda trabalha — é o sinal de quando o legado pode sair.
 * Sai em WARN quando o array chegou desatualizado (remoção ou restauro ignorado): é a medida de
 * quantas vezes um cliente antigo teria apagado ou ressuscitado um comentário sem querer.
 */
export function logarLegado(contagem) {
  if (!contagem) return;
  const ignorados = contagem.remocoes_ignoradas + contagem.restauros_ignorados;
  (ignorados > 0 ? log.warn : log.info)("LEGADO_ARRAY_PATCH", contagem);
}
