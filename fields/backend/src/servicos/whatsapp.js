// O estado do webhook do WhatsApp no banco: a idempotência pelo wamid (eventos_recebidos) e com quem
// se fala por qual conversa da Les Chats (canais_whatsapp). Todo SQL dessas duas tabelas mora aqui.
//
// A rota recebe isto como uma "loja" ({reservar, obter, concluir, absorver, gravarCanal}) — o teste
// de unidade passa uma em memória com a mesma forma (test/fakes/eventosEmMemoria.js), e a integração
// confere o SQL contra o Postgres.

import { EVENTO_CONCLUIDO, EVENTO_EM_VOO } from "../dominio/enums.js";
import { log } from "../lib/log.js";

/** Quantos dias um wamid fica guardado (contrato §6.1: cobre de sobra as retentativas, que são de minutos). */
export const RETENCAO_EVENTOS_DIAS = 7;

/** De quanto em quanto tempo o servidor no ar limpa os eventos velhos. */
export const LIMPEZA_EVENTOS_MS = 60 * 60_000;

const PG_CODIGO = /^[0-9A-Z]{5}$/;

/**
 * Reserva o evento. {nova:true} quando esta é a primeira entrega (a linha nasce EM_VOO e o turno é
 * de quem reservou); {nova:false, status, resposta} quando o wamid já passou por aqui — a contagem de
 * tentativas sobe, e quem chama devolve a resposta guardada (ou espera, se ainda está EM_VOO).
 *
 * Dois passos, e não um upsert: o INSERT ... ON CONFLICT DO NOTHING é a trava (duas entregas ao mesmo
 * tempo, só uma ganha a linha), e o UPDATE só acontece para quem perdeu. Se a linha sumiu entre os
 * dois (a limpeza de 7 dias), volta {nova:false, status:null}: quem chama trata como "não deu".
 */
export async function reservarEvento(db, eventId) {
  const ins = await db.query(
    `INSERT INTO eventos_recebidos (event_id, status) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, EVENTO_EM_VOO]
  );
  if (ins.rowCount > 0) return { nova: true };
  const { rows } = await db.query(
    `UPDATE eventos_recebidos SET tentativas = tentativas + 1 WHERE event_id = $1 RETURNING status, resposta, turno_id`,
    [eventId]
  );
  if (rows.length === 0) return { nova: false, status: null, resposta: null };
  return { nova: false, status: rows[0].status, resposta: rows[0].resposta ?? null, turnoId: rows[0].turno_id ?? null };
}

/** {status, resposta} do evento, ou null. É a consulta da retentativa que espera o turno em voo. */
export async function obterEvento(db, eventId) {
  const { rows } = await db.query("SELECT status, resposta, turno_id FROM eventos_recebidos WHERE event_id = $1", [eventId]);
  return rows.length ? { status: rows[0].status, resposta: rows[0].resposta ?? null, turnoId: rows[0].turno_id ?? null } : null;
}

/** Guarda o corpo devolvido: daqui em diante, toda entrega do mesmo wamid recebe exatamente ele. */
export async function concluirEvento(db, eventId, { resposta, turnoId = null }) {
  await db.query(
    `UPDATE eventos_recebidos SET status = $2, resposta = $3::jsonb, turno_id = $4, concluido_em = NOW() WHERE event_id = $1`,
    [eventId, EVENTO_CONCLUIDO, JSON.stringify(resposta ?? {}), turnoId]
  );
}

/**
 * A rajada (contrato §6.2): as mensagens anteriores, sem POST próprio, que o turno desta vai atender.
 * Grava cada wamid como CONCLUIDO com resposta {} e devolve SÓ os que eram novos — os que já estavam
 * na tabela tiveram o seu POST (e o seu turno), e não entram de novo.
 *
 * O INSERT ... ON CONFLICT DO NOTHING, e não um SELECT, é o que fecha a corrida: se a Les Chats
 * mandou o POST da mensagem anterior quase junto com o desta, um dos dois ganha a linha. Se ela
 * chegar depois, o reservar a acha CONCLUIDA e devolve {} — a resposta já saiu, no turno desta.
 * A ordem do RETURNING não é garantida: quem chama filtra a própria lista (que está em ordem).
 */
export async function absorverEventos(db, eventIds) {
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return [];
  const { rows } = await db.query(
    `INSERT INTO eventos_recebidos (event_id, status, resposta, concluido_em)
     SELECT id, $2, '{}'::jsonb, NOW() FROM unnest($1::text[]) AS id
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [ids, EVENTO_CONCLUIDO]
  );
  return rows.map((r) => r.event_id);
}

/**
 * Com quem se fala, por qual conversa. Sobrescreve: a conversa da Les Chats pode mudar (ticket
 * encerrado, conversa nova), e a Fase 2 precisa da MAIS RECENTE.
 */
export async function gravarCanal(db, { waId, conversationId, botId = null }) {
  await db.query(
    `INSERT INTO canais_whatsapp (wa_id, conversation_id, bot_id, atualizado_em) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (wa_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, bot_id = EXCLUDED.bot_id, atualizado_em = NOW()`,
    [waId, conversationId, botId]
  );
}

/** A loja da rota, sobre o Postgres. */
export function lojaEventosSql(db) {
  return {
    reservar: (eventId) => reservarEvento(db, eventId),
    obter: (eventId) => obterEvento(db, eventId),
    concluir: (eventId, fim) => concluirEvento(db, eventId, fim),
    absorver: (eventIds) => absorverEventos(db, eventIds),
    gravarCanal: (canal) => gravarCanal(db, canal),
  };
}

/**
 * Apaga os eventos com mais de RETENCAO_EVENTOS_DIAS — inclusive um EM_VOO que ficou para trás
 * (o processo morreu no meio do turno): depois de 7 dias nenhuma retentativa o procura mais.
 * Nunca lança: é limpeza, e uma falha só loga. Devolve quantos saíram.
 */
export async function limparEventosAntigos(db, { dias = RETENCAO_EVENTOS_DIAS, momento = "periodica" } = {}) {
  try {
    const { rowCount } = await db.query(
      "DELETE FROM eventos_recebidos WHERE criado_em < NOW() - make_interval(days => $1::int)", [dias]
    );
    if (rowCount > 0) log.info("LESCHATS_EVENTOS_LIMPOS", { eventos: rowCount, dias, momento });
    return rowCount ?? 0;
  } catch (err) {
    log.erro("LESCHATS_LIMPEZA_FALHOU", {
      momento, erro: err?.name, pg_codigo: PG_CODIGO.test(err?.code ?? "") ? err.code : undefined,
    });
    return 0;
  }
}

/** A limpeza periódica, ligada pelo server.js depois do listen (e uma passada já no boot). unref(): não segura o processo. */
export function agendarLimpezaDeEventos(db, { intervaloMs = LIMPEZA_EVENTOS_MS } = {}) {
  limparEventosAntigos(db, { momento: "boot" });
  const timer = setInterval(() => { limparEventosAntigos(db); }, intervaloMs);
  timer.unref?.();
  return timer;
}
