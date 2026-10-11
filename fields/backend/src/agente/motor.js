// O motor do agente — um turno de conversa na tela (e, na A3, no WhatsApp): a mensagem do Carlos
// vai ao modelo, o modelo pede ferramentas, as ferramentas rodam pelo gargalo da ontologia, e o
// texto final volta. Porta do grafo do CRM, num LAÇO MANUAL em vez do LangGraph, por quatro razões:
//
//   1. cada rodada é gravada atomicamente: o assistente com os seus tool_use E o user com os
//      tool_result, num tx (sessoes.acrescentarMensagens) — um tool_use órfão no histórico envenena a
//      conversa para sempre (a API recusa todo turno seguinte);
//   2. o prazo é conferido antes de cada chamada ao modelo E antes de cada ferramenta;
//   3. a ação de desfazer nasce no mesmo tx da escrita (executeWrite → registrarAcao);
//   4. refusal, max_tokens e pause_turn têm tratamento próprio, e o cliente é injetável.
//
// ## O histórico é só acréscimo
//
// Ver sessoes.js: o pensamento preservado do Opus 5.5 amarra cada bloco de thinking aos bytes de tudo
// o que veio antes. Então nada do que foi mandado muda: o system e as ferramentas são congelados
// (cliente.montarRequisicao), o dinâmico (data, memória, recap, a tarefa aberta) vai no PRIMEIRO
// BLOCO da mensagem do usuário (contextoDoTurno), e as respostas da API são guardadas e devolvidas
// byte a byte. Quando o turno acaba sem a palavra final do modelo (prazo, limite, falha depois de
// alguma ferramenta), o texto mostrado ao Carlos entra como mensagem do assistente — por acréscimo —
// para a conversa seguinte saber o que ele viu.
//
// ## O "desfazer" não passa pelo modelo
//
// Desfazer é inversão, não interpretação (desfazer.js). O comando é casado ANTES de qualquer chamada:
// zero tokens, e ele funciona justamente quando o modelo é que errou. O par user/assistente entra no
// histórico por acréscimo, para o modelo saber depois que aquilo voltou.
//
// ## Um turno por canal por vez
//
// Mutex em processo, em fila (naFila): a segunda mensagem espera a primeira terminar, em vez de as
// duas escreverem na mesma conversa ao mesmo tempo (seq duplicado, histórico entrelaçado). O prazo
// conta da CHEGADA: quem esperou na fila já gastou parte dele.

import { v4 as uuidv4 } from "uuid";
import { log } from "../lib/log.js";
import { normalizarBusca } from "../lib/texto.js";
import {
  CANAIS_DO_MOTOR, TURNO_CONCLUIDO, TURNO_ESGOTADO, TURNO_FALHOU, TURNO_RECUSADO,
} from "../dominio/enums.js";
import { OPERATIONS, contextoDoTurno } from "./ontologia.js";
import { executeRead, executeWrite, mensagemDaRecusa, serializarResultado } from "./ferramentas.js";
import { DESFAZER_JANELA_MIN, desfazerTurno } from "./desfazer.js";
import { classificarErro, montarRequisicao } from "./cliente.js";
import * as sessoes from "./sessoes.js";
import * as turnos from "../servicos/turnos.js";
import * as memorias from "../servicos/memorias.js";

// ── Os textos fixos (o que o Carlos lê quando o modelo não falou) ─────────────

export const TEXTO_FALHA = turnos.TEXTO_FALHA;
export const TEXTO_RECUSA = "Não consegui responder a esse pedido: o modelo recusou. Tente dizer de outro jeito.";
export const TEXTO_NADA_A_DESFAZER =
  `Não achei nada recente para desfazer — só volta o que eu fiz nos últimos ${DESFAZER_JANELA_MIN} minutos.`;

/** Abaixo disso não vale começar outra chamada ao modelo: ela não termina antes do prazo. */
export const PRAZO_MINIMO_MS = 5_000;

const NAO_EXECUTADA_PRAZO = "Não executada: o tempo deste turno acabou antes dela.";
const NAO_EXECUTADA_CORTE = "Não executada: a resposta foi cortada (max_tokens) antes de terminar este pedido.";

// ── O comando "desfazer" ──────────────────────────────────────────────────────

const COMANDO_DESFAZER = /^(desfazer|desfaz|desfaca)$/;

/** "desfazer", "Desfaz!", "desfaça." — a palavra sozinha. "desfaz a tarefa X" é pedido para o modelo. */
export function ehComandoDesfazer(texto) {
  const limpo = normalizarBusca(texto).trim().replace(/[\s.!?…]+$/u, "");
  return COMANDO_DESFAZER.test(limpo);
}

// ── A fila por canal (o mutex) ────────────────────────────────────────────────

const FILAS = new Map();

