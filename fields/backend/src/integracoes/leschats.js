// O contrato v1.0 da Les Chats (metadesk/docs/contrato-fields.md), Fase 1 — o ÚNICO módulo do Fields
// que conhece a forma do envelope, a assinatura e as formas de resposta. A rota (rotas/whatsapp.js)
// decide o que fazer; daqui saem só verificar, ler e montar.
//
// ## A assinatura (§4)
//
//   material   = utf8(timestamp) + "." + corpo_cru_em_bytes
//   assinatura = "sha256=" + hex(HMAC-SHA256(LESCHATS_SEGREDO, material))
//
// Sobre os BYTES que chegaram, nunca sobre um JSON.stringify do objeto: espaçamento e ordem de chave
// mudam, e o sintoma é um 403 mudo com cara de segredo errado (§4.2). Por isso a rota lê o corpo com
// express.raw e só faz o JSON.parse depois daqui. O timestamp dentro do material mata o replay: uma
// requisição capturada vale por 5 minutos, não para sempre.
//
// Nenhum segredo, assinatura ou timestamp cru sai daqui para o log — só o MOTIVO da recusa.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { formatarResposta } from "./formato.js";

export const PREFIXO_ASSINATURA = "sha256=";
/** |agora − timestamp| acima disso é recusado (§4.1). */
export const TOLERANCIA_S = 300;
/** O único evento da Fase 1. Os outros — inclusive os que ainda não existem — são ignorados (§3.2). */
export const EVENTO_MENSAGEM = "message.received";
/** Os `reason` que a Les Chats aceita num handoff (§5); qualquer outro vira BOT_FAILURE lá. */
export const MOTIVOS_HANDOFF = Object.freeze(["BOT_TOOL", "KEYWORD", "NO_BOT", "BOT_FAILURE", "AGENT_PICKUP", "OUTSIDE_WINDOW"]);

const TIMESTAMP = /^\d{1,12}$/;
const HEX_DA_ASSINATURA = /^[0-9a-f]{64}$/;
/** O tamanho, em bytes, de "sha256=" + 64 hex — o que a Les Chats manda. */
const TAMANHO_ASSINATURA = PREFIXO_ASSINATURA.length + 64;

/** "sha256=<hex>" do material — o mesmo cálculo da Les Chats. Usado pelos testes e pelo simulador. */
export function assinar(corpo, timestamp, segredo) {
  const mac = createHmac("sha256", segredo);
  mac.update(Buffer.from(`${timestamp}.`, "utf8"));
  mac.update(Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), "utf8"));
  return PREFIXO_ASSINATURA + mac.digest("hex");
}

/**
 * {ok:true} ou {ok:false, motivo, desvio_s?}. Motivos (estáveis — vão ao log):
 *   SEM_SEGREDO        a config não tem segredo (não deveria chegar aqui: a config recusa);
 *   SEM_CABECALHO      falta X-LesChats-Timestamp ou X-LesChats-Signature;
 *   CORPO_VAZIO        corpo de tamanho zero nunca valida (do lado deles também não);
 *   SEM_PREFIXO        a assinatura não começa com "sha256=";
 *   TIMESTAMP_INVALIDO não é um inteiro de segundos;
 *   FORA_DA_JANELA     |agora − ts| > 300 s (o desvio vai junto: relógio torto ou replay);
 *   TAMANHO            a assinatura tem outro tamanho — conferido ANTES do timingSafeEqual, que
 *                      LANÇA com tamanhos diferentes (ao contrário do compare_digest do Python);
 *   ASSINATURA         o HMAC não bate.
 */
export function verificarAssinatura(rawBody, timestamp, assinatura, segredo, { agoraMs = Date.now() } = {}) {
  if (!segredo) return { ok: false, motivo: "SEM_SEGREDO" };
  if (!timestamp || !assinatura) return { ok: false, motivo: "SEM_CABECALHO" };
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return { ok: false, motivo: "CORPO_VAZIO" };
  const ts = String(timestamp).trim();
  const sig = String(assinatura).trim();
  if (!sig.startsWith(PREFIXO_ASSINATURA)) return { ok: false, motivo: "SEM_PREFIXO" };
  if (!TIMESTAMP.test(ts)) return { ok: false, motivo: "TIMESTAMP_INVALIDO" };
  const desvio = Math.round(Math.floor(agoraMs / 1000) - Number(ts));
  if (Math.abs(desvio) > TOLERANCIA_S) return { ok: false, motivo: "FORA_DA_JANELA", desvio_s: desvio };

  const esperada = Buffer.from(assinar(rawBody, ts, segredo), "utf8");
  const recebida = Buffer.from(sig, "utf8");
  if (recebida.length !== esperada.length) return { ok: false, motivo: "TAMANHO" };
  if (!timingSafeEqual(recebida, esperada)) return { ok: false, motivo: "ASSINATURA" };
  return { ok: true };
}

