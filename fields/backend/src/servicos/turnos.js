// Turnos do agente: um pedido (uma mensagem do chat, do WhatsApp, ou uma chamada de escrita do MCP)
// e a lista do que ele ESCREVEU. Todo SQL de `agente_turnos` mora aqui.
//
// A lista `acoes` é a matéria-prima do desfazer (agente/desfazer.js), que inverte sem chamar LLM.
// Cada ação é anotada NO MESMO tx da escrita (agente/ferramentas.js, executeWrite): a ação existe se
// e somente se a escrita foi gravada. Anotar depois do COMMIT deixaria uma janela em que a escrita
// existe e o desfazer não a conhece; anotar antes, uma ação que nunca aconteceu.

import { CANAIS, CANAIS_DO_MOTOR, STATUS_TURNO, TURNO_EM_ANDAMENTO, TURNO_FALHOU } from "../dominio/enums.js";
import { log } from "../lib/log.js";

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

// ─── A2b · o turno do motor ───────────────────────────────────────────────────
//
// Um turno do chat ou do WhatsApp nasce EM_ANDAMENTO, com concluido_em nulo, ANTES da primeira
// chamada ao modelo — é o turno_id que a tela recebe no 202 e consulta enquanto ele roda. Como a
// linha já existe, o garantirTurno de cada escrita (executeWrite) vira no-op, e as ações caem nela.

// QUAL turno é da conversa: o canal `web` também recebe os turnos de uma ação só que a tela grava por
// POST /api/ops (rotas/ops.js) — sem sessão, sem texto. A conversa, o recap e o alvo do "desfazer" do
// chat são do motor: turno com sessão (o que já conversou) ou ainda EM_ANDAMENTO (na fila, antes de
// ter sessão; só o motor abre turno assim).
const DO_MOTOR = `(sessao_id IS NOT NULL OR status = '${TURNO_EM_ANDAMENTO}')`;

/** O texto mostrado quando o turno não chegou ao fim por falha (o motor e a recuperação do boot). */
export const TEXTO_FALHA = "Desculpe, não consegui processar agora.";

/** Abre o turno do motor: EM_ANDAMENTO, sem sessão ainda (a sessão é resolvida já na vez dele). */
export async function abrirTurno(db, { id, canal, entrada = null }) {
  if (typeof id !== "string" || !id) throw new TypeError("turnos: id do turno é obrigatório");
  if (!CANAIS_DO_MOTOR.includes(canal)) throw new TypeError(`turnos: canal fora de CANAIS_DO_MOTOR (${String(canal)})`);
  await db.query(
    `INSERT INTO agente_turnos (id, canal, status, entrada, concluido_em) VALUES ($1, $2, $3, $4, NULL)`,
    [id, canal, TURNO_EM_ANDAMENTO, entrada]
  );
}

/** Liga o turno à sessão em que ele conversa — só depois de a sessão ser resolvida, na vez dele. */
export async function vincularSessao(db, turnoId, sessaoId) {
  await db.query("UPDATE agente_turnos SET sessao_id = $2 WHERE id = $1", [turnoId, sessaoId]);
}

/**
 * Quantas ferramentas o turno já rodou — o "Trabalhando… (3)" da tela. No banco, e não em memória
 * do processo: a consulta da tela pode cair em outra instância durante um deploy.
 */
export async function registrarProgresso(db, turnoId, nTools) {
  await db.query(
    `UPDATE agente_turnos SET metricas = COALESCE(metricas, '{}'::jsonb) || jsonb_build_object('n_tools', $2::int)
     WHERE id = $1`,
    [turnoId, nTools]
  );
}

/**
 * Fecha o turno com o status final, o motivo, o texto mostrado e as métricas. Só fecha o que ainda
 * está EM_ANDAMENTO: se a recuperação de órfãos já o deu como FALHOU/REINICIO (outra instância), a
 * palavra dela fica, e o log diz que o fim chegou tarde. Devolve true se fechou.
 */