/** Roda `fn` depois de tudo o que já está na fila do canal. Uma falha não trava a fila. */
export function naFila(canal, fn) {
  const anterior = FILAS.get(canal) ?? Promise.resolve();
  const atual = anterior.then(fn);
  const cauda = atual.then(() => {}, () => {});
  FILAS.set(canal, cauda);
  cauda.then(() => { if (FILAS.get(canal) === cauda) FILAS.delete(canal); });
  return atual;
}

// ── As dependências (injetáveis) ──────────────────────────────────────────────

/** A persistência do motor, sobre o Postgres. O teste de unidade passa uma em memória com a mesma forma. */
export function lojaSql(db) {
  return {
    abrirTurno: (a) => turnos.abrirTurno(db, a),
    vincularSessao: (turnoId, sessaoId) => turnos.vincularSessao(db, turnoId, sessaoId),
    registrarProgresso: (turnoId, n) => turnos.registrarProgresso(db, turnoId, n),
    concluirTurno: (turnoId, fim) => turnos.concluirTurno(db, turnoId, fim),
    obterTurnoPublico: (turnoId) => turnos.obterTurnoPublico(db, turnoId),
    listarConversa: (canal, limite) => turnos.listarConversa(db, canal, limite),
    ultimoTurnoDesfazivel: (canal, janelaMin, o) => turnos.ultimoTurnoDesfazivel(db, canal, janelaMin, o),
    turnosParaRecap: (canal, o) => turnos.turnosParaRecap(db, canal, o),
    obterOuRenovar: (a) => sessoes.obterOuRenovar(db, a),
    acrescentarMensagens: (sessaoId, turnoId, mensagens, o) => sessoes.acrescentarMensagens(db, sessaoId, turnoId, mensagens, o),
    encerrarSessao: (sessaoId, motivo) => sessoes.encerrarSessao(db, sessaoId, motivo),
    encerrarAtiva: (canal, motivo) => sessoes.encerrarAtiva(db, canal, motivo),
    memoriasAtivas: () => memorias.listarAtivas(db, {}),
  };
}

/** O executor de verdade: pelo tipo da operação ligada; nome desconhecido cai no executeRead, que recusa. */
export async function executarFerramenta(nome, args, ctx) {
  const op = OPERATIONS.find((o) => o.name === nome);
  return op?.tipo === "WRITE" ? executeWrite(nome, args, ctx) : executeRead(nome, args, ctx);
}

/**
 * deps = {db, comentariosMigrados, agente (config.agente), cliente, loja?, executar?, desfazer?, relogio?}.
 * `loja`, `executar`, `desfazer` e `relogio` são as costuras do teste de unidade; sem elas, o banco.
 */
function resolver(deps) {
  if (!deps?.cliente || typeof deps.cliente.criar !== "function") throw new TypeError("motor: cliente é obrigatório");
  if (!deps.agente) throw new TypeError("motor: config do agente é obrigatória");
  if (typeof deps.comentariosMigrados !== "boolean") throw new TypeError("motor: comentariosMigrados é obrigatório");
  return {
    db: deps.db,
    comentariosMigrados: deps.comentariosMigrados,
    agente: deps.agente,
    cliente: deps.cliente,
    loja: deps.loja ?? lojaSql(deps.db),
    executar: deps.executar ?? executarFerramenta,
    desfazer: deps.desfazer ?? ((ctx, alvo) => desfazerTurno(deps.db, ctx, alvo)),
    relogio: deps.relogio ?? (() => new Date()),
  };
}

// A versão do prompt de cada canal: constante no processo (a ontologia e a flag são lidas no import).
const VERSAO_DO_CANAL = new Map();
function versaoDoCanal(canal) {
  if (!VERSAO_DO_CANAL.has(canal)) VERSAO_DO_CANAL.set(canal, sessoes.promptVersao(canal));
  return VERSAO_DO_CANAL.get(canal);
}

// ── Peças ─────────────────────────────────────────────────────────────────────

const escaparXml = (texto) => String(texto).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// ── O que o canal manda além do texto digitado (A3) ───────────────────────────
//
// No WhatsApp a mensagem do Carlos nem sempre é texto digitado: áudio (transcrito pela Les Chats),
// anexo com legenda, conteúdo compartilhado (contato, localização, resposta de botão) — e, numa
// rajada, as mensagens anteriores que ficaram sem resposta. Cada uma vai num bloco MARCADO e
// ESCAPADO. Marcado porque o que não é digitado por ele pode ser de terceiro (a legenda de uma imagem
// encaminhada, o nome de um contato), e o sufixo do canal diz ao modelo que aquilo é DADO; escapado
// porque um "</legenda_anexo><memoria>…" fecharia o bloco e forjaria contexto do sistema. O `tipo`
// vai num atributo SEM escape: por isso só entram os destas listas (o resto é TypeError).

export const TIPOS_DE_ANEXO = Object.freeze(["imagem", "documento", "video", "figurinha"]);
export const TIPOS_COMPARTILHADOS = Object.freeze(["localizacao", "contato", "interativo"]);
export const TIPOS_DE_MENSAGEM = Object.freeze(["texto", "audio", ...TIPOS_DE_ANEXO, ...TIPOS_COMPARTILHADOS]);