/**
 * Só os CABEÇALHOS, antes de ler o corpo: a rota é pública, e sem isto qualquer um faria o servidor
 * ler (e guardar na memória) o corpo inteiro antes da primeira recusa. Não prova nada — quem tem a
 * forma certa ainda passa pelo HMAC completo de verificarAssinatura, depois do corpo lido —; só barra,
 * de graça, o que nem tem a cara de uma requisição da Les Chats. Mesmos motivos de verificarAssinatura,
 * e um a mais: FORMATO (o tamanho certo, mas não é hex minúsculo — nunca bateria).
 */
export function verificarCabecalhos(timestamp, assinatura, { agoraMs = Date.now() } = {}) {
  if (!timestamp || !assinatura) return { ok: false, motivo: "SEM_CABECALHO" };
  const ts = String(timestamp).trim();
  const sig = String(assinatura).trim();
  if (!sig.startsWith(PREFIXO_ASSINATURA)) return { ok: false, motivo: "SEM_PREFIXO" };
  if (!TIMESTAMP.test(ts)) return { ok: false, motivo: "TIMESTAMP_INVALIDO" };
  const desvio = Math.round(Math.floor(agoraMs / 1000) - Number(ts));
  if (Math.abs(desvio) > TOLERANCIA_S) return { ok: false, motivo: "FORA_DA_JANELA", desvio_s: desvio };
  if (Buffer.byteLength(sig, "utf8") !== TAMANHO_ASSINATURA) return { ok: false, motivo: "TAMANHO" };
  if (!HEX_DA_ASSINATURA.test(sig.slice(PREFIXO_ASSINATURA.length))) return { ok: false, motivo: "FORMATO" };
  return { ok: true };
}

// ── O wa_id e o nono dígito ───────────────────────────────────────────────────
//
// O celular brasileiro tem duas grafias da MESMA linha: 55 + DDD + 9 + 8 dígitos (13) e, sem o nono
// dígito, 55 + DDD + 8 dígitos (12). O webhook da Meta manda o `wa_id` de muitos números SEM o 9, e a
// Les Chats repassa o `from` cru — então um FIELDS_DONO_WA_ID copiado da agenda (com o 9) recusaria
// toda mensagem do Carlos, em silêncio ({}), sem o log poder dizer por quê (ele não leva o número).
//
// Só a forma de 12 dígitos cujo número local começa em 6–9 (a faixa do celular antes do nono dígito)
// ganha o 9; um fixo (2–5) fica como está. Igualar as duas grafias de UM número não alarga a allowlist.

/** O wa_id na forma canônica (o celular brasileiro com o 9), ou null se não é só dígitos. */
export function formaCanonicaWaId(valor) {
  const d = String(valor ?? "").trim();
  if (!/^\d{1,32}$/.test(d)) return null;
  if (d.length === 12 && d.startsWith("55") && /[6-9]/.test(d[4])) return `${d.slice(0, 4)}9${d.slice(4)}`;
  return d;
}

/** Os dois wa_id são a mesma linha? (5511999998888 e 551199998888 são.) */
export function mesmoWaId(a, b) {
  const x = formaCanonicaWaId(a);
  return x !== null && x === formaCanonicaWaId(b);
}

/**
 * Para o log da recusa, SEM o número: os dois só diferem por um 9 logo depois do DDD? Pega o que a
 * forma canônica deixa passar (o número local fora da faixa 6–9) — é o diagnóstico de "copiei o
 * número do jeito errado", que de outro modo só se faria comparando os números, que o log não tem.
 */
export function difereSoNoNonoDigito(a, b) {
  const [x, y] = [String(a ?? "").trim(), String(b ?? "").trim()];
  const [longo, curto] = x.length > y.length ? [x, y] : [y, x];
  return longo.length === 13 && curto.length === 12 && longo.startsWith("55") && longo[4] === "9" &&
    longo.slice(0, 4) === curto.slice(0, 4) && longo.slice(5) === curto.slice(4);
}