export async function concluirTurno(db, turnoId, { status, motivo = null, resposta = null, metricas = {} }) {
  if (!STATUS_TURNO.includes(status) || status === TURNO_EM_ANDAMENTO) {
    throw new TypeError(`turnos: status final inválido (${String(status)})`);
  }
  const { rowCount } = await db.query(
    `UPDATE agente_turnos SET status = $2, motivo = $3, resposta = $4,
       metricas = COALESCE(metricas, '{}'::jsonb) || $5::jsonb, concluido_em = NOW()
     WHERE id = $1 AND status = $6`,
    [turnoId, status, motivo, resposta, JSON.stringify(metricas ?? {}), TURNO_EM_ANDAMENTO]
  );
  if (rowCount === 0) log.warn("AGENTE_TURNO_JA_FECHADO", { turno_id: turnoId, status });
  return rowCount > 0;
}

/**
 * O turno mais recente do canal com alguma ação desfazível ainda de pé, dentro da janela — o alvo
 * do comando "desfazer". `exceto` é o próprio turno do comando. null quando não há.
 *
 * O MAIS RECENTE COM AÇÃO, e não o mais recente: "desfazer" depois de uma pergunta ("e o que vence
 * hoje?") ainda quer dizer "volte o que você fez". A janela é a mesma do desfazer (selecionarAcoes
 * a cobra de novo, dentro do tx, sobre o turno travado). Só turno da conversa (com sessão): a ação
 * que a tela gravou por /api/ops tem o Desfazer do próprio toast.
 */
export async function ultimoTurnoDesfazivel(db, canal, janelaMin, { exceto = null } = {}) {
  const { rows } = await db.query(
    `SELECT id FROM agente_turnos
     WHERE canal = $1 AND sessao_id IS NOT NULL AND criado_em > NOW() - make_interval(mins => $2::int)
       AND ($3::text IS NULL OR id <> $3)
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(acoes) a
         WHERE (a->>'desfazivel')::boolean AND a->>'desfeito_em' IS NULL
       )
     ORDER BY criado_em DESC, id DESC LIMIT 1`,
    [canal, Math.ceil(janelaMin), exceto]
  );
  return rows[0]?.id ?? null;
}

const COLUNAS_PUBLICAS = "id, canal, sessao_id, status, motivo, entrada, resposta, acoes, metricas, criado_em, concluido_em";

/**
 * O formato que a tela lê (GET /api/agente/turnos/:id e cada item de /conversa) — contrato com a R3:
 * {turno_id, status, motivo, texto, acoes:[{idx, acao, resumo, desfazivel, desfeito_em}],
 *  progresso:{n_tools}}, mais entrada, criado_em, concluido_em e sessao_id (acréscimos).
 * Das ações saem só as chaves do chip: ids de entidade e de histórico ficam no servidor.
 */
export function turnoPublico(linha) {
  const acoes = Array.isArray(linha.acoes) ? linha.acoes : [];
  return {
    turno_id: linha.id,
    status: linha.status,
    motivo: linha.motivo ?? null,
    texto: linha.resposta ?? null,
    entrada: linha.entrada ?? null,
    acoes: acoes.map((a) => ({
      idx: a.idx, acao: a.acao, resumo: a.resumo, desfazivel: Boolean(a.desfazivel), desfeito_em: a.desfeito_em ?? null,
    })),
    progresso: { n_tools: Number(linha.metricas?.n_tools ?? 0) },
    sessao_id: linha.sessao_id ?? null,
    criado_em: linha.criado_em instanceof Date ? linha.criado_em.toISOString() : linha.criado_em ?? null,
    concluido_em: linha.concluido_em instanceof Date ? linha.concluido_em.toISOString() : linha.concluido_em ?? null,
  };
}

/** O turno no formato da tela, ou null. */
export async function obterTurnoPublico(db, id) {
  const { rows } = await db.query(`SELECT ${COLUNAS_PUBLICAS} FROM agente_turnos WHERE id = $1`, [id]);
  return rows.length ? turnoPublico(rows[0]) : null;
}

/** Os últimos `limite` turnos da conversa do canal (DO_MOTOR), do mais antigo ao mais novo (a ordem do fio). */
export async function listarConversa(db, canal, limite) {
  if (!CANAIS.includes(canal)) throw new TypeError(`turnos: canal fora de CANAIS (${String(canal)})`);
  const { rows } = await db.query(
    `SELECT ${COLUNAS_PUBLICAS} FROM agente_turnos WHERE canal = $1 AND ${DO_MOTOR}
     ORDER BY criado_em DESC, id DESC LIMIT $2`,
    [canal, limite]
  );
  return rows.reverse().map(turnoPublico);
}