const ROTULO_DO_TIPO = Object.freeze({
  texto: "mensagem", audio: "áudio", imagem: "imagem", documento: "documento", video: "vídeo",
  figurinha: "figurinha", localizacao: "localização", contato: "contato", interativo: "resposta de botão",
});

/** O marcador de uma mensagem sem nada legível — fixo, nosso: não há texto do Carlos nele. */
function semConteudo(tipo) {
  if (tipo === "audio") return "[áudio que não foi transcrito]";
  if (TIPOS_DE_ANEXO.includes(tipo)) return `[${ROTULO_DO_TIPO[tipo]} sem legenda — você não vê o arquivo]`;
  return `[${ROTULO_DO_TIPO[tipo]} sem texto]`;
}

/**
 * Um item {tipo, texto} como bloco marcado. O tipo "texto" só passa por aqui dentro da rajada — e
 * escapado, porque ali ele está dentro de um bloco; a mensagem digitada da vez vai crua, como sempre.
 */
function blocoDoItem({ tipo, texto }) {
  if (!texto) return semConteudo(tipo);
  const t = escaparXml(texto);
  if (tipo === "texto") return t;
  if (tipo === "audio") return `<transcricao_audio>\n${t}\n</transcricao_audio>`;
  if (TIPOS_DE_ANEXO.includes(tipo)) return `<legenda_anexo tipo="${tipo}">\n${t}\n</legenda_anexo>`;
  return `<conteudo_compartilhado tipo="${tipo}">\n${t}\n</conteudo_compartilhado>`;
}

/** A rajada (contrato da Les Chats §6.2): as mensagens que ficaram sem resposta, em ordem. */
function blocoDaRajada(anteriores) {
  const itens = anteriores.map((a) => `<mensagem>\n${blocoDoItem(a)}\n</mensagem>`).join("\n");
  return `<mensagens_anteriores_sem_resposta>\n${itens}\n</mensagens_anteriores_sem_resposta>`;
}

/** {tipo, texto} validado, ou null. `exigeTexto`: a legenda e o compartilhado da vez só existem com texto. */
function itemDaEntrada(valor, tipos, nome, { exigeTexto }) {
  if (valor === undefined || valor === null) return null;
  if (!tipos.includes(valor?.tipo)) throw new TypeError(`motor: ${nome}.tipo fora da lista (${String(valor?.tipo)})`);
  const texto = typeof valor.texto === "string" ? valor.texto.trim() : "";
  if (!texto && exigeTexto) return null;
  return { tipo: valor.tipo, texto: texto || null };
}

const origemDoCanal = (canal) => (canal === "web" ? "agente" : "whatsapp");

const textoDe = (conteudo) => (conteudo ?? [])
  .filter((b) => b?.type === "text" && typeof b.text === "string")
  .map((b) => b.text)
  .join("\n\n")
  .trim();

const resultadoComErro = (id, texto) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: texto });

function textoEsgotado(motivo, resumos) {
  const base = motivo === "PRAZO" ? "Não deu tempo de terminar." : "Parei no limite de passos deste pedido.";
  return resumos.length
    ? `${base} O que já fiz: ${resumos.join("; ")}. Peça de novo para eu continuar.`
    : `${base} Nada foi alterado. Peça de novo, de preferência em partes menores.`;
}

// Falha e recusa pelo mesmo critério do ESGOTADO: com escrita já gravada neste turno, o texto diz o
// que foi feito. No WhatsApp o texto é tudo o que chega (não há chip de ação): "não consegui
// processar" depois de uma tarefa criada faz o Carlos repetir o pedido — e criar a tarefa duas vezes.
// "Diga o que falta", e não "peça de novo": depois de uma exceção, a rodada da escrita pode não ter
// entrado no histórico, e o pedido inteiro repetido seria refeito do zero.
const NAO_REPITA = "Não repita o pedido inteiro; diga o que falta.";

/** O texto do FALHOU: o fixo quando nada foi escrito; senão, o que já foi feito. */
export function textoFalha(resumos) {
  return resumos.length ? `Desculpe, não consegui terminar. O que já fiz: ${resumos.join("; ")}. ${NAO_REPITA}` : TEXTO_FALHA;
}

/** O texto do RECUSADO: o fixo quando nada foi escrito; senão, o que foi feito antes da recusa. */
export function textoRecusa(resumos) {
  return resumos.length
    ? `O modelo recusou continuar este pedido. O que já fiz antes disso: ${resumos.join("; ")}. ${NAO_REPITA}`
    : TEXTO_RECUSA;
}