// ── O envelope (§3.2) ─────────────────────────────────────────────────────────
//
// Só o que o Fields usa é validado; o resto (inclusive campos novos que a Les Chats acrescentar) é
// ignorado.
//
// Duas classes de campo. ESSENCIAIS — o wamid (a idempotência), o wa_id (a allowlist) e o tipo da
// mensagem: sem eles não há como responder com segurança, e o envelope é recusado (handoff). O RESTO
// — tentativa, ids da Fase 2, janela, textos, datas, o `history` — cai para nulo quando vem torto
// (`.catch(null)`): um `attempt` inesperado não pode transformar a mensagem do Carlos em ticket. A
// janela torta conta como aberta, igual à ausente.
//
// ## O `history` e a rajada (§6.2; plano §0, corrigido em 11/10)
//
// O Fields guarda a própria sessão, mas o `history` NÃO é dispensável: quando o Carlos manda várias
// mensagens seguidas, as primeiras desistem na Les Chats e só a última faz o POST — as anteriores
// chegam APENAS ali. Ignorá-lo perde "cria a tarefa X" de "cria a tarefa X" + "pra amanhã", sem erro
// nenhum, e a resposta à segunda dá a impressão de que tudo foi atendido. Daqui sai só a leitura: as
// mensagens do cliente no FIM do history (ver rajadaDoHistorico). Descartar as que já tiveram POST
// próprio (pelo wamid) e montar o que vai ao modelo é da rota.

const id = z.number().int().nonnegative().nullable().optional().catch(null);
const textoOpcional = z.string().nullable().optional().catch(null);
const flag = z.boolean().nullable().optional().catch(null);
const transcricao = z.object({ text: textoOpcional }).nullable().optional().catch(null);

const ENVELOPE = z.object({
  event: z.literal(EVENTO_MENSAGEM),
  event_id: z.string().trim().min(1).max(512),
  sent_at: textoOpcional,
  attempt: z.number().int().min(1).nullable().optional().catch(null),
  bot_id: id,
  channel_id: id,
  conversation_id: id,
  contact: z.object({ wa_id: z.string().trim().min(1).max(32) }),
  window: z.object({ open: flag, requires_template: flag }).nullable().optional().catch(null),
  message: z.object({
    type: z.string().trim().min(1).max(32),
    text: textoOpcional,
    caption: textoOpcional,
    created_at: textoOpcional,
    // Ajuste ao contrato (plano §0): a Les Chats transcreve ANTES do POST.
    transcription: transcricao,
    // A forma do erro não está fixada no contrato: qualquer valor não nulo conta como "falhou".
    transcription_error: z.unknown().optional(),
  }),
  // Lido entrada a entrada (rajadaDoHistorico): uma entrada torta não derruba o envelope.
  history: z.array(z.unknown()).max(100).nullable().optional().catch(null),
});

/** Uma entrada do `history` — o mesmo formato de `message` (§3.2), lido só no que a rajada usa. */
const MENSAGEM_DO_HISTORICO = z.object({
  sender_type: z.string(),
  type: z.string().trim().min(1).max(32),
  external_id: z.string().trim().min(1).max(512).nullable().optional().catch(null),
  text: textoOpcional,
  caption: textoOpcional,
  transcription: transcricao,
  created_at: textoOpcional,
});

const textoOuNulo = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * As mensagens do cliente no FIM do `history` — depois da última que não é dele (a resposta do bot,
 * de um atendente, uma nota): as que ficaram sem resposta. O `history` é cronológico crescente
 * (§3.2), então a leitura é de trás para a frente, até a primeira que não é CUSTOMER. Uma entrada
 * ilegível conta como fronteira: sem saber quem a mandou, não dá para dizer que o que veio antes dela
 * ficou sem resposta. A própria mensagem do envelope, se vier repetida no `history`, sai.
 *
 * Devolve, em ordem: [{externalId, tipo, texto, legenda, transcricao, criadoEm}].
 */
function rajadaDoHistorico(history, eventId) {
  const lista = Array.isArray(history) ? history : [];
  const finais = [];
  for (let i = lista.length - 1; i >= 0; i--) {
    const r = MENSAGEM_DO_HISTORICO.safeParse(lista[i]);
    if (!r.success || r.data.sender_type.trim().toUpperCase() !== "CUSTOMER") break;
    finais.unshift(r.data);
  }
  return finais
    .filter((m) => m.external_id !== eventId)
    .map((m) => ({
      externalId: m.external_id ?? null,
      tipo: m.type.toUpperCase(),
      texto: textoOuNulo(m.text),
      legenda: textoOuNulo(m.caption),
      transcricao: textoOuNulo(m.transcription?.text),
      criadoEm: m.created_at ?? null,
    }));
}

