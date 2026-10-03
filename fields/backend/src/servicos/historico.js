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
 */
export async function registrar(db, ctx, { entidade_tipo, entidade_id, acao, antes = null, depois = null, campos = [] }) {
  if (!ENTIDADES.includes(entidade_tipo)) throw new TypeError(`historico: entidade_tipo fora de ENTIDADES (${String(entidade_tipo)})`);
  if (!ACOES_HISTORICO.includes(acao)) throw new TypeError(`historico: acao fora de ACOES_HISTORICO (${String(acao)})`);
  if (!ORIGENS.includes(ctx?.origem)) throw new TypeError(`historico: origem fora de ORIGENS (${String(ctx?.origem)})`);
  if (typeof entidade_id !== "string" || !entidade_id) throw new TypeError("historico: entidade_id obrigatório");

  const mudancas = calcularMudancas(acao, antes, depois, campos);
  if (acao === "ATUALIZADO" && mudancas.length === 0) return { registrado: false, motivo: "SEM_MUDANCA" };

  const { rows } = await db.query(
    `INSERT INTO historico (entidade_tipo, entidade_id, acao, mudancas, origem, turno_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [entidade_tipo, entidade_id, acao, JSON.stringify(mudancas), ctx.origem, ctx.turnoId ?? null]
  );
  const id = rows[0]?.id;
  return { registrado: true, id: id == null ? null : Number(id) };
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