/**
 * A mensagem do assistente como vai para o histórico. A API às vezes encerra com `content` vazio
 * (sobretudo logo depois de um tool_result); gravado assim, ele fica no MEIO do histórico no turno
 * seguinte, e a API recusa a requisição inteira (400: só a última mensagem do assistente pode ser
 * vazia) — o motor leria isso como histórico estragado, encerraria a sessão e o Carlos perderia o
 * contexto sem motivo. No lugar do vazio vai o texto que ele viu: não há bloco de pensamento a
 * preservar, e o gravado é o que vai na próxima chamada, então o prefixo segue intacto.
 */
const assistenteParaGravar = (conteudo, textoMostrado) => ({
  role: "assistant",
  content: conteudo.length ? conteudo : [{ type: "text", text: textoMostrado }],
});

function textoDesfeito(desfeitas) {
  const lista = desfeitas.map((d) => d.resumo).join("; ");
  return desfeitas.length === 1 ? `Desfeito: ${lista}.` : `Desfiz ${desfeitas.length} ações: ${lista}.`;
}

/**
 * A mensagem do usuário: o bloco de contexto primeiro (data, hora, canal, tarefa aberta e — só no
 * 1º turno da sessão — a memória e o recap), depois a rajada (quando houver), depois o que o Carlos
 * mandou agora. Transcrição, legenda e conteúdo compartilhado vão marcados e escapados (blocoDoItem):
 * o sufixo do WhatsApp diz ao modelo que aquilo é dado.
 */
async function mensagemDoUsuario(d, t, sessao) {
  const primeira = sessao.mensagens.length === 0;
  const memoriasAtivas = primeira ? await d.loja.memoriasAtivas() : [];
  const recap = primeira
    ? sessoes.recapDeterministico(await d.loja.turnosParaRecap(t.canal, { limite: 5, exceto: t.turnoId }))
    : null;
  const conteudo = [{
    type: "text",
    text: contextoDoTurno({ agora: t.chegada, canal: t.canal, memorias: memoriasAtivas, recap, tarefaAberta: t.tarefaId }),
  }];
  if (t.anteriores.length) conteudo.push({ type: "text", text: blocoDaRajada(t.anteriores) });
  if (t.transcricao) conteudo.push({ type: "text", text: blocoDoItem({ tipo: "audio", texto: t.transcricao }) });
  if (t.legenda) conteudo.push({ type: "text", text: blocoDoItem(t.legenda) });
  if (t.compartilhado) conteudo.push({ type: "text", text: blocoDoItem(t.compartilhado) });
  if (t.texto) conteudo.push({ type: "text", text: t.texto });
  return { role: "user", content: conteudo };
}

async function abrirSessao(d, t, est) {
  const s = await d.loja.obterOuRenovar({
    canal: t.canal, promptVersao: versaoDoCanal(t.canal), modelo: d.cliente.modelo, agora: d.relogio(),
    ociosaHoras: d.agente.sessaoOciosaHoras,
  });
  await d.loja.vincularSessao(t.turnoId, s.sessao.id);
  est.sessaoId = s.sessao.id;
  if (s.nova) {
    est.sessaoNova = true;
    log.info("AGENTE_SESSAO_NOVA", { canal: t.canal, motivo: s.motivo, sessao_id: s.sessao.id, turno_id: t.turnoId });
  }
  return s;
}

function somarUso(est, resp) {
  const u = resp?.usage ?? {};
  est.uso.input_tokens += Number(u.input_tokens ?? 0);
  est.uso.output_tokens += Number(u.output_tokens ?? 0);
  est.uso.cache_read_input_tokens += Number(u.cache_read_input_tokens ?? 0);
  est.uso.cache_creation_input_tokens += Number(u.cache_creation_input_tokens ?? 0);
  est.modeloServido = resp?.model ?? est.modeloServido;
  // O tamanho do prompt desta chamada (o que decide a renovação por TOKENS).
  return Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
}