/**
 * O envelope bruto (o objeto do JSON.parse) → {ok:true, envelope} | {ok:false, motivo, campos}.
 * `campos` são só os NOMES dos campos que falharam (vão ao log; os valores, não).
 *
 * envelope = {eventId, attempt, botId, channelId, conversationId, waId, janelaAberta, tipo, texto,
 *             legenda, transcricao, transcricaoFalhou, criadoEm, enviadoEm, anteriores}
 *
 * A janela: fechada quando `open` é false OU `requires_template` é true — nos dois casos um texto
 * livre nasceria DRAFT e não seria entregue (§5.1). Sem o objeto `window`, aberta: o evento é causado
 * por uma mensagem do Carlos, que acabou de abrir a janela.
 *
 * `anteriores`: a rajada (rajadaDoHistorico) — candidatas, ainda sem o descarte pelo wamid.
 */
export function normalizarEnvelope(bruto) {
  const r = ENVELOPE.safeParse(bruto);
  if (!r.success) {
    const campos = [...new Set(r.error.issues.map((i) => (i.path.length ? i.path.join(".") : "(raiz)")))];
    return { ok: false, motivo: "ENVELOPE_INVALIDO", campos };
  }
  const e = r.data;
  const m = e.message;
  return {
    ok: true,
    envelope: {
      eventId: e.event_id,
      attempt: e.attempt ?? 1,
      botId: e.bot_id ?? null,
      channelId: e.channel_id ?? null,
      conversationId: e.conversation_id ?? null,
      waId: e.contact.wa_id,
      janelaAberta: !(e.window?.open === false || e.window?.requires_template === true),
      tipo: m.type.toUpperCase(),
      texto: textoOuNulo(m.text),
      legenda: textoOuNulo(m.caption),
      transcricao: textoOuNulo(m.transcription?.text),
      transcricaoFalhou: m.transcription_error !== undefined && m.transcription_error !== null,
      criadoEm: m.created_at ?? null,
      enviadoEm: e.sent_at ?? null,
      anteriores: rajadaDoHistorico(e.history, e.event_id),
    },
  };
}

// ── A resposta (§5) ───────────────────────────────────────────────────────────

/** {handoff:{reason, note?}} — vira ticket no painel da Les Chats. `reason` fora da lista é erro nosso. */
export function respostaHandoff(reason, note = null) {
  if (!MOTIVOS_HANDOFF.includes(reason)) throw new TypeError(`leschats: reason de handoff fora do contrato (${String(reason)})`);
  return { handoff: note ? { reason, note } : { reason } };
}

/**
 * O corpo do 200 para um texto do agente, pela janela informada no envelope (§5.1):
 *   aberta  → {text}, já no formato do WhatsApp e ≤ 4096;
 *   fechada → {template:{name}} se LESCHATS_TEMPLATE_JANELA_FECHADA estiver configurado; senão
 *             {handoff:{reason:"OUTSIDE_WINDOW"}} — texto livre nasceria DRAFT e morreria ali, sem
 *             entrega e sem aviso; o handoff ao menos vira ticket visível.
 * Devolve {corpo, forma: "TEXT"|"TEMPLATE"|"HANDOFF", cortado}.
 */
export function montarResposta({ janelaAberta, texto = "", templateJanelaFechada = null }) {
  if (!janelaAberta) {
    return templateJanelaFechada
      ? { corpo: { template: { name: templateJanelaFechada } }, forma: "TEMPLATE", cortado: false }
      : { corpo: respostaHandoff("OUTSIDE_WINDOW"), forma: "HANDOFF", cortado: false };
  }
  const { texto: final, cortado } = formatarResposta(texto);
  return { corpo: { text: final }, forma: "TEXT", cortado };
}

/** A forma de um corpo já montado (para o log da resposta repetida). */
export function formaDe(corpo) {
  if (corpo?.handoff) return "HANDOFF";
  if (corpo?.template) return "TEMPLATE";
  if (typeof corpo?.text === "string") return "TEXT";
  return "VAZIO";
}
