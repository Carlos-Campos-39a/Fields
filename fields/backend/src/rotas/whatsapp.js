import express from "express";
import { aw } from "../lib/rota.js";
import { log } from "../lib/log.js";
import { EVENTO_CONCLUIDO, EVENTO_EM_VOO } from "../dominio/enums.js";
import { TIPOS_DE_ANEXO, ehComandoDesfazer, rodarTurno } from "../agente/motor.js";
import { TEXTO_FALHA } from "../servicos/turnos.js";
import { lojaEventosSql } from "../servicos/whatsapp.js";
import {
  EVENTO_MENSAGEM, difereSoNoNonoDigito, formaDe, mesmoWaId, montarResposta, normalizarEnvelope, respostaHandoff,
  verificarAssinatura, verificarCabecalhos,
} from "../integracoes/leschats.js";
import { TEXTO_CHAT_MAX, criarDepsDoMotor } from "./agente.js";

// A3 · o webhook do WhatsApp — Fase 1 do contrato da Les Chats (síncrona: a resposta é o corpo do
// 200, e o Fields não guarda credencial nenhuma dela; só o segredo HMAC que verifica a entrada).
//
//   POST /api/agente/whatsapp   ← bots.external_url (Bot kind=EXTERNAL na Les Chats)
//
// PÚBLICA: entra em ROTAS_PUBLICAS (app.js), ANTES do exigirAuth — quem autentica é o HMAC — e antes
// do express.json global: o corpo é lido CRU (express.raw) e o JSON.parse só vem depois da
// assinatura conferida, sobre os mesmos bytes (contrato §4.2: reserializar quebra o HMAC).
//
// O fluxo, na ordem:
//   0. só os cabeçalhos, ANTES de ler o corpo: sem a forma de uma assinatura da Les Chats (ou fora
//      dos 300 s) → 403, e o corpo nem é lido — a rota é pública, e ler 512 KB de qualquer um antes
//      da primeira recusa é o que a convenção de rotas/auth.js proíbe. Webhook desligado e sem
//      segredo → 503;
//   1. assinatura inválida                → 403 (nada é gravado);
//   2. event ≠ "message.received"        → 204 (eventos novos virão com nomes novos: ignorar);
//   3. webhook desligado (com o segredo)  → 200 {handoff: NO_BOT}: vira ticket NA HORA. Um 503 só
//      viraria ticket depois de três mensagens falhadas (contrato §6.1) — e essas três ficariam sem
//      resposta e sem ticket, o silêncio sem rastro que a Les Chats pediu para evitar;
//   4. contact.wa_id ≠ FIELDS_DONO_WA_ID → 200 {} + LESCHATS_REMETENTE_RECUSADO (silêncio deliberado).
//      As duas grafias do celular brasileiro — com e sem o nono dígito — são o mesmo número;
//   5. idempotência pelo wamid (eventos_recebidos): repetido e concluído → o MESMO corpo; repetido
//      com o turno em voo → espera até 25 s pelo corpo, senão {handoff: BOT_FAILURE};
//   6. janela de 24 h fechada → {template} configurado, senão {handoff: OUTSIDE_WINDOW} — e o turno
//      NÃO roda: uma escrita feita agora não teria como ser contada ao Carlos;
//   7. a rajada (§6.2): as mensagens do `history` que ficaram sem resposta e não tiveram POST
//      próprio entram no turno, antes da mensagem da vez (rajadaParaOTurno);
//   8. a mensagem da vez (entradaDoEnvelope): texto → cru; áudio → a transcrição que a Les Chats fez
//      antes do POST ("desfazer" falado vale como escrito), sem ela texto fixo; imagem/documento/vídeo
//      → a legenda, num bloco marcado, sem ela texto fixo; contato/localização/botão → conteúdo
//      compartilhado, marcado; reação, sistema e template → silêncio; tipo desconhecido → texto fixo;
//   9. o turno do motor, canal "whatsapp" — o "desfazer" é interceptado lá, sem modelo.
//
// Todo evento autenticado recebe 200: um 5xx faria a Les Chats retentar e, depois, contar falha
// (três seguidas e a conversa cai para humano, contrato §6.1). Falha interna vira o texto fixo, que o
// Carlos lê e sabe que pode repetir; falta de resposta a tempo vira handoff, que é ticket VISÍVEL —
// silêncio sem rastro é a pior resposta num canal em que a pessoa fica esperando.
//
// Logs: nenhum texto do Carlos, nenhum wa_id e nenhum wamid (ele carrega o telefone em base64) — só
// códigos, ids da Les Chats (conversa, canal), o turno, contagens e a duração.

