// Sessões do motor — a conversa que vai ao modelo, e quando ela recomeça. Todo SQL de
// agente_sessoes e agente_mensagens mora aqui.
//
// ## Por que o histórico é só INSERT
//
// No Opus 5.5 o pensamento é PRESERVADO: cada bloco de thinking que o modelo devolve fica amarrado
// aos bytes de tudo o que veio antes dele — o system, as ferramentas e cada mensagem anterior. Se uma
// mensagem antiga mudar um byte (um campo reordenado, um lembrete apagado, o system reconstruído com a
// data de hoje), os blocos seguintes deixam de valer: a API recusa (400) ou, com `drop_block`, joga o
// raciocínio fora e o cache recomeça. Então:
//   - as mensagens só são ACRESCENTADAS, nunca editadas nem apagadas (o teste varre o código);
//   - `content` é TEXT com o JSON exato da API (o jsonb normalizaria);
//   - o system e as ferramentas são congelados, e a `prompt_versao` (o hash dos dois) muda quando
//     qualquer um deles muda — e aí a conversa recomeça em vez de mandar histórico contra outro prompt.
//
// ## Quando a sessão recomeça (motivoDeRenovacao)
//
// PROMPT_VERSAO (deploy que mudou a ontologia), MODELO (AGENTE_MODELO trocado: os blocos de um modelo
// não valem para outro, e o cache é por modelo), PARADA (horas sem conversa: o contexto velho custa
// tokens e confunde), MENSAGENS e TOKENS (a conversa ficou grande demais para valer o que custa). E,
// fechadas por quem as pede: RECUSA (o modelo recusou — seguir na mesma conversa repete a recusa),
// ERRO_HISTORICO (400 sobre o histórico), ERRO_INTERNO (o turno quebrou depois de uma escrita, e o
// histórico pode não ter a rodada dela) e PEDIDO (o botão "nova conversa").
//
// Sessão nova não começa do zero: o primeiro turno dela leva a memória e um RECAP deterministico dos
// últimos turnos (recapDeterministico) — texto montado do banco, sem modelo, igual toda vez para o
// mesmo dado.

import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { agoraLocal } from "../lib/datas.js";
import { CANAIS_DO_MOTOR, ROLES_MENSAGEM, SESSAO_ATIVA, SESSAO_ENCERRADA, TURNO_ESGOTADO, TURNO_FALHOU, TURNO_RECUSADO } from "../dominio/enums.js";
import { systemPrompt } from "./ontologia.js";
import { ferramentasClaude } from "./catalogo.js";

/** Os tetos da conversa. Passou de qualquer um, a próxima mensagem abre sessão nova. */
export const LIMITES_SESSAO = Object.freeze({ mensagens: 150, inputTokens: 200_000 });

/** Os motivos de fim de sessão — o `motivo` da linha e do AGENTE_SESSAO_NOVA. */
export const MOTIVOS_SESSAO = Object.freeze([
  "PROMPT_VERSAO", "MODELO", "PARADA", "MENSAGENS", "TOKENS", "RECUSA", "ERRO_HISTORICO", "ERRO_INTERNO", "PEDIDO",
]);

/**
 * sha256(systemPrompt + JSON(ferramentasClaude)) — a identidade do prompt CONGELADO de um canal.
 * Muda quando a ontologia muda (uma operação, um resumo, um rótulo, um schema) ou a flag de rollout;
 * fica igual entre chamadas e entre processos para o mesmo código e o mesmo env.
 */
export function promptVersao(canal, { operacoes } = {}) {
  const system = systemPrompt({ canal, ...(operacoes ? { operacoes } : {}) });
  const ferramentas = ferramentasClaude(operacoes ? { operacoes } : {});
  return createHash("sha256").update(system + JSON.stringify(ferramentas)).digest("hex");
}

/**
 * Por que a sessão ativa NÃO serve mais, ou null se serve. Pura: a mesma decisão para o banco e para
 * o teste. A ordem é a de gravidade — a versão do prompt primeiro, porque mandar o histórico contra
 * outro prompt é o único caso que quebra a requisição em vez de só custar mais.
 */
export function motivoDeRenovacao(sessao, { promptVersao: versao, modelo, agora, ociosaHoras }) {
  if (sessao.prompt_versao !== versao) return "PROMPT_VERSAO";
  if (sessao.modelo !== modelo) return "MODELO";
  const parada = new Date(agora).getTime() - new Date(sessao.ultima_atividade_em).getTime();
  if (parada > ociosaHoras * 3_600_000) return "PARADA";
  if (Number(sessao.n_mensagens) >= LIMITES_SESSAO.mensagens) return "MENSAGENS";
  if (Number(sessao.ultimo_input_tokens) > LIMITES_SESSAO.inputTokens) return "TOKENS";
  return null;
}