const contar = (lista, chave) => lista.reduce((acc, x) => {
  const k = String(x?.[chave] ?? "desconhecido");
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

// LLM_OUT: modelo pedido e servido (o fallback troca), tokens com os de cache, motivo de parada e
// duração. Nada do conteúdo — nem do pedido, nem da resposta.
function logarChamada(t, est, corpo, resp, ms) {
  const u = resp?.usage ?? {};
  const transformacoes = Array.isArray(resp?.input_transformations) ? resp.input_transformations : [];
  log.info("LLM_OUT", {
    canal: t.canal,
    turno_id: t.turnoId,
    chamada: est.chamadas,
    modelo_pedido: corpo.model,
    modelo_servido: resp?.model,
    fallback: (u.iterations ?? []).some((i) => i?.type === "fallback_message"),
    stop_reason: resp?.stop_reason,
    input_tokens: Number(u.input_tokens ?? 0),
    output_tokens: Number(u.output_tokens ?? 0),
    cache_read_input_tokens: Number(u.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: Number(u.cache_creation_input_tokens ?? 0),
    n_transformacoes: transformacoes.length,
    n_tool_use: (resp?.content ?? []).filter((b) => b?.type === "tool_use").length,
    duration_ms: ms,
  });
  // A lista vazia é o estado normal (histórico intacto). Uma entrada é raciocínio perdido: o
  // histórico mudou (prefix_binding_mismatch — defeito nosso) ou a conversa trocou de modelo
  // (model_binding_mismatch — o fallback, esperado). Sem o `path`: é posição, mas não ajuda sem o corpo.
  if (transformacoes.length) {
    log.warn("LLM_THINKING_DESCARTADO", {
      canal: t.canal, turno_id: t.turnoId, chamada: est.chamadas, n: transformacoes.length,
      tipos: contar(transformacoes, "type"), motivos: contar(transformacoes, "reason"),
    });
  }
}

async function rodarFerramenta(d, t, est, uso) {
  const ctx = {
    db: d.db, origem: origemDoCanal(t.canal), turnoId: t.turnoId, canal: t.canal, agora: d.relogio(),
    comentariosMigrados: d.comentariosMigrados,
  };
  let saida;
  try {
    saida = await d.executar(uso.name, uso.input ?? {}, ctx);
  } catch (err) {
    // executeRead/executeWrite não lançam (viram ERRO_INTERNO); isto é o cinto de um executor injetado.
    log.erro("AGENTE_TOOL_ERRO", { codigo: "ERRO_INTERNO", erro: err?.name ?? typeof err, turno_id: t.turnoId });
    saida = { erro: mensagemDaRecusa("ERRO_INTERNO"), codigo: "ERRO_INTERNO" };
  }
  est.nTools++;
  // A escrita entra na conta ANTES de qualquer outra ida ao banco: se o progresso falhar logo
  // depois, o texto de falha (textoFalha) ainda sabe que ela aconteceu.
  if (!saida?.erro && saida?.acao) est.resumos.push(saida.acao.resumo);
  await d.loja.registrarProgresso(t.turnoId, est.nTools);
  if (saida?.erro) {
    return { type: "tool_result", tool_use_id: uso.id, is_error: true, content: serializarResultado(saida) };
  }
  return { type: "tool_result", tool_use_id: uso.id, content: serializarResultado(saida?.resultado ?? null) };
}

// ── O laço ────────────────────────────────────────────────────────────────────

async function laco(d, t, est) {
  let s = await abrirSessao(d, t, est);
  let historico = s.mensagens;
  let pendentes = [await mensagemDoUsuario(d, t, s)];
  let retentou = false;
  const effort = d.agente.effort[t.canal];

  const persistir = async (mensagens, inputTokens = null) => {
    await d.loja.acrescentarMensagens(s.sessao.id, t.turnoId, mensagens, { inputTokens });
    historico = [...historico, ...mensagens];
    est.persistidas += mensagens.length;
  };

  // Fim sem a palavra final do modelo: se a conversa já recebeu algo deste turno e termina num
  // `user` (os tool_result), o texto mostrado entra como resposta do assistente — por acréscimo.
  // Se nada deste turno foi gravado (falhou na 1ª chamada), nada entra: o pedido não fica pendurado.
  const terminar = async (fim) => {
    if (pendentes.length === 0 && historico.at(-1)?.role === "user") {
      await persistir([{ role: "assistant", content: [{ type: "text", text: fim.texto }] }]);
    }
    return fim;
  };
  const esgotar = (motivo) => terminar({ status: TURNO_ESGOTADO, motivo, texto: textoEsgotado(motivo, est.resumos) });
  const falhar = (motivo) => terminar({ status: TURNO_FALHOU, motivo, texto: textoFalha(est.resumos) });

  for (;;) {
    if (est.chamadas >= d.agente.maxChamadas) return esgotar("LIMITE_CHAMADAS");
    const restante = t.prazoFinal - d.relogio().getTime();
    if (restante < PRAZO_MINIMO_MS) return esgotar("PRAZO");

    const corpo = montarRequisicao({ canal: t.canal, modelo: d.cliente.modelo, effort, messages: [...historico, ...pendentes] });
    est.chamadas++;
    const inicio = process.hrtime.bigint();
    let resp;
    try {
      resp = await d.cliente.criar(corpo, { timeoutMs: restante });
    } catch (err) {
      const erro = classificarErro(err);
      const ms = Math.round(Number(process.hrtime.bigint() - inicio) / 1e6);
      (erro.tipo === "PRAZO" ? log.warn : log.erro)("LLM_ERRO", {
        canal: t.canal, turno_id: t.turnoId, chamada: est.chamadas, modelo_pedido: corpo.model,
        ...erro, erro: err?.name ?? typeof err, historico: historico.length, duration_ms: ms,
      });
      if (erro.tipo === "PRAZO") return esgotar("PRAZO");
      if (erro.tipo === "REQUISICAO_400" && historico.length > 0) {
        // O histórico da sessão é o suspeito: a sessão acaba, e o próximo turno começa outra. Uma
        // retentativa NESTE turno só quando nada dele aconteceu ainda — com ferramenta já rodada,
        // refazer do zero repetiria escrita.
        await d.loja.encerrarSessao(s.sessao.id, "ERRO_HISTORICO");
        if (!retentou && est.nTools === 0 && est.persistidas === 0) {
          retentou = true;
          s = await abrirSessao(d, t, est);
          historico = s.mensagens;
          pendentes = [await mensagemDoUsuario(d, t, s)];
          continue;
        }
        return falhar("ERRO_HISTORICO");
      }
      return falhar("ERRO_LLM");
    }

    const ms = Math.round(Number(process.hrtime.bigint() - inicio) / 1e6);
    const inputTokens = somarUso(est, resp);
    logarChamada(t, est, corpo, resp, ms);
    const conteudo = Array.isArray(resp?.content) ? resp.content : [];
    const assistente = { role: "assistant", content: conteudo };
    const usos = conteudo.filter((b) => b?.type === "tool_use");

    switch (resp?.stop_reason) {
      case "refusal": {
        // Os classificadores recusaram — e o fallback "default" também (ou não havia fallback para
        // a categoria). O conteúdo parcial é descartado; seguir na mesma conversa repetiria a recusa.
        // Encerra-se SEMPRE, mesmo quando nada deste turno entrou no histórico: os classificadores
        // avaliam a requisição inteira, e o gatilho pode estar no histórico — mantida a sessão, cada
        // turno seguinte seria recusado de novo, sem saída. A sessão nova leva o recap, que conta a
        // recusa SEM o texto do pedido (sessoes.recapDeterministico).
        const categoria = resp.stop_details?.category ?? null;
        log.warn("LLM_RECUSA", { canal: t.canal, turno_id: t.turnoId, chamada: est.chamadas, categoria, modelo_servido: resp.model });
        est.categoriaRecusa = categoria;
        await d.loja.encerrarSessao(s.sessao.id, "RECUSA");
        return { status: TURNO_RECUSADO, motivo: "RECUSA", texto: textoRecusa(est.resumos) };
      }

      case "tool_use": {
        if (usos.length === 0) break; // sem pedido de ferramenta não há o que rodar: vale como fim
        const resultados = [];
        let semTempo = false;
        for (const uso of usos) {
          // Toda chamada pedida recebe um tool_result, inclusive as que não rodam: um tool_use sem
          // resposta é um histórico que a API recusa daqui em diante.
          if (semTempo || d.relogio().getTime() >= t.prazoFinal) {
            semTempo = true;
            resultados.push(resultadoComErro(uso.id, NAO_EXECUTADA_PRAZO));
            continue;
          }
          resultados.push(await rodarFerramenta(d, t, est, uso));
        }
        await persistir([...pendentes, assistente, { role: "user", content: resultados }], inputTokens);
        pendentes = [];
        if (semTempo) return esgotar("PRAZO");
        continue;
      }

      case "max_tokens": {
        if (usos.length) {
          // O tool_use cortado no meio costuma parecer um objeto válido — e não é o que o modelo
          // queria. Nada roda; cada pedido recebe o seu erro, e o turno falha.
          await persistir([...pendentes, assistente, {
            role: "user", content: usos.map((u) => resultadoComErro(u.id, NAO_EXECUTADA_CORTE)),
          }], inputTokens);
          pendentes = [];
          return falhar("MAX_TOKENS");
        }
        const cortado = textoDe(conteudo);
        const fim = cortado
          ? { status: TURNO_CONCLUIDO, motivo: "MAX_TOKENS", texto: `${cortado}…` }
          : { status: TURNO_FALHOU, motivo: "MAX_TOKENS", texto: textoFalha(est.resumos) };
        await persistir([...pendentes, assistenteParaGravar(conteudo, fim.texto)], inputTokens);
        pendentes = [];
        return fim;
      }

      case "pause_turn": {
        // A API pausou o turno longo: devolve-se o assistente como veio e chama-se de novo.
        await persistir([...pendentes, assistente], inputTokens);
        pendentes = [];
        continue;
      }

      default:
        break;
    }

    // end_turn (e qualquer parada sem ferramenta a rodar): a palavra final.
    const palavraFinal = textoDe(conteudo) || "Pronto.";
    await persistir([...pendentes, assistenteParaGravar(conteudo, palavraFinal)], inputTokens);
    pendentes = [];
    return { status: TURNO_CONCLUIDO, motivo: null, texto: palavraFinal };
  }
}

// ── O comando "desfazer" ──────────────────────────────────────────────────────

async function comandoDesfazer(d, t, est) {
  const s = await abrirSessao(d, t, est);
  const alvo = await d.loja.ultimoTurnoDesfazivel(t.canal, DESFAZER_JANELA_MIN, { exceto: t.turnoId });
  let fim;
  if (!alvo) {
    fim = { status: TURNO_CONCLUIDO, motivo: "NADA_A_DESFAZER", texto: TEXTO_NADA_A_DESFAZER, desfazer: null };
  } else {
    const r = await d.desfazer(
      { origem: origemDoCanal(t.canal), comentariosMigrados: d.comentariosMigrados, agora: d.relogio() },
      { turnoId: alvo }
    );
    fim = r.ok
      ? { status: TURNO_CONCLUIDO, motivo: null, texto: textoDesfeito(r.valor.desfeitas), desfazer: { turno_id: alvo, desfeitas: r.valor.desfeitas } }
      : { status: TURNO_CONCLUIDO, motivo: r.motivo, texto: mensagemDaRecusa(r.motivo), desfazer: { turno_id: alvo, desfeitas: [], codigo: r.motivo } };
  }
  const usuario = await mensagemDoUsuario(d, t, s);
  await d.loja.acrescentarMensagens(s.sessao.id, t.turnoId, [usuario, { role: "assistant", content: [{ type: "text", text: fim.texto }] }]);
  est.persistidas += 2;
  return fim;
}

// ── O turno inteiro ───────────────────────────────────────────────────────────

const NIVEL_DO_STATUS = { [TURNO_CONCLUIDO]: "info", [TURNO_ESGOTADO]: "warn", [TURNO_RECUSADO]: "warn", [TURNO_FALHOU]: "erro" };
const PG_CODIGO = /^[0-9A-Z]{5}$/;

async function executarTurno(d, t) {
  const inicio = process.hrtime.bigint();
  const est = {
    chamadas: 0, nTools: 0, persistidas: 0, resumos: [], sessaoId: null, sessaoNova: false, modeloServido: null, categoriaRecusa: null,
    uso: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  // O comando é a mensagem SOZINHA. Com a rajada, não: "cria a tarefa X" + "desfazer" quer dizer
  // "deixa para lá" — interceptar desfaria o turno ANTERIOR e perderia o X; o modelo lê as duas.
  const comando = Boolean(t.texto) && !t.transcricao && !t.legenda && !t.compartilhado && t.anteriores.length === 0 &&
    ehComandoDesfazer(t.texto);
  let fim;
  let falha = null;
  try {
    fim = comando ? await comandoDesfazer(d, t, est) : await laco(d, t, est);
  } catch (err) {
    falha = err;
    fim = { status: TURNO_FALHOU, motivo: "ERRO_INTERNO", texto: textoFalha(est.resumos) };
    // Quebrou depois de uma escrita: a rodada dela pode não ter entrado no histórico (a gravação vem
    // DEPOIS das ferramentas), e na mesma sessão o modelo nunca saberia que a tarefa existe. Sessão
    // nova leva o recap, que lista o "feito" deste turno (as ações estão no turno, gravadas no tx da
    // escrita). Se o banco é que caiu, isto falha também — e o log diz.
    if (est.resumos.length && est.sessaoId) {
      await d.loja.encerrarSessao(est.sessaoId, "ERRO_INTERNO").catch((e) => {
        log.erro("AGENTE_SESSAO_NAO_ENCERRADA", {
          turno_id: t.turnoId, motivo: "ERRO_INTERNO", erro: e?.name, pg_codigo: PG_CODIGO.test(e?.code ?? "") ? e.code : undefined,
        });
      });
    }
  }
  const duration_ms = Math.round(Number(process.hrtime.bigint() - inicio) / 1e6);
  const metricas = {
    chamadas: est.chamadas, n_tools: est.nTools, duration_ms, ...est.uso,
    modelo_servido: est.modeloServido, sessao_nova: est.sessaoNova,
    ...(est.categoriaRecusa ? { categoria_recusa: est.categoriaRecusa } : {}),
  };

  // AGENTE_TURNO: uma linha por turno, com o nível do desfecho. Sem texto — nem o pedido, nem a resposta.
  log[NIVEL_DO_STATUS[fim.status] ?? "erro"]("AGENTE_TURNO", {
    turno_id: t.turnoId, canal: t.canal, status: fim.status, motivo: fim.motivo ?? undefined,
    comando: comando ? "DESFAZER" : undefined, anteriores: t.anteriores.length || undefined,
    chamadas: est.chamadas, n_tools: est.nTools,
    n_acoes: est.resumos.length, sessao_nova: est.sessaoNova, duration_ms,
    ...(falha ? {
      erro: falha?.name ?? typeof falha,
      pg_codigo: PG_CODIGO.test(falha?.code ?? "") ? falha.code : undefined,
      pilha: typeof falha?.stack === "string" ? falha.stack.split("\n").slice(1, 7).map((l) => l.trim()) : undefined,
    } : {}),
  });

  try {
    await d.loja.concluirTurno(t.turnoId, { status: fim.status, motivo: fim.motivo ?? null, resposta: fim.texto, metricas });
  } catch (err) {
    // O banco caiu no fim: a varredura de órfãos (no boot e a cada minuto) fecha este turno como
    // FALHOU/REINICIO depois de ORFAO_APOS_MIN.
    log.erro("AGENTE_TURNO_NAO_FECHADO", { turno_id: t.turnoId, erro: err?.name, pg_codigo: PG_CODIGO.test(err?.code ?? "") ? err.code : undefined });
  }

  let publico = null;
  try { publico = await d.loja.obterTurnoPublico(t.turnoId); } catch { /* cai no montado abaixo */ }
  publico ??= {
    turno_id: t.turnoId, status: fim.status, motivo: fim.motivo ?? null, texto: fim.texto, entrada: t.registro,
    acoes: [], progresso: { n_tools: est.nTools },
  };
  return comando ? { ...publico, desfazer: fim.desfazer ?? null } : publico;
}

// ── A API do motor ────────────────────────────────────────────────────────────

/**
 * Abre o turno (EM_ANDAMENTO, já com o id que a tela vai consultar) e põe o laço na fila do canal.
 * Devolve {turnoId, resultado}: `resultado` é a Promise do turno no formato da tela, que nunca
 * rejeita por falha do turno (ela vira status FALHOU).
 *
 * entrada = {texto?, transcricao?, legenda?, compartilhado?, anteriores?} — ao menos um:
 *   texto          o que o Carlos digitou (vai cru);
 *   transcricao    o áudio, transcrito pela Les Chats → <transcricao_audio>;
 *   legenda        {tipo: TIPOS_DE_ANEXO, texto} — a legenda de um anexo → <legenda_anexo>;
 *   compartilhado  {tipo: TIPOS_COMPARTILHADOS, texto} → <conteudo_compartilhado>;
 *   anteriores     [{tipo: TIPOS_DE_MENSAGEM, texto|null}] — a rajada, em ordem → <mensagens_anteriores_sem_resposta>.
 * contexto = {tarefaId?}; prazoMs, se omitido, é o orçamento do canal na config, contado a partir de
 * agora (a chegada).
 *
 * A `entrada` gravada no turno (a que a tela mostra e o recap cita) é o texto puro, sem marcação: a
 * rajada e a mensagem da vez, uma por linha.
 */
export async function iniciarTurno(deps, { canal, entrada, contexto = null, prazoMs } = {}) {
  const d = resolver(deps);
  if (!CANAIS_DO_MOTOR.includes(canal)) throw new TypeError(`motor: canal fora de CANAIS_DO_MOTOR (${String(canal)})`);
  const texto = typeof entrada?.texto === "string" ? entrada.texto.trim() : "";
  const transcricao = typeof entrada?.transcricao === "string" ? entrada.transcricao.trim() : "";
  const legenda = itemDaEntrada(entrada?.legenda, TIPOS_DE_ANEXO, "legenda", { exigeTexto: true });
  const compartilhado = itemDaEntrada(entrada?.compartilhado, TIPOS_COMPARTILHADOS, "compartilhado", { exigeTexto: true });
  const anteriores = (Array.isArray(entrada?.anteriores) ? entrada.anteriores : [])
    .map((a, i) => itemDaEntrada(a, TIPOS_DE_MENSAGEM, `anteriores[${i}]`, { exigeTexto: false }))
    .filter(Boolean);
  if (!texto && !transcricao && !legenda && !compartilhado && anteriores.length === 0) {
    throw new TypeError("motor: a entrada precisa de texto, transcrição, legenda, conteúdo compartilhado ou mensagens anteriores");
  }
  const daVez = texto || transcricao || legenda?.texto || compartilhado?.texto || "";
  const registro = [...anteriores.map((a) => a.texto ?? semConteudo(a.tipo)), daVez].filter(Boolean).join("\n");
  const chegada = d.relogio();
  const t = {
    turnoId: uuidv4(), canal, texto: texto || null, transcricao: transcricao || null, legenda, compartilhado, anteriores,
    registro, tarefaId: contexto?.tarefaId ?? null, chegada,
    prazoFinal: chegada.getTime() + (prazoMs ?? d.agente.orcamentoMs[canal]),
  };
  await d.loja.abrirTurno({ id: t.turnoId, canal, entrada: registro });
  const resultado = naFila(canal, () => executarTurno(d, t));
  return { turnoId: t.turnoId, resultado };
}

/** Abre o turno e espera o fim — o "desfazer" da tela, o WhatsApp (A3) e os testes. */
export async function rodarTurno(deps, args) {
  const { resultado } = await iniciarTurno(deps, args);
  return resultado;
}

/**
 * O "nova conversa": encerra a sessão ativa do canal, na fila — não corta um turno em andamento, que
 * terminaria escrevendo numa sessão já fechada. Não precisa do modelo: só da persistência.
 */
export async function novaConversa(loja, canal) {
  if (!CANAIS_DO_MOTOR.includes(canal)) throw new TypeError(`motor: canal fora de CANAIS_DO_MOTOR (${String(canal)})`);
  const encerrada = await naFila(canal, () => loja.encerrarAtiva(canal, "PEDIDO"));
  return { encerrada };
}