export const CAMINHO_WHATSAPP = "/agente/whatsapp";
/** Quanto uma retentativa espera o turno da 1ª entrega terminar (o POST da Les Chats tem 120 s). */
export const ESPERA_EM_VOO_MS = 25_000;
export const INTERVALO_EM_VOO_MS = 500;
/**
 * Teto do corpo do envelope. O de verdade tem uns 3 KB; o pior caso é o `history` cheio (20
 * mensagens de até 4096 caracteres — e o json.dumps do Python escapa todo acento como \uXXXX, seis
 * bytes por caractere): perto de 500 KB. O exemplo do contrato usa 2 MB, quatro vezes o necessário
 * numa rota pública.
 */
export const CORPO_MAX = "512kb";
/** O que vai ao modelo, no máximo, por mensagem — o mesmo teto do chat da tela. */
export const ENTRADA_MAX = TEXTO_CHAT_MAX;
/**
 * Até quanto tempo antes da mensagem da vez uma mensagem da rajada ainda entra no turno. Uma rajada
 * é de segundos; o job da Les Chats tem 300 s. Mais velha que isso não é rajada: é mensagem que
 * ficou sem resposta por outro motivo (o webhook desligado, uma falha) — e executá-la agora, horas
 * depois, faria o que o Carlos talvez já tenha feito à mão.
 */
export const JANELA_DA_RAJADA_MS = 10 * 60_000;

// ── Os textos fixos (o que o Carlos lê quando o turno não roda) ─────────────────
export const TEXTO_AUDIO_SEM_TRANSCRICAO = "Não consegui entender esse áudio. Pode mandar por escrito?";
export const TEXTO_ANEXO_SEM_LEGENDA =
  "Recebi o anexo, mas ainda não consigo abrir imagem, vídeo nem documento. Me diga por escrito o que fazer com ele.";
export const TEXTO_SEM_TEXTO = "Não consegui ler essa mensagem. Pode mandar por escrito?";
export const TEXTO_AGENTE_DESLIGADO = "O assistente do Fields está desligado agora; esta mensagem não foi processada.";

// As notas do handoff: aparecem no ticket do painel da Les Chats, para quem abrir entender o porquê.
export const NOTA_EM_VOO = "O Fields ainda processava esta mesma mensagem e não respondeu a tempo.";
export const NOTA_ENVELOPE_INVALIDO = "O Fields não conseguiu ler o envelope desta mensagem.";
export const NOTA_DESLIGADO = "O WhatsApp está desligado no Fields.";

// O tipo da Les Chats (§3.2) → o tipo do motor (motor.TIPOS_DE_MENSAGEM). Só TEXT vai ao modelo como
// texto digitado; o resto vai marcado (motor.blocoDoItem). O que não está aqui não vira turno.
const TIPO_DO_MOTOR = Object.freeze({
  TEXT: "texto", AUDIO: "audio",
  IMAGE: "imagem", DOCUMENT: "documento", VIDEO: "video", STICKER: "figurinha",
  // §3.2: a Les Chats sintetiza um `text` legível para estes — a partir de conteúdo de TERCEIRO (o
  // nome de um vCard, o endereço de um lugar): conteúdo compartilhado, não pedido do Carlos.
  LOCATION: "localizacao", CONTACTS: "contato", INTERACTIVE: "interativo",
});
// Sem conteúdo do Carlos a atender: um 👍 numa resposta do bot, um aviso do sistema (que pode trazer
// telefone), um template. Silêncio, sem turno — responder custaria um turno do modelo para dizer nada.
const SILENCIOSOS = Object.freeze({ REACTION: "REACAO", SYSTEM: "SISTEMA", TEMPLATE: "TEMPLATE" });

