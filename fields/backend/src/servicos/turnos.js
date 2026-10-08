// Turnos do agente: um pedido (uma mensagem do chat, do WhatsApp, ou uma chamada de escrita do MCP)
// e a lista do que ele ESCREVEU. Todo SQL de `agente_turnos` mora aqui.
//
// A lista `acoes` é a matéria-prima do desfazer (agente/desfazer.js), que inverte sem chamar LLM.
// Cada ação é anotada NO MESMO tx da escrita (agente/ferramentas.js, executeWrite): a ação existe se
// e somente se a escrita foi gravada. Anotar depois do COMMIT deixaria uma janela em que a escrita
// existe e o desfazer não a conhece; anotar antes, uma ação que nunca aconteceu.

import { CANAIS } from "../dominio/enums.js";

/**
 * Cria a linha do turno se ela ainda não existe (ON CONFLICT DO NOTHING). Uma chamada de escrita
 * do MCP é um turno de uma ação só, criado aqui; o motor do chat (etapa seguinte) cria o turno no
 * começo da mensagem, e esta chamada vira no-op.
 */
export async function garantirTurno(db, { id, canal, entrada = null }) {
  if (typeof id !== "string" || !id) throw new TypeError("turnos: id do turno é obrigatório");
  if (!CANAIS.includes(canal)) throw new TypeError(`turnos: canal fora de CANAIS (${String(canal)})`);
  await db.query(
    `INSERT INTO agente_turnos (id, canal, entrada, concluido_em) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, canal, entrada]
  );
}

/**
 * Acrescenta a ação ao fim de `acoes` e devolve-a com o `idx` (a posição na lista). A linha do
 * turno fica travada (FOR UPDATE) até o COMMIT: duas escritas do mesmo turno não disputam o idx.
 */
export async function registrarAcao(db, turnoId, acao) {
  const { rows } = await db.query(
    "SELECT jsonb_array_length(acoes) AS n FROM agente_turnos WHERE id = $1 FOR UPDATE", [turnoId]
  );
  // garantirTurno roda antes, no mesmo tx: turno ausente aqui é erro de programação, e o tx volta.
  if (rows.length === 0) throw new TypeError("turnos: registrarAcao sem turno (chame garantirTurno antes)");
  const completa = { ...acao, idx: Number(rows[0].n) };
  await db.query(
    "UPDATE agente_turnos SET acoes = acoes || $2::jsonb WHERE id = $1",
    [turnoId, JSON.stringify([completa])]
  );
  return completa;
}

/** O turno travado para o desfazer, ou null. `acoes` volta como array (o pg já decodifica o jsonb). */
export async function turnoParaDesfazer(db, id) {
  const { rows } = await db.query(
    "SELECT id, canal, acoes, criado_em, desfeito_em FROM agente_turnos WHERE id = $1 FOR UPDATE", [id]
  );
  if (rows.length === 0) return null;
  return { ...rows[0], acoes: Array.isArray(rows[0].acoes) ? rows[0].acoes : [] };
}

/**
 * Carimba `desfeito_em` nas ações desfeitas e, quando não sobra nenhuma ação desfazível pendente,
 * no turno inteiro. No mesmo tx das inversões.
 */
export async function marcarDesfeitas(db, turnoId, idxs, quandoISO) {
  for (const idx of idxs) {
    await db.query(
      "UPDATE agente_turnos SET acoes = jsonb_set(acoes, ARRAY[$2::text, 'desfeito_em'], to_jsonb($3::text)) WHERE id = $1",
      [turnoId, String(idx), quandoISO]
    );
  }
  await db.query(
    `UPDATE agente_turnos SET desfeito_em = NOW()
     WHERE id = $1 AND desfeito_em IS NULL AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(acoes) a
       WHERE (a->>'desfazivel')::boolean AND a->>'desfeito_em' IS NULL
     )`,
    [turnoId]
  );
}