/**
 * Os turnos FECHADOS do canal que entram no recap de uma sessão nova (agente/sessoes.js), do mais
 * antigo ao mais novo. EM_ANDAMENTO fica de fora: não tem resposta, e o próprio turno é um deles.
 */
export async function turnosParaRecap(db, canal, { limite = 5, exceto = null } = {}) {
  const { rows } = await db.query(
    `SELECT id, status, entrada, resposta, acoes, criado_em FROM agente_turnos
     WHERE canal = $1 AND sessao_id IS NOT NULL AND status <> $2 AND ($3::text IS NULL OR id <> $3)
     ORDER BY criado_em DESC, id DESC LIMIT $4`,
    [canal, TURNO_EM_ANDAMENTO, exceto, limite]
  );
  return rows.reverse();
}

/** Há quanto tempo um EM_ANDAMENTO é órfão. Ver recuperarTurnosOrfaos. */
export const ORFAO_APOS_MIN = 5;

/** De quanto em quanto tempo o servidor no ar procura órfãos (agendarRecuperacaoDeOrfaos). */
export const ORFAO_VARREDURA_MS = 60_000;

/**
 * Turno EM_ANDAMENTO há mais de ORFAO_APOS_MIN minutos vira FALHOU/REINICIO, com o texto de falha —
 * sem isso a tela consultaria para sempre um turno que morreu com o processo. Roda no boot (initDB)
 * E a cada minuto com o servidor no ar (agendarRecuperacaoDeOrfaos).
 *
 * Os 5 minutos, e não "todo EM_ANDAMENTO": num deploy do Railway a instância velha segue no ar até o
 * healthcheck da nova passar, e um turno que ELA começou há 30 s está vivo. Nenhum turno vivo passa
 * de 5 min: o prazo conta da chegada (fila incluída) e corta também a retentativa do SDK, e a config
 * recusa orçamento acima de ORCAMENTO_MAX_S (config.js). Mais velho que isso só pode ser órfão.
 *
 * Por que só o boot não basta: o turno que morre numa queda tem MENOS de 5 min no boot seguinte (o
 * Railway reinicia em segundos), e o da instância velha num deploy começou antes do boot da nova (ou
 * depois dele) — os dois escapavam da única passada e ficavam EM_ANDAMENTO até o deploy seguinte. O
 * mesmo para o turno cujo concluirTurno falhou (AGENTE_TURNO_NAO_FECHADO).
 */
export async function recuperarTurnosOrfaos(db, { minutos = ORFAO_APOS_MIN } = {}) {
  const { rows } = await db.query(
    `UPDATE agente_turnos SET status = $1, motivo = 'REINICIO', resposta = COALESCE(resposta, $2), concluido_em = NOW()
     WHERE status = $3 AND criado_em < NOW() - make_interval(mins => $4::int)
     RETURNING id`,
    [TURNO_FALHOU, TEXTO_FALHA, TURNO_EM_ANDAMENTO, minutos]
  );
  if (rows.length) log.warn("AGENTE_TURNO_RECUPERADO", { turnos: rows.length, motivo: "REINICIO" });
  return rows.length;
}

/**
 * A recuperação que nunca lança: dado, não schema — uma falha não derruba o boot nem o servidor no
 * ar; o log é que avisa. `momento` ("boot" | "periodica") diz qual das passadas falhou.
 */
export async function recuperarOrfaosSemFalhar(db, { momento }) {
  try {
    return await recuperarTurnosOrfaos(db);
  } catch (err) {
    log.erro("AGENTE_RECUPERACAO_FALHOU", {
      momento, erro: err?.name, pg_codigo: /^[0-9A-Z]{5}$/.test(err?.code ?? "") ? err.code : undefined,
    });
    return 0;
  }
}

/**
 * A passada periódica, ligada pelo server.js depois do listen. As duas instâncias de um deploy
 * rodam a sua ao mesmo tempo sem conflito: o UPDATE só pega EM_ANDAMENTO, e o concluirTurno só fecha
 * EM_ANDAMENTO. unref(): o timer não segura o processo. Devolve o timer (o teste o para).
 */
export function agendarRecuperacaoDeOrfaos(db, { intervaloMs = ORFAO_VARREDURA_MS } = {}) {
  const timer = setInterval(() => { recuperarOrfaosSemFalhar(db, { momento: "periodica" }); }, intervaloMs);
  timer.unref?.();
  return timer;
}