const PG_CODIGO = /^[0-9A-Z]{5}$/;
const erroDe = (err) => ({
  erro: err?.name ?? typeof err,
  pg_codigo: PG_CODIGO.test(err?.code ?? "") ? err.code : undefined,
});

const ehJson = (req) =>
  String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json";

/** O nome do evento ignorado, só se tiver a cara de um (vai ao log; nada arbitrário entra lá). */
const nomeDeEvento = (v) => (typeof v === "string" && /^[a-z][a-z0-9_.]{0,63}$/.test(v) ? v : "invalido");

/** X-LesChats-Delivery: 1 na 1ª entrega, 2 na retentativa (só para o log da recusa; o resto usa `attempt`). */
const entregaDe = (req) => {
  const n = Number(req.get("X-LesChats-Delivery"));
  return Number.isInteger(n) && n > 0 && n < 100 ? n : undefined;
};

function cortarEntrada(campo, valor) {
  if (valor.length <= ENTRADA_MAX) return valor;
  log.warn("LESCHATS_ENTRADA_CORTADA", { campo, tamanho: valor.length, max: ENTRADA_MAX });
  return valor.slice(0, ENTRADA_MAX);
}

/**
 * Uma mensagem do envelope (a da vez, ou uma do `history`) como item do motor: {tipo, texto|null}.
 * null para o que não é conteúdo (reação, sistema, template, tipo desconhecido).
 */
function itemDaMensagem(m, { rajada = false } = {}) {
  const tipo = TIPO_DO_MOTOR[m.tipo];
  if (!tipo) return null;
  const anexo = TIPOS_DE_ANEXO.includes(tipo);
  const bruto = tipo === "audio" ? m.transcricao : anexo ? m.legenda : (m.texto ?? m.legenda);
  const campo = rajada ? "anterior" : tipo === "audio" ? "transcricao" : anexo ? "legenda" : "texto";
  return { tipo, texto: bruto ? cortarEntrada(campo, bruto) : null };
}

/** O item com texto como a entrada do motor. Fora da rajada, "desfazer" falado vira o comando escrito. */
function entradaDoItem(item, { rajada }) {
  if (item.tipo === "texto") return { texto: item.texto };
  if (item.tipo === "audio") return !rajada && ehComandoDesfazer(item.texto) ? { texto: item.texto } : { transcricao: item.texto };
  if (TIPOS_DE_ANEXO.includes(item.tipo)) return { legenda: item };
  return { compartilhado: item };
}

/**
 * O que o envelope pede: {entrada} para o motor, {fixo, motivo} para um texto sem turno, ou
 * {silencio} para não responder nada.
 *
 * Com a rajada (`anteriores`), o turno roda SEMPRE: as mensagens anteriores não terão outra chance.
 * A da vez entra como de costume; sem nada legível (áudio sem transcrição, anexo sem legenda), entra
 * como a última da lista, com o marcador; sem conteúdo nenhum (uma reação), fica de fora.
 */
function entradaDoEnvelope(e, anteriores = []) {
  const item = itemDaMensagem(e);
  if (anteriores.length) {
    if (item?.texto) return { entrada: { ...entradaDoItem(item, { rajada: true }), anteriores } };
    return { entrada: { anteriores: item ? [...anteriores, item] : anteriores } };
  }
  if (SILENCIOSOS[e.tipo]) return { silencio: SILENCIOSOS[e.tipo] };
  if (!item) return { fixo: TEXTO_SEM_TEXTO, motivo: "TIPO_NAO_SUPORTADO" };
  if (item.texto) return { entrada: entradaDoItem(item, { rajada: false }) };
  if (item.tipo === "audio") return { fixo: TEXTO_AUDIO_SEM_TRANSCRICAO, motivo: e.transcricaoFalhou ? "TRANSCRICAO_FALHOU" : "SEM_TRANSCRICAO" };
  if (TIPOS_DE_ANEXO.includes(item.tipo)) return { fixo: TEXTO_ANEXO_SEM_LEGENDA, motivo: "ANEXO_SEM_LEGENDA" };
  return { fixo: TEXTO_SEM_TEXTO, motivo: "SEM_TEXTO" };
}