// ── O recap ───────────────────────────────────────────────────────────────────

const RECAP_ENTRADA_MAX = 200;
const RECAP_RESPOSTA_MAX = 300;

const cortar = (texto, max) => {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const COMO_ACABOU = { [TURNO_ESGOTADO]: " (não terminou a tempo)", [TURNO_FALHOU]: " (falhou)", [TURNO_RECUSADO]: " (recusado)" };

/** A linha do turno RECUSADO no recap: o fato, sem o texto do pedido (ver recapDeterministico). */
export const RECAP_RECUSADO = "pedido recusado pelo modelo (o texto dele fica fora deste resumo)";

/**
 * O resumo da conversa anterior, montado do banco — sem modelo. Uma linha por turno: quando, o que o
 * Carlos disse, o que foi respondido e o que foi feito (com "desfeita" quando voltou). Vazio quando
 * não há turno nenhum. Deterministico: o mesmo dado dá o mesmo texto (e o primeiro turno da sessão,
 * que o carrega, fica estável no histórico).
 *
 * O turno RECUSADO entra SEM a entrada e sem a resposta. A recusa encerra a sessão para a conversa
 * seguinte não carregar o que os classificadores barraram — e o turno seguinte é justamente o 1º da
 * sessão nova, o que leva este recap. Com o pedido aqui dentro, os classificadores (que avaliam a
 * requisição inteira) veriam o mesmo texto de novo: um falso positivo derrubaria até cinco turnos
 * sem relação, cada um fechando outra sessão. Fica o fato e o que foi feito antes da recusa (a
 * escrita aconteceu, e o modelo precisa saber dela).
 *
 * É texto do Carlos e do assistente: vai DENTRO do <resumo_conversa_anterior> (contextoDoTurno, que
 * escapa o XML), nunca no system.
 */
export function recapDeterministico(turnos) {
  const linhas = (turnos ?? []).map((t) => {
    const { data, hora } = agoraLocal(new Date(t.criado_em));
    const quando = `${data.slice(8, 10)}/${data.slice(5, 7)} ${hora}`;
    const acoes = (Array.isArray(t.acoes) ? t.acoes : [])
      .map((a) => `${a.resumo}${a.desfeito_em ? " (desfeita)" : ""}`);
    const feito = acoes.length ? `\n  feito: ${acoes.join("; ")}` : "";
    if (t.status === TURNO_RECUSADO) return `- ${quando} · ${RECAP_RECUSADO}${feito}`;
    return `- ${quando} · Carlos: "${cortar(t.entrada, RECAP_ENTRADA_MAX)}" → você: "${cortar(t.resposta, RECAP_RESPOSTA_MAX)}"` +
      (COMO_ACABOU[t.status] ?? "") + feito;
  });
  if (linhas.length === 0) return "";
  return "Os últimos turnos antes desta conversa (do mais antigo ao mais novo):\n" + linhas.join("\n");
}

// ── O banco ───────────────────────────────────────────────────────────────────

const lerMensagem = (linha) => ({ role: linha.role, content: JSON.parse(linha.content) });

async function sessaoAtiva(c, canal) {
  const { rows } = await c.query(
    "SELECT * FROM agente_sessoes WHERE canal = $1 AND status = $2 FOR UPDATE", [canal, SESSAO_ATIVA]
  );
  return rows[0] ?? null;
}

async function encerrar(c, sessaoId, motivo) {
  const { rowCount } = await c.query(
    "UPDATE agente_sessoes SET status = $2, motivo = $3, encerrado_em = NOW() WHERE id = $1 AND status = $4",
    [sessaoId, SESSAO_ENCERRADA, motivo, SESSAO_ATIVA]
  );
  return rowCount > 0;
}

/**
 * A sessão em que o turno vai conversar, e o histórico dela.
 *
 * Reusa a ATIVA do canal se ela ainda serve (motivoDeRenovacao); senão a encerra e abre outra. (Quem
 * fecha por fora — recusa, 400 de histórico, nova conversa — usa encerrarSessao/encerrarAtiva antes.)
 *
 * Devolve {sessao, mensagens:[{role, content}], nova, motivo}. `motivo` é por que a ANTERIOR acabou
 * — o desta chamada ou, se ela já tinha sido fechada antes (recusa, nova conversa), o que ficou
 * gravado nela; "PRIMEIRA" quando o canal nunca teve sessão. É o que o AGENTE_SESSAO_NOVA leva (o
 * motor loga, depois do COMMIT — e com qualquer persistência, inclusive a de teste).
 *
 * Sob um advisory lock do canal: o mutex do motor serializa dentro do processo, e o lock serializa
 * entre as duas instâncias de um deploy (o índice único de ATIVA é a última trava).
 */
export async function obterOuRenovar(db, { canal, promptVersao: versao, modelo, agora = new Date(), ociosaHoras }) {
  if (!CANAIS_DO_MOTOR.includes(canal)) throw new TypeError(`sessoes: canal fora de CANAIS_DO_MOTOR (${String(canal)})`);
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fields:sessao:${canal}`]);
    const ativa = await sessaoAtiva(c, canal);
    let motivo = null;
    if (ativa) {
      motivo = motivoDeRenovacao(ativa, { promptVersao: versao, modelo, agora, ociosaHoras });
      if (!motivo) {
        const { rows } = await c.query(
          "SELECT role, content FROM agente_mensagens WHERE sessao_id = $1 ORDER BY seq", [ativa.id]
        );
        return { sessao: ativa, mensagens: rows.map(lerMensagem), nova: false, motivo: null };
      }
      await encerrar(c, ativa.id, motivo);
    } else {
      const { rows } = await c.query(
        "SELECT motivo FROM agente_sessoes WHERE canal = $1 ORDER BY criado_em DESC, id DESC LIMIT 1", [canal]
      );
      motivo = rows[0]?.motivo ?? "PRIMEIRA";
    }
    const { rows: [sessao] } = await c.query(
      `INSERT INTO agente_sessoes (id, canal, prompt_versao, modelo) VALUES ($1, $2, $3, $4) RETURNING *`,
      [uuidv4(), canal, versao, modelo]
    );
    return { sessao, mensagens: [], nova: true, motivo };
  });
}

/**
 * Acrescenta mensagens ao fim do histórico, num tx: ou entram todas (o assistente com os seus
 * tool_use E o user com os tool_result), ou nenhuma — um tool_use sem o tool_result seguinte é um
 * histórico que a API recusa para sempre.
 *
 * `inputTokens` é o tamanho do prompt da última chamada (input + cache lido + cache escrito): é ele
 * que decide a renovação por TOKENS.
 */
export async function acrescentarMensagens(db, sessaoId, turnoId, mensagens, { inputTokens = null } = {}) {
  if (!mensagens.length) return;
  for (const m of mensagens) {
    if (!ROLES_MENSAGEM.includes(m.role)) throw new TypeError(`sessoes: role inválido (${String(m.role)})`);
  }
  await tx(db, async (c) => {
    const { rows } = await c.query("SELECT n_mensagens FROM agente_sessoes WHERE id = $1 FOR UPDATE", [sessaoId]);
    if (rows.length === 0) throw new TypeError("sessoes: acrescentarMensagens sem sessão");
    let seq = Number(rows[0].n_mensagens);
    for (const m of mensagens) {
      await c.query(
        "INSERT INTO agente_mensagens (sessao_id, seq, role, content, turno_id) VALUES ($1, $2, $3, $4, $5)",
        [sessaoId, seq++, m.role, JSON.stringify(m.content), turnoId]
      );
    }
    await c.query(
      `UPDATE agente_sessoes SET n_mensagens = $2, ultima_atividade_em = NOW(),
         ultimo_input_tokens = COALESCE($3::int, ultimo_input_tokens)
       WHERE id = $1`,
      [sessaoId, seq, inputTokens]
    );
  });
}

/** Encerra uma sessão pelo id (RECUSA, ERRO_HISTORICO, ERRO_INTERNO). false se ela já não estava ativa. */
export async function encerrarSessao(db, sessaoId, motivo) {
  if (!MOTIVOS_SESSAO.includes(motivo)) throw new TypeError(`sessoes: motivo inválido (${String(motivo)})`);
  return encerrar(db, sessaoId, motivo);
}

/** Encerra a sessão ativa do canal (o "nova conversa"). false se não havia ativa. */
export async function encerrarAtiva(db, canal, motivo) {
  if (!MOTIVOS_SESSAO.includes(motivo)) throw new TypeError(`sessoes: motivo inválido (${String(motivo)})`);
  const { rowCount } = await db.query(
    "UPDATE agente_sessoes SET status = $2, motivo = $3, encerrado_em = NOW() WHERE canal = $1 AND status = $4",
    [canal, SESSAO_ENCERRADA, motivo, SESSAO_ATIVA]
  );
  return rowCount > 0;
}