const textoFixo = (texto) => ({ corpo: montarResposta({ janelaAberta: true, texto }).corpo, forma: "TEXT" });

/**
 * `depsMotor` vem do app (as mesmas dependências do chat da tela: um cliente do modelo por processo).
 * `whatsapp` são as costuras do teste: {eventos, relogio, esperaMaxMs, intervaloMs}; sem elas, a loja
 * é o Postgres, o relógio é o de verdade e a espera é a do contrato.
 */
export function rotasWhatsapp({ db, estado, config, motor = {}, depsMotor = criarDepsDoMotor({ db, estado, config, motor }), whatsapp = {} }) {
  const r = express.Router();
  const cfg = config?.whatsapp ?? { habilitado: false, segredo: null };
  const { agente, deps } = depsMotor;
  const eventos = whatsapp.eventos ?? lojaEventosSql(db);
  const relogio = whatsapp.relogio ?? (() => new Date());
  const esperaMaxMs = whatsapp.esperaMaxMs ?? ESPERA_EM_VOO_MS;
  const intervaloMs = whatsapp.intervaloMs ?? INTERVALO_EM_VOO_MS;

  function recusarAssinatura(req, res, v, etapa) {
    log.warn("LESCHATS_ASSINATURA_RECUSADA", { motivo: v.motivo, etapa, desvio_s: v.desvio_s, entrega: entregaDe(req) });
    res.locals.motivo = v.motivo;
    return res.status(403).json({ error: "assinatura_invalida" });
  }

  /** 0. Os cabeçalhos, ANTES do express.raw: o que não tem a forma de uma requisição da Les Chats nem é lido. */
  function conferirCabecalhos(req, res, next) {
    req.origem = "whatsapp";
    if (!cfg.habilitado && !cfg.segredo) {
      // Sem segredo não há como saber se é a Les Chats: o 503 é o único que sobra. Ela retenta uma
      // vez e conta a falha; a conversa só vira ticket depois de três (contrato §6.1).
      log.warn("LESCHATS_DESLIGADO", { resposta: "503" });
      res.locals.motivo = "WHATSAPP_DESLIGADO";
      return res.status(503).json({ error: "whatsapp_desligado" });
    }
    const v = ehJson(req)
      ? verificarCabecalhos(req.get("X-LesChats-Timestamp"), req.get("X-LesChats-Signature"), { agoraMs: relogio().getTime() })
      : { ok: false, motivo: "CONTENT_TYPE_NAO_JSON" };
    if (!v.ok) return recusarAssinatura(req, res, v, "cabecalhos");
    return next();
  }

  /** A retentativa com o turno em voo: consulta a linha até ela concluir, ou até a espera acabar. */
  async function esperarConclusao(eventId) {
    const limite = Date.now() + esperaMaxMs;
    for (;;) {
      let linha;
      try { linha = await eventos.obter(eventId); } catch (err) {
        log.erro("LESCHATS_DEDUP_FALHOU", { etapa: "esperar", ...erroDe(err) });
        return null;
      }
      if (linha?.status === EVENTO_CONCLUIDO) return linha.resposta ?? {};
      if (Date.now() + intervaloMs > limite) return null;
      await new Promise((ok) => setTimeout(ok, intervaloMs));
    }
  }

  async function responderRepetido(res, e, reserva, ms) {
    let corpo = null;
    let situacao;
    if (reserva.status === EVENTO_CONCLUIDO) {
      corpo = reserva.resposta ?? {};
      situacao = "CONCLUIDO";
    } else if (reserva.status === EVENTO_EM_VOO) {
      corpo = await esperarConclusao(e.eventId);
      situacao = corpo ? "EM_VOO_RESOLVIDO" : "EM_VOO_ESGOTADO";
    } else {
      situacao = "SEM_REGISTRO"; // a linha sumiu entre o INSERT e o UPDATE (limpeza): não há o que repetir
    }
    corpo ??= respostaHandoff("BOT_FAILURE", NOTA_EM_VOO);
    (situacao === "CONCLUIDO" || situacao === "EM_VOO_RESOLVIDO" ? log.info : log.warn)("LESCHATS_REPETIDO", {
      situacao, forma: formaDe(corpo), attempt: e.attempt, turno_id: reserva.turnoId ?? undefined,
      conversation_id: e.conversationId ?? undefined, duration_ms: ms(),
    });
    res.locals.motivo = `REPETIDO_${situacao}`;
    return res.status(200).json(corpo);
  }

  /**
   * 7. A rajada (contrato §6.2): quando o Carlos manda várias mensagens seguidas, só a última faz o
   * POST, e as anteriores chegam APENAS no `history` do envelope. Daqui saem, em ordem, as que este
   * turno vai atender:
   *   - só as do cliente no fim do `history` (normalizarEnvelope já cortou na última resposta);
   *   - sem wamid, fora: é por ele que se garante que nada roda duas vezes;
   *   - mais velhas que JANELA_DA_RAJADA_MS (antes da mensagem da vez), fora: não são rajada;
   *   - reação, sistema e template, fora: não há o que atender;
   *   - as que já passaram por eventos_recebidos, fora: tiveram POST (e turno) próprio. O descarte é
   *     o próprio INSERT da absorção (servicos/whatsapp.absorverEventos), que também fecha a corrida
   *     de um POST anterior que chegue DEPOIS deste: ele acha a linha e recebe {}.
   * Banco fora na absorção → nenhuma (sem saber se já rodaram, não se arrisca rodar duas vezes), e o
   * log diz quantas ficaram de fora. Nada do texto vai ao log; só as contagens.
   */
  async function rajadaParaOTurno(e) {
    if (e.anteriores.length === 0) return [];
    const referencia = [e.criadoEm, e.enviadoEm].map((v) => Date.parse(v ?? "")).find(Number.isFinite) ?? relogio().getTime();
    const conta = { velhas: 0, sem_id: 0, sem_conteudo: 0 };
    const candidatas = [];
    for (const m of e.anteriores) {
      if (!m.externalId) { conta.sem_id++; continue; }
      // Data ilegível não descarta (NaN > x é falso): na dúvida, a mensagem do Carlos entra.
      if (referencia - Date.parse(m.criadoEm ?? "") > JANELA_DA_RAJADA_MS) { conta.velhas++; continue; }
      const item = itemDaMensagem(m, { rajada: true });
      if (!item) { conta.sem_conteudo++; continue; }
      candidatas.push({ id: m.externalId, item });
    }
    let novas = new Set();
    if (candidatas.length) {
      try {
        novas = new Set(await eventos.absorver(candidatas.map((c) => c.id)));
      } catch (err) {
        log.erro("LESCHATS_DEDUP_FALHOU", {
          etapa: "rajada", candidatas: candidatas.length, conversation_id: e.conversationId ?? undefined, ...erroDe(err),
        });
        return [];
      }
    }
    const usadas = new Set();
    const anteriores = [];
    for (const c of candidatas) {
      if (!novas.has(c.id) || usadas.has(c.id)) continue;
      usadas.add(c.id);
      anteriores.push(c.item);
    }
    (conta.velhas || conta.sem_id ? log.warn : log.info)("LESCHATS_RAJADA", {
      no_historico: e.anteriores.length, incluidas: anteriores.length, ja_recebidas: candidatas.length - anteriores.length,
      ...conta, conversation_id: e.conversationId ?? undefined,
    });
    return anteriores;
  }

  /** Os passos 6–9 para a 1ª entrega. Nunca lança: o pior caso é o texto de falha. */
  async function processar(e) {
    if (e.conversationId !== null) {
      try {
        await eventos.gravarCanal({ waId: e.waId, conversationId: e.conversationId, botId: e.botId });
      } catch (err) {
        // A resposta de agora não depende disto (só a Fase 2): segue, e o log avisa.
        log.erro("LESCHATS_CANAL_NAO_GRAVADO", erroDe(err));
      }
    }

    if (!e.janelaAberta) {
      const r = montarResposta({ janelaAberta: false, templateJanelaFechada: cfg.templateJanelaFechada });
      log.warn("LESCHATS_JANELA_FECHADA", { resposta: r.forma, conversation_id: e.conversationId ?? undefined });
      return { corpo: r.corpo, forma: r.forma, motivo: "JANELA_FECHADA" };
    }

    // Com o agente desligado não há turno, e a rajada não é absorvida: o texto fixo que sai agora diz
    // ao Carlos que nada foi processado (e, como resposta do bot no `history`, fecha a rajada).
    const anteriores = agente.habilitado ? await rajadaParaOTurno(e) : [];
    const plano = entradaDoEnvelope(e, anteriores);
    if (plano.silencio) return { corpo: {}, forma: "VAZIO", motivo: plano.silencio };
    if (plano.fixo) return { ...textoFixo(plano.fixo), motivo: plano.motivo };
    if (!agente.habilitado) return { ...textoFixo(TEXTO_AGENTE_DESLIGADO), motivo: "AGENTE_DESLIGADO", nivel: "warn" };

    // O turno nunca rejeita por falha dele (vira FALHOU, com texto honesto); o catch é o cinto para o
    // que acontece antes do laço (abrir o turno no banco, montar o cliente).
    let turno;
    try {
      turno = await rodarTurno(deps(), { canal: "whatsapp", entrada: plano.entrada });
    } catch (err) {
      log.erro("LESCHATS_TURNO_FALHOU", {
        ...erroDe(err),
        anteriores: anteriores.length || undefined,
        pilha: typeof err?.stack === "string" ? err.stack.split("\n").slice(1, 7).map((l) => l.trim()) : undefined,
      });
      return { ...textoFixo(TEXTO_FALHA), motivo: "TURNO_FALHOU", nivel: "erro", anteriores: anteriores.length };
    }
    // Sem texto só quando o fim do turno não foi gravado (o banco caiu no concluirTurno): o fixo.
    const r = montarResposta({ janelaAberta: true, texto: turno.texto ?? TEXTO_FALHA });
    if (r.cortado) log.warn("LESCHATS_TEXTO_CORTADO", { turno_id: turno.turno_id, tamanho: String(turno.texto ?? "").length });
    return {
      corpo: r.corpo, forma: r.forma, turnoId: turno.turno_id, statusTurno: turno.status, cortado: r.cortado,
      anteriores: anteriores.length,
    };
  }

  r.post(CAMINHO_WHATSAPP, conferirCabecalhos, express.raw({ type: "application/json", limit: CORPO_MAX }), aw(async (req, res) => {
    const inicio = process.hrtime.bigint();
    const ms = () => Math.round(Number(process.hrtime.bigint() - inicio) / 1e6);

    // 1. A assinatura inteira, sobre os bytes crus (os cabeçalhos já passaram pelo passo 0).
    const corpoCru = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const v = verificarAssinatura(corpoCru, req.get("X-LesChats-Timestamp"), req.get("X-LesChats-Signature"), cfg.segredo, {
      agoraMs: relogio().getTime(),
    });
    if (!v.ok) return recusarAssinatura(req, res, v, "corpo");

    // 2. O evento. Daqui em diante a requisição é da Les Chats: sempre 200 (ou o 204 do evento novo).
    let bruto;
    try { bruto = JSON.parse(corpoCru.toString("utf8")); } catch { bruto = undefined; }
    const objeto = bruto !== null && typeof bruto === "object" && !Array.isArray(bruto);
    if (objeto && bruto.event !== EVENTO_MENSAGEM) {
      log.info("LESCHATS_EVENTO_IGNORADO", { event: nomeDeEvento(bruto.event) });
      res.locals.motivo = "EVENTO_IGNORADO";
      return res.status(204).end();
    }

    // 3. O webhook desligado, com o segredo para saber que é a Les Chats: ticket agora, não silêncio.
    if (!cfg.habilitado) {
      log.warn("LESCHATS_DESLIGADO", { resposta: "HANDOFF" });
      res.locals.motivo = "WHATSAPP_DESLIGADO";
      return res.status(200).json(respostaHandoff("NO_BOT", NOTA_DESLIGADO));
    }

    const n = objeto ? normalizarEnvelope(bruto) : { ok: false, motivo: "JSON_INVALIDO", campos: [] };
    if (!n.ok) {
      // Assinado, mas ilegível: defeito de um dos dois lados. Handoff, para a mensagem virar ticket
      // em vez de sumir — e o log diz quais CAMPOS falharam (os valores, não).
      log.warn("LESCHATS_ENVELOPE_INVALIDO", { motivo: n.motivo, campos: n.campos });
      res.locals.motivo = n.motivo;
      return res.status(200).json(respostaHandoff("BOT_FAILURE", NOTA_ENVELOPE_INVALIDO));
    }
    const e = n.envelope;

    // 4. A allowlist: só o Carlos fala com o agente. A Les Chats filtra do lado dela também; este é o
    // segundo lado. Silêncio para quem não é ele — e o log, sem o número: só o que diagnostica "o
    // número foi copiado do jeito errado" (quantos dígitos de cada lado, e se só o nono dígito difere).
    if (!mesmoWaId(e.waId, cfg.donoWaId)) {
      log.warn("LESCHATS_REMETENTE_RECUSADO", {
        conversation_id: e.conversationId ?? undefined, channel_id: e.channelId ?? undefined, attempt: e.attempt,
        digitos: e.waId.length, digitos_dono: String(cfg.donoWaId ?? "").length,
        difere_so_no_nono_digito: difereSoNoNonoDigito(e.waId, cfg.donoWaId),
      });
      res.locals.motivo = "REMETENTE_RECUSADO";
      return res.status(200).json({});
    }

    // 5. A idempotência pelo wamid. Sem ela não há como saber se o turno já rodou: com o banco fora,
    // o texto de falha (o Carlos repete) é melhor que um turno que pode ser o segundo.
    let reserva;
    try {
      reserva = await eventos.reservar(e.eventId);
    } catch (err) {
      log.erro("LESCHATS_DEDUP_FALHOU", { etapa: "reservar", ...erroDe(err) });
      res.locals.motivo = "DEDUP_FALHOU";
      return res.status(200).json(textoFixo(TEXTO_FALHA).corpo);
    }
    if (!reserva.nova) return responderRepetido(res, e, reserva, ms);

    // 6–9.
    let fim;
    try {
      fim = await processar(e);
    } catch (err) {
      log.erro("LESCHATS_ERRO_INTERNO", erroDe(err));
      fim = { ...textoFixo(TEXTO_FALHA), motivo: "ERRO_INTERNO", nivel: "erro" };
    }
    try {
      await eventos.concluir(e.eventId, { resposta: fim.corpo, turnoId: fim.turnoId ?? null });
    } catch (err) {
      // A resposta sai mesmo assim; a retentativa (se houver) espera os 25 s e recebe o handoff.
      log.erro("LESCHATS_DEDUP_FALHOU", { etapa: "concluir", turno_id: fim.turnoId ?? undefined, ...erroDe(err) });
    }
    log[fim.nivel ?? "info"]("LESCHATS_RESPOSTA", {
      forma: fim.forma, motivo: fim.motivo, tipo: e.tipo, attempt: e.attempt,
      turno_id: fim.turnoId ?? undefined, status_turno: fim.statusTurno, cortado: fim.cortado || undefined,
      anteriores: fim.anteriores || undefined, conversation_id: e.conversationId ?? undefined, duration_ms: ms(),
    });
    if (fim.motivo) res.locals.motivo = fim.motivo;
    return res.status(200).json(fim.corpo);
  }));

  return r;
}
