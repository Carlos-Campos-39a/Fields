// O chat da Home (R3) como máquina de estados PURA: o reducer, os seletores e o fio montado para a
// tela. Sem React, sem fetch, sem relógio — o `agora` chega em cada ação. Quem fala com a API é
// home/useChat.js; quem desenha é home/Fio.jsx. Testado em chat.test.js.
//
// O contrato é o da §9.2 do plano (backend/src/rotas/agente.js):
//   POST /api/agente/chat        → 202 {turno_id} | 200 <turno> ("desfazer", síncrono) | 503 AGENTE_DESLIGADO
//   GET  /api/agente/turnos/:id  → <turno>
//   GET  /api/agente/conversa    → {turnos: [<turno>…]}, do mais antigo ao mais novo
//   <turno> = {turno_id, status, motivo, texto, acoes:[{idx, acao, resumo, desfazivel, desfeito_em}],
//              progresso:{n_tools}} + entrada, sessao_id, criado_em
//
// ── Ciclo de vida de UM turno na tela ─────────────────────────────────────────────────────────
//
//   (Enter) ─► ENVIANDO ──202──► EM_ANDAMENTO ──consulta a cada 1 s──► CONCLUIDO | ESGOTADO
//                 │  │                │   ▲                               FALHOU | RECUSADO
//                 │  │                │   └─ Verificar de novo ─┐
//                 │  │                ├─ 5 falhas seguidas ─────┤ (consulta parada: SEM_CONEXAO)
//                 │  │                ├─ mais de 6 min ─────────┘ (consulta parada: DEMORA)
//                 │  │                └─ 404 na consulta ─► PERDIDO
//                 │  ├──200──► o turno pronto (o comando "desfazer"), já terminal
//                 │  ├──503 AGENTE_DESLIGADO──► DESLIGADO   (Salvar como nota · Tentar de novo)
//                 │  ├──4xx (recusa clara)────► NAO_ENVIADO (Salvar como nota · Tentar de novo)
//                 │  └──rede, 5xx, 2xx torto──► VERIFICANDO ──GET /conversa──► o turno do servidor
//                 │                                  │                         (adotado na bolha)
//                 │                                  └─ não está lá ─► NAO_ENVIADO incerto, conferido
//                 └◄── Tentar de novo (DESLIGADO/NAO_ENVIADO: a MESMA bolha, que nunca chegou lá)
//
//   A falha INCERTA é a que não diz se o servidor recebeu: o TypeError do fetch também acontece
//   quando o corpo chegou e só a resposta se perdeu, um 5xx pode ser do proxy com o backend
//   rodando atrás, e um 2xx fora da forma foi aceito com certeza. O backend grava o turno e o põe
//   na fila ANTES de responder, então reenviar às cegas faria duas vezes o que foi pedido (e o
//   "Salvar como nota" gravaria a nota E o que o agente fez). A tela confere primeiro; só oferece
//   os botões se o turno não apareceu — e nunca o reenvio do comando "desfazer", que desfaria
//   também o turno ANTERIOR.
//
//   ESGOTADO, FALHOU sem ação e PERDIDO sem ação: "Tentar de novo" manda o mesmo texto como um
//   turno NOVO no fim do fio — o velho fica, é história — e some do velho (`retentado`). Só no
//   turno mais recente: o de dias atrás, repetido com o contexto de agora, faria outra coisa.
//   FALHOU com ação gravada NÃO oferece: o backend pede "diga o que falta" (motor.js NAO_REPITA),
//   porque o pedido inteiro repetido refaria a escrita que já aconteceu.
//
// Os status ENVIANDO, VERIFICANDO, DESLIGADO, NAO_ENVIADO e PERDIDO são só da tela; o servidor nunca
// os manda.

import { toISODateLocal } from "../lib/dates.js";

export const INTERVALO_CONSULTA_MS = 1000;
/** Falhas SEGUIDAS de consulta antes de parar e oferecer "Verificar de novo" (a rede caiu). */
export const FALHAS_ATE_PARAR = 5;
// O backend fecha como FALHOU/REINICIO todo EM_ANDAMENTO com mais de 5 min (turnos.js ORFAO_APOS_MIN);
// 6 min aqui é essa garantia mais folga. Passou disso sem resposta, consultar a cada segundo não
// muda nada: a tela para e diz que está demorando.
export const LIMITE_CONSULTA_MS = 6 * 60_000;
/** O teto do texto no backend (rotas/agente.js TEXTO_CHAT_MAX): o composer recusa antes. */
export const TEXTO_MAX = 10_000;
export const LIMITE_CONVERSA = 30;
// A janela do desfazer é config do SERVIDOR (DESFAZER_JANELA_MIN, padrão 60) e não vem na API; a
// tela usa o padrão só para não pendurar "Desfazer" em chip de ontem, que recusaria todo clique.
// Se o servidor tiver janela menor, o clique explica (DESFAZER_EXPIRADO); se maior, depois dos 60
// min o caminho de volta é o comando "desfazer" ou a Lixeira.
export const JANELA_DESFAZER_MIN = 60;

export const EM_ANDAMENTO = "EM_ANDAMENTO";
export const TERMINAIS = Object.freeze(["CONCLUIDO", "ESGOTADO", "FALHOU", "RECUSADO"]);
export const STATUS_DO_SERVIDOR = Object.freeze([EM_ANDAMENTO, ...TERMINAIS]);
export const ENVIANDO = "ENVIANDO";
export const VERIFICANDO = "VERIFICANDO";
export const DESLIGADO = "DESLIGADO";
export const NAO_ENVIADO = "NAO_ENVIADO";
export const PERDIDO = "PERDIDO";

/** Quantos turnos o GET da conferência de um envio incerto pede: o procurado é dos últimos. */
export const LIMITE_VERIFICACAO = 10;
// O turno procurado nasceu no servidor DEPOIS do envio; a folga cobre o relógio do navegador um
// pouco adiantado em relação ao do servidor (criado_em ≥ enviado_em − folga).
export const FOLGA_RELOGIO_MS = 5_000;

// 503 AGENTE_DESLIGADO é o servidor sem o assistente. O 404 do POST é o mesmo para a tela: um
// backend anterior à A2b não tem a rota, e o que o Carlos escreveu tem de ter para onde ir.
const CODIGOS_DESLIGADO = Object.freeze(["AGENTE_DESLIGADO", "NAO_ENCONTRADO"]);
// Falhas que não dizem se o pedido chegou (o desenho no topo do arquivo diz por quê). Todo 5xx que
// não seja o AGENTE_DESLIGADO entra também: o 500 do backend vem como ERRO_INTERNO, o do proxy como
// ERRO_SERVIDOR, e nenhum dos dois prova que o turno não foi aberto.
const CODIGOS_INCERTOS = Object.freeze(["SEM_CONEXAO", "ERRO_SERVIDOR", "ERRO_DESCONHECIDO", "RESPOSTA_INESPERADA"]);
// Recusas do desfazer que não mudam com outra tentativa: o botão sai do chip.
const DESFAZER_SEM_VOLTA = Object.freeze(["DESFAZER_EXPIRADO", "SEM_INVERSO", "NAO_ENCONTRADO", "NADA_A_DESFAZER"]);

export const ESTADO_INICIAL = Object.freeze({
  carga: "CARREGANDO", // CARREGANDO | PRONTA | FALHOU — o GET da conversa
  turnos: [], // o fio, do mais antigo ao mais novo
  desligado: false, // o servidor disse AGENTE_DESLIGADO: o composer vira a caixa de nota
  corte: null, // turno_id depois do qual o Carlos pediu "Nova conversa" (o divisor, até o próximo turno)
  corteAlvo: null, // o último turno_id NO CLIQUE de "Nova conversa": vira o `corte` quando o servidor confirma
  novaConversa: "OCIOSA", // OCIOSA | PEDINDO
  mudancas: 0, // sobe quando o agente (ou um desfazer) mexeu nos dados: o card "Hoje" e a lista do App releem
  capturas: 0, // sobe quando a Home gravou uma nota sem o assistente: só o card "Hoje" relê (o App já sabe)
  releituras: 0, // sobe quando o fio precisa do GET da conversa inteira (um desfazer que a tela não viu responder)
  locaisRestaurados: false, // as bolhas guardadas na aba já voltaram ao fio: daí em diante a tela as grava
});

// ─── Normalização do que vem do servidor ─────────────────────────────

function normalizarAcao(a) {
  if (!a || typeof a !== "object" || !Number.isInteger(a.idx)) return null;
  return {
    idx: a.idx,
    acao: typeof a.acao === "string" ? a.acao : "",
    resumo: typeof a.resumo === "string" && a.resumo.trim() ? a.resumo : "Ação registrada",
    desfazivel: Boolean(a.desfazivel),
    desfeito_em: a.desfeito_em ?? null,
  };
}

/**
 * <turno> do servidor → o turno da tela (sem os campos locais), ou null quando não serve (sem
 * turno_id): quem chama loga e segue — um item ilegível não derruba o fio inteiro.
 * Status fora do contrato fica como veio: vale como terminal (ehTerminal), para a tela nunca
 * consultar para sempre um valor que ela não conhece.
 */
export function normalizarTurno(t) {
  if (!t || typeof t !== "object" || typeof t.turno_id !== "string" || !t.turno_id) return null;
  return {
    turno_id: t.turno_id,
    status: typeof t.status === "string" && t.status ? t.status : "DESCONHECIDO",
    motivo: typeof t.motivo === "string" ? t.motivo : null,
    texto: typeof t.texto === "string" ? t.texto : null,
    entrada: typeof t.entrada === "string" ? t.entrada : null,
    acoes: (Array.isArray(t.acoes) ? t.acoes : []).map(normalizarAcao).filter(Boolean),
    n_tools: Number.isFinite(Number(t.progresso?.n_tools)) ? Number(t.progresso.n_tools) : 0,
    sessao_id: typeof t.sessao_id === "string" ? t.sessao_id : null,
    criado_em: typeof t.criado_em === "string" ? t.criado_em : null,
  };
}

/**
 * Corpo do POST /chat → {tipo: "ACEITO", turnoId} (202) | {tipo: "RESPONDIDO", turno, desfazer}
 * (200, o comando "desfazer") | {tipo: "INESPERADA"}. Pela forma, não pelo status: o req() da
 * api.js devolve só o corpo, e as duas formas não se confundem (o 200 traz `status`).
 */
export function respostaDoEnvio(corpo) {
  if (corpo && typeof corpo === "object" && typeof corpo.status === "string") {
    const turno = normalizarTurno(corpo);
    if (turno) return { tipo: "RESPONDIDO", turno, desfazer: corpo.desfazer ?? null };
  }
  if (corpo && typeof corpo === "object" && typeof corpo.turno_id === "string" && corpo.turno_id) {
    return { tipo: "ACEITO", turnoId: corpo.turno_id };
  }
  return { tipo: "INESPERADA" };
}

/**
 * A falha do POST /chat deixa dúvida se o turno foi aberto? true para rede, 5xx (menos o
 * AGENTE_DESLIGADO), erro desconhecido e 2xx fora da forma; false para as recusas claras (4xx).
 */
export function falhaIncerta(codigo, status = 0) {
  if (CODIGOS_DESLIGADO.includes(codigo)) return false;
  return CODIGOS_INCERTOS.includes(codigo) || (Number.isFinite(status) && status >= 500);
}

// A mesma regra do backend (agente/motor.js ehComandoDesfazer): a palavra sozinha, sem acento e sem
// pontuação no fim. "desfaz a tarefa X" é pedido para o modelo, não o comando.
const COMANDO_DESFAZER = /^(desfazer|desfaz|desfaca)$/;

/** O texto é o comando "desfazer" (que o servidor executa sem o modelo, sobre o último turno)? */
export function ehComandoDesfazer(texto) {
  const limpo = String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s.!?…]+$/u, "");
  return COMANDO_DESFAZER.test(limpo);
}

// ─── Seletores ───────────────────────────────────────────────────────

export const ehTerminal = (status) =>
  status !== EM_ANDAMENTO && status !== ENVIANDO && status !== VERIFICANDO && !ehFalhaLocal(status);
export function ehFalhaLocal(status) {
  return status === DESLIGADO || status === NAO_ENVIADO;
}

const consultavel = (t) => t.status === EM_ANDAMENTO && Boolean(t.turno_id) && !t.consulta?.parada;

/** Os turno_id que a tela deve consultar agora. */
export function aConsultar(estado) {
  return estado.turnos.filter(consultavel).map((t) => t.turno_id);
}

/**
 * Há um turno saindo, sendo conferido ou rodando? Enquanto houver, o composer espera (o backend tem
 * UM turno por canal, e um envio incerto pode estar rodando lá).
 */
export function ocupado(estado) {
  return estado.turnos.some((t) => t.status === ENVIANDO || t.status === VERIFICANDO || consultavel(t));
}

const ultimoComId = (turnos) => [...turnos].reverse().find((t) => t.turno_id) ?? null;

/** O que o "Tentar de novo" de `t` precisa saber do fio: se ele é o turno mais recente, e o corte. */
export function opcoesDeRetentar(estado, t) {
  return { ultimo: Boolean(t) && ultimoComId(estado.turnos)?.chave === t.chave, corte: estado.corte };
}

// Falha incerta só libera os botões depois de conferida (o turno não apareceu no servidor), e
// nunca para o 2xx torto (o servidor aceitou) nem para o comando "desfazer".
function incertoLiberado(t) {
  return Boolean(t.conferido) && t.codigo !== "RESPOSTA_INESPERADA" && !ehComandoDesfazer(t.entrada);
}

/**
 * "Tentar de novo" vale para este turno? (o desenho no topo do arquivo diz por quê)
 * `ultimo`: é o turno com turno_id mais recente do fio; `corte`: o turno_id do "Nova conversa".
 * Sem as opções, só a bolha que nunca chegou ao servidor oferece.
 */
export function podeTentarDeNovo(t, { ultimo = false, corte = null } = {}) {
  // Já virou nota: mandar de novo ao assistente registraria a mesma coisa duas vezes.
  if (!t || t.retentado || t.nota || !t.entrada?.trim()) return false;
  if (ehFalhaLocal(t.status)) return !t.incerto || incertoLiberado(t);
  if (!ultimo) return false;
  // ESGOTADO com ações conta com o histórico da sessão ("peça de novo para eu continuar"): depois
  // do "Nova conversa", o pedido inteiro repetido refaria as escritas.
  if (t.status === "ESGOTADO") return t.acoes.length === 0 || corte !== t.turno_id;
  if (t.status === "FALHOU" || t.status === PERDIDO) return t.acoes.length === 0;
  return false;
}

/** "Salvar como nota" — só para o que o servidor não chegou a tratar (e, se incerto, conferido). */
export function podeSalvarComoNota(t) {
  return Boolean(t && ehFalhaLocal(t.status) && !t.nota && t.entrada?.trim() && (!t.incerto || incertoLiberado(t)));
}

/** "Verificar de novo" na bolha incerta que ainda não pode oferecer reenviar nem salvar. */
export function podeVerificarDeNovo(t) {
  return Boolean(t && t.status === NAO_ENVIADO && t.incerto && !t.nota && !incertoLiberado(t));
}

/**
 * O chip mostra "Desfazer"? Só com o turno terminado (no meio dele, o agente ainda pode mexer) e
 * dentro da janela, contada do criado_em do turno como no servidor (desfazer.js selecionarAcoes).
 * Sem `agora`, a janela não é olhada.
 */
export function podeDesfazer(t, a, agora) {
  if (!TERMINAIS.includes(t.status) || !a.desfazivel || a.desfeito_em || a.semVolta) return false;
  if (agora === undefined || !t.criado_em) return true;
  const criado = new Date(t.criado_em).getTime();
  return Number.isNaN(criado) || agora - criado <= JANELA_DESFAZER_MIN * 60_000;
}

/** O aviso curto sob a resposta (ou no lugar dela), por status. null = nada a dizer. */
export function avisoDoTurno(t) {
  switch (t.status) {
    case DESLIGADO:
      return "O assistente está desligado neste servidor.";
    case NAO_ENVIADO:
      if (t.incerto) {
        if (!t.conferido) return "Não sei se a mensagem chegou, e não deu para conferir agora.";
        if (t.codigo === "RESPOSTA_INESPERADA") return "O servidor respondeu fora do esperado, e o pedido não apareceu na conversa.";
        if (ehComandoDesfazer(t.entrada)) return "Não sei se o desfazer chegou. Confira os chips acima antes de pedir de novo.";
        return "A mensagem não chegou ao assistente.";
      }
      if (t.codigo === "MUITAS_TENTATIVAS") return "Muitas mensagens seguidas. Espere um pouco e tente de novo.";
      return "O servidor não aceitou a mensagem.";
    case PERDIDO:
      return "O servidor não encontrou este pedido.";
    case "FALHOU":
      if (t.motivo === "REINICIO") return "O servidor reiniciou no meio do pedido.";
      return t.texto ? null : "Não consegui processar agora.";
    case "RECUSADO":
      return "A conversa recomeça do zero na próxima mensagem.";
    default:
      return null;
  }
}

/** A mensagem do toast quando o desfazer de um chip é recusado (códigos de agente/desfazer.js). */
export function mensagemDoDesfazer(codigo) {
  switch (codigo) {
    case "DESFAZER_EXPIRADO":
      return "Passou o prazo para desfazer. Peça ao assistente para restaurar pela Lixeira.";
    case "ALTERADO_DEPOIS":
      return "Isto mudou depois. Desfazer agora apagaria a mudança mais nova.";
    case "SEM_INVERSO":
      return "Esta ação não tem como ser desfeita.";
    case "DESFAZER_JA_FEITO":
      return "Isto já tinha sido desfeito.";
    case "NAO_ENCONTRADO":
    case "NADA_A_DESFAZER":
      return "Não há mais o que desfazer aqui.";
    case "PAI_EXCLUIDO":
      return "O item de cima está excluído. Restaure-o antes.";
    case "SEM_CONEXAO":
      return "Sem conexão: não deu para desfazer.";
    default:
      return "Não deu para desfazer.";
  }
}

/**
 * O ícone do chip pelo código da ação (agente/ontologia.js `acao`: NOVA_TAREFA, EDITAR_ENTRADA…).
 * Código novo cai no "check": o chip continua legível pelo resumo, que é o que diz o que houve.
 */
export function iconeDaAcao(acao) {
  const a = String(acao ?? "");
  if (a === "NOVO_COMENTARIO") return "message";
  if (a === "CONCLUIR_TAREFA") return "check";
  if (a === "LEMBRAR" || a === "ESQUECER") return "pin";
  if (/^NOV[AO]_/.test(a)) return "plus";
  if (a.startsWith("EDITAR_")) return "pencil";
  if (a.startsWith("EXCLUIR_")) return "trash";
  if (a.startsWith("RESTAURAR_")) return "undo";
  return "check";
}

// ─── A rolagem do fio ────────────────────────────────────────────────

/**
 * O fio segue colado no fim depois deste evento de scroll? `distancia` é quanto falta para o fim
 * (px); `topo` e `topoAnterior` são o scrollTop agora e no evento anterior. Pura.
 *
 * Perto do fim, cola. Longe, só DESCOLA se o topo SUBIU: foi o Carlos que rolou para ler. O scroll
 * que o próprio fio provoca (HomePage irParaOFim) é entregue no quadro SEGUINTE; se a resposta
 * cresceu o fio nesse meio-tempo (chegou rápido, ou a aba estava sem pintar), o evento chega com o
 * topo parado e o fim mais longe — e, lido só pela distância, parecia "subiu para ler": o fio parava
 * de acompanhar justamente a resposta e os botões dela.
 */
export function coladoAposRolar(colado, { distancia, topo, topoAnterior, limite }) {
  if (distancia < limite) return true;
  if (topo < topoAnterior) return false;
  return colado;
}

// ─── O fio montado para a tela ───────────────────────────────────────

function diaDe(instante, hoje) {
  if (!instante) return hoje;
  const d = new Date(instante);
  return Number.isNaN(d.getTime()) ? hoje : toISODateLocal(d);
}

/**
 * turnos → itens do fio, na ordem: {tipo: "dia", data} antes do primeiro turno de cada dia que não
 * é hoje; {tipo: "hoje"} (a saudação e o card "Hoje") antes do primeiro turno de hoje — ou no fim,
 * se hoje ainda não teve turno; {tipo: "sessao"} onde a conversa recomeçou (o `sessao_id` mudou, ou
 * o Carlos pediu "Nova conversa" depois do turno `corte`); {tipo: "turno", turno, ultimo} — `ultimo`
 * marca o turno com turno_id mais recente (o único que pode oferecer "Tentar de novo"). Pura.
 *
 * O divisor de sessão diz uma coisa que a tela não pode esconder: dali para trás o assistente não
 * lembra (só o recap). Na virada de dia ele não sai — o dia já é a quebra, e os dois juntos eram ruído.
 */
export function montarFio(turnos, { hoje, corte = null }) {
  const itens = [];
  let diaAnterior = null;
  let sessaoAnterior = null;
  let hojeMontado = false;
  const chaveDoUltimo = ultimoComId(turnos)?.chave ?? null;
  for (const t of turnos) {
    const dia = diaDe(t.criado_em, hoje);
    let virouDia = false;
    if (dia !== diaAnterior) {
      if (dia === hoje) {
        if (!hojeMontado) itens.push({ tipo: "hoje", chave: "hoje" });
        hojeMontado = true;
      } else {
        itens.push({ tipo: "dia", data: dia, chave: `dia-${dia}` });
      }
      diaAnterior = dia;
      virouDia = true;
    }
    if (t.sessao_id && sessaoAnterior && t.sessao_id !== sessaoAnterior && !virouDia) {
      itens.push({ tipo: "sessao", chave: `sessao-${t.chave}` });
    }
    itens.push({ tipo: "turno", turno: t, chave: t.chave, ultimo: t.chave === chaveDoUltimo });
    if (t.sessao_id) sessaoAnterior = t.sessao_id;
    if (corte && t.turno_id === corte) {
      itens.push({ tipo: "sessao", chave: "corte" });
      // O divisor já está posto: a sessão nova do turno seguinte não ganha um segundo.
      sessaoAnterior = null;
    }
  }
  if (!hojeMontado) itens.push({ tipo: "hoje", chave: "hoje" });
  return itens;
}

// ─── O reducer ───────────────────────────────────────────────────────

const consultaNova = (agora) => ({ falhas: 0, parada: null, desde: agora });

function turnoDoServidor(s, agora) {
  return {
    ...s,
    chave: s.turno_id,
    contexto: null,
    codigo: null,
    incerto: false,
    conferido: false,
    enviado_em: null,
    retentado: false,
    nota: null,
    salvandoNota: false,
    consulta: s.status === EM_ANDAMENTO ? consultaNova(agora) : null,
  };
}

// O servidor é a verdade dos campos dele; a tela guarda os seus (chave, vínculo, chips em voo). Um
// desfeito_em marcado aqui só some se o servidor disser outro — nunca por uma resposta sem ele.
function mesclar(local, s) {
  const acoes = s.acoes.map((a) => {
    const antes = local.acoes?.find((x) => x.idx === a.idx);
    return {
      ...a,
      desfeito_em: a.desfeito_em ?? antes?.desfeito_em ?? null,
      desfazendo: antes?.desfazendo ?? false,
      semVolta: antes?.semVolta ?? false,
    };
  });
  return { ...local, ...s, entrada: s.entrada ?? local.entrada, acoes };
}

// ─── Adotar o turno de um envio incerto ──────────────────────────────

// A bolha de um envio incerto que ainda espera saber se chegou.
const incertoAberto = (t) => !t.turno_id && (t.status === VERIFICANDO || (t.status === NAO_ENVIADO && t.incerto && !t.nota));

// Os turno_id que já têm dona: uma bolha da tela que foi aceita (a chave dela não é o turno_id).
// O turno que veio só do servidor (chave === turno_id) pode ser de um envio incerto e ser adotado.
function presos(turnos, exceto) {
  return new Set(turnos.filter((t) => t.turno_id && t.chave !== t.turno_id && t.chave !== exceto).map((t) => t.turno_id));
}

// O turno do servidor que é o envio incerto `local`: a mesma entrada (o backend grava o texto com
// trim), criado depois do envio (com a folga do relógio) e sem dona. O mais antigo que serve.
function acharAdotavel(local, candidatos, ocupados) {
  if (!local?.entrada?.trim() || !Number.isFinite(local.enviado_em)) return null;
  const alvo = local.entrada.trim();
  const desde = local.enviado_em - FOLGA_RELOGIO_MS;
  return (
    candidatos.find((s) => {
      if (ocupados.has(s.turno_id) || (s.entrada ?? "").trim() !== alvo) return false;
      const criado = Date.parse(s.criado_em ?? "");
      return Number.isFinite(criado) && criado >= desde;
    }) ?? null
  );
}

/**
 * O <turno> do servidor (da lista crua de GET /conversa) que corresponde ao envio incerto da bolha
 * `chave`, já normalizado — ou null. É a mesma regra do reducer (VERIFICADO e CONVERSA_CARREGADA);
 * o hook a usa para decidir se ainda precisa reenviar.
 */
export function turnoAdotavel(turnos, chave, lista) {
  const local = turnos.find((t) => t.chave === chave);
  if (!local || !incertoAberto(local)) return null;
  const candidatos = (Array.isArray(lista) ? lista : []).map(normalizarTurno).filter(Boolean);
  return acharAdotavel(local, candidatos, presos(turnos, chave));
}

// A bolha local vira o turno `s` do servidor: fica a chave (o React não remonta) e o vínculo; a
// consulta liga se ele ainda roda. `base` é a cópia que o fio já tinha desse turno, se tinha (os
// chips em voo dela valem), e o fim que ela já viu não volta a EM_ANDAMENTO.
function adotar(local, s, agora, base = local) {
  const fonte = base !== local && ehTerminal(base.status) && s.status === EM_ANDAMENTO ? base : s;
  const consulta =
    fonte.status === EM_ANDAMENTO ? (base.status === EM_ANDAMENTO && base.consulta ? base.consulta : consultaNova(agora)) : null;
  return {
    ...mesclar(base, fonte),
    chave: local.chave,
    contexto: local.contexto,
    codigo: null,
    incerto: false,
    conferido: false,
    enviado_em: null,
    retentado: false,
    nota: null,
    salvandoNota: false,
    consulta,
  };
}

// Adotar um turno já terminado é saber agora que o agente mexeu nos dados (ou desfez algo).
const adotadoMudou = (t) => ehTerminal(t.status) && (t.acoes.length > 0 || ehComandoDesfazer(t.entrada));

function mesclarConversa(locais, lista, agora) {
  const doServidor = lista.map(normalizarTurno).filter(Boolean);
  // A bolha de um envio incerto cujo turno veio na lista vira esse turno: o fio mostra UM só.
  const ocupados = presos(locais);
  const adotadoPor = new Map(); // turno_id → a bolha local
  for (const l of locais) {
    if (!incertoAberto(l)) continue;
    const s = acharAdotavel(l, doServidor, ocupados);
    if (s) {
      adotadoPor.set(s.turno_id, l);
      ocupados.add(s.turno_id);
    }
  }
  const adotadas = new Set([...adotadoPor.values()].map((l) => l.chave));
  const ids = new Set(doServidor.map((s) => s.turno_id));
  const locaisPorId = new Map(locais.filter((t) => t.turno_id).map((t) => [t.turno_id, t]));
  let mudou = false;
  const fio = doServidor.map((s) => {
    const local = locaisPorId.get(s.turno_id);
    const bolha = adotadoPor.get(s.turno_id);
    if (bolha) {
      const adotado = adotar(bolha, s, agora, local ?? bolha);
      mudou = mudou || adotadoMudou(adotado);
      return adotado;
    }
    if (!local) return turnoDoServidor(s, agora);
    // Um GET que saiu antes do fim do turno e voltou depois dele: o fim que a tela já viu vale.
    if (s.status === EM_ANDAMENTO && local.status !== EM_ANDAMENTO) return local;
    const junto = mesclar(local, s);
    return s.status === EM_ANDAMENTO ? junto : { ...junto, consulta: null };
  });
  // O que só a tela conhece (saindo, recusado na saída, ou aceito depois do GET) fica no fim.
  const resto = locais.filter((t) => (!t.turno_id || !ids.has(t.turno_id)) && !adotadas.has(t.chave));
  return { turnos: [...fio, ...resto], mudou };
}

const trocar = (turnos, achar, mudar) => turnos.map((t) => (achar(t) ? mudar(t) : t));
const porChave = (chave) => (t) => t.chave === chave;
const porId = (id) => (t) => Boolean(id) && t.turno_id === id;

function trocarAcao(turnos, turnoId, idx, mudar) {
  return trocar(turnos, porId(turnoId), (t) => ({
    ...t,
    acoes: t.acoes.map((a) => (a.idx === idx ? mudar(a) : a)),
  }));
}

function aplicarDesfeitas(turnos, turnoId, desfeitas, em) {
  const idxs = new Set((Array.isArray(desfeitas) ? desfeitas : []).map((d) => d?.idx).filter(Number.isInteger));
  if (idxs.size === 0) return turnos;
  return trocar(turnos, porId(turnoId), (t) => ({
    ...t,
    acoes: t.acoes.map((a) => (idxs.has(a.idx) ? { ...a, desfeito_em: a.desfeito_em ?? em, desfazendo: false } : a)),
  }));
}

function turnoLocal({ chave, texto, contexto, agora }) {
  return {
    chave,
    turno_id: null,
    status: ENVIANDO,
    motivo: null,
    texto: null,
    entrada: texto,
    acoes: [],
    n_tools: 0,
    sessao_id: null,
    criado_em: null,
    contexto: contexto ?? null,
    codigo: null,
    incerto: false, // a falha do envio não diz se o servidor recebeu (falhaIncerta)
    conferido: false, // o GET da conversa já disse que o turno não está lá
    enviado_em: Number.isFinite(agora) ? agora : null, // ms do navegador, para achar o turno no servidor
    retentado: false,
    nota: null,
    salvandoNota: false,
    consulta: null,
  };
}

// ─── As bolhas que só existem nesta aba (sessionStorage) ─────────────

// O composer limpa a caixa no envio: a bolha que falhou é a ÚNICA cópia do texto. Ela é guardada na
// aba (home/useChat.js) para sobreviver à troca de tela e ao F5; o vínculo vai reduzido à tarefa
// (os `comments` vão junto só porque o caminho legado do comentário reescreve o array inteiro).
function contextoGuardavel(c) {
  const tarefa = c?.tarefa;
  if (!tarefa || (typeof tarefa.id !== "string" && typeof tarefa.id !== "number")) return null;
  return {
    tarefa: {
      id: tarefa.id,
      name: typeof tarefa.name === "string" ? tarefa.name : "",
      ...(Array.isArray(tarefa.comments) ? { comments: tarefa.comments } : {}),
    },
  };
}

/**
 * Turnos do fio → o que a aba guarda: as bolhas sem turno_id que não viraram nota. A que ainda
 * estava saindo ou sendo conferida vai como envio incerto — na volta, a tela confere de novo.
 */
export function locaisParaGuardar(turnos) {
  return turnos
    .filter((t) => !t.turno_id && !t.nota && t.entrada?.trim())
    .filter((t) => ehFalhaLocal(t.status) || t.status === ENVIANDO || t.status === VERIFICANDO)
    .map((t) => {
      const emVoo = t.status === ENVIANDO || t.status === VERIFICANDO;
      return {
        chave: t.chave,
        entrada: t.entrada,
        status: t.status === DESLIGADO ? DESLIGADO : NAO_ENVIADO,
        codigo: t.codigo ?? null,
        incerto: emVoo || Boolean(t.incerto),
        enviado_em: Number.isFinite(t.enviado_em) ? t.enviado_em : null,
        contexto: contextoGuardavel(t.contexto),
      };
    });
}

/** O que a aba guardou → bolhas do fio (a incerta volta NÃO conferida). Item ilegível fica fora. */
export function locaisDoGuardado(bruto) {
  if (!Array.isArray(bruto)) return [];
  return bruto
    .filter((g) => g && typeof g === "object" && typeof g.chave === "string" && g.chave)
    .filter((g) => typeof g.entrada === "string" && g.entrada.trim() && (g.status === DESLIGADO || g.status === NAO_ENVIADO))
    .map((g) => ({
      ...turnoLocal({ chave: g.chave, texto: g.entrada, contexto: contextoGuardavel(g.contexto), agora: g.enviado_em }),
      status: g.status,
      codigo: typeof g.codigo === "string" ? g.codigo : null,
      incerto: g.status === NAO_ENVIADO && Boolean(g.incerto),
    }));
}

/**
 * O reducer do chat. Toda ação que depende do tempo traz `agora` (ms); nada aqui lê o relógio.
 * Ação desconhecida devolve o estado como está (o hook só despacha as daqui).
 */
export function reduzirChat(estado, acao) {
  switch (acao.type) {
    case "CONVERSA_PEDIDA":
      return { ...estado, carga: "CARREGANDO" };
    case "CONVERSA_CARREGADA": {
      const { turnos, mudou } = mesclarConversa(estado.turnos, acao.turnos ?? [], acao.agora);
      return { ...estado, carga: "PRONTA", turnos, mudancas: estado.mudancas + (mudou ? 1 : 0) };
    }
    case "CONVERSA_FALHOU":
      return { ...estado, carga: "FALHOU" };

    // As bolhas que a aba guardou (locaisDoGuardado) voltam ao fim, depois da primeira carga da
    // conversa. A que o fio já tem (o mesmo `chave`) não entra duas vezes.
    case "LOCAIS_RESTAURADOS": {
      const chaves = new Set(estado.turnos.map((t) => t.chave));
      const novos = (acao.locais ?? []).filter((t) => !chaves.has(t.chave));
      return { ...estado, locaisRestaurados: true, turnos: novos.length ? [...estado.turnos, ...novos] : estado.turnos };
    }

    case "ENVIAR":
      return { ...estado, turnos: [...estado.turnos, turnoLocal(acao)] };

    case "REENVIAR":
      return {
        ...estado,
        turnos: trocar(estado.turnos, porChave(acao.chave), (t) =>
          ehFalhaLocal(t.status)
            ? {
                ...t,
                status: ENVIANDO,
                codigo: null,
                incerto: false,
                conferido: false,
                enviado_em: Number.isFinite(acao.agora) ? acao.agora : t.enviado_em,
              }
            : t,
        ),
      };

    case "RETENTAR": {
      const velho = estado.turnos.find(porChave(acao.chave));
      if (!velho || !podeTentarDeNovo(velho, opcoesDeRetentar(estado, velho)) || ehFalhaLocal(velho.status)) return estado;
      return {
        ...estado,
        turnos: [
          ...trocar(estado.turnos, porChave(acao.chave), (t) => ({ ...t, retentado: true })),
          turnoLocal({ chave: acao.nova, texto: velho.entrada, contexto: velho.contexto, agora: acao.agora }),
        ],
      };
    }

    case "ACEITO": {
      const local = estado.turnos.find(porChave(acao.chave));
      if (!local || local.status !== ENVIANDO) return estado;
      // O GET da conversa pode ter voltado antes do 202 e já trazer este turno: fica um só, o local
      // (é ele que tem a chave do React e o vínculo).
      const outros = estado.turnos.filter((t) => t.chave === acao.chave || t.turno_id !== acao.turnoId);
      return {
        ...estado,
        desligado: false, // o servidor aceitou: o assistente está ligado (o reenvio de um DESLIGADO)
        turnos: trocar(outros, porChave(acao.chave), (t) => ({
          ...t,
          turno_id: acao.turnoId,
          status: EM_ANDAMENTO,
          consulta: consultaNova(acao.agora),
        })),
      };
    }

    case "RESPONDIDO": {
      const s = acao.turno;
      const local = estado.turnos.find(porChave(acao.chave));
      if (!local || !s) return estado;
      // Como no ACEITO: o GET da conversa pode ter trazido este turno antes do 200. Fica um só.
      const outros = estado.turnos.filter((t) => t.chave === acao.chave || t.turno_id !== s.turno_id);
      let turnos = trocar(outros, porChave(acao.chave), (t) => ({ ...mesclar(t, s), consulta: null }));
      const desfeitas = acao.desfazer?.desfeitas ?? [];
      turnos = aplicarDesfeitas(turnos, acao.desfazer?.turno_id, desfeitas, acao.em);
      return { ...estado, desligado: false, turnos, mudancas: estado.mudancas + (desfeitas.length > 0 ? 1 : 0) };
    }

    // Falha incerta (falhaIncerta, pelo código e pelo status HTTP): a bolha vai conferir antes de
    // oferecer qualquer botão. As recusas claras ficam como sempre foram.
    case "ENVIO_FALHOU": {
      const desligou = CODIGOS_DESLIGADO.includes(acao.codigo);
      const incerto = !desligou && (Boolean(acao.incerto) || falhaIncerta(acao.codigo, acao.status));
      const status = desligou ? DESLIGADO : incerto ? VERIFICANDO : NAO_ENVIADO;
      return {
        ...estado,
        desligado: estado.desligado || desligou,
        turnos: trocar(estado.turnos, porChave(acao.chave), (t) =>
          t.status === ENVIANDO ? { ...t, status, codigo: acao.codigo ?? null, incerto, conferido: false } : t,
        ),
      };
    }

    // "Verificar de novo" (ou o "Tentar de novo" de uma bolha incerta, que confere antes de reenviar).
    case "VERIFICAR":
      return {
        ...estado,
        turnos: trocar(estado.turnos, porChave(acao.chave), (t) =>
          t.status === NAO_ENVIADO && t.incerto && !t.nota ? { ...t, status: VERIFICANDO } : t,
        ),
      };

    // A resposta do GET /conversa da conferência: o turno apareceu (a bolha o adota, e a consulta
    // liga se ele ainda roda) ou não (a bolha fica NAO_ENVIADO conferida, e os botões aparecem).
    case "VERIFICADO": {
      const local = estado.turnos.find(porChave(acao.chave));
      if (!local || local.status !== VERIFICANDO) return estado;
      const s = turnoAdotavel(estado.turnos, acao.chave, acao.turnos);
      if (!s) {
        return { ...estado, turnos: trocar(estado.turnos, porChave(acao.chave), (t) => ({ ...t, status: NAO_ENVIADO, conferido: true })) };
      }
      const copia = estado.turnos.find((t) => t.turno_id === s.turno_id) ?? local;
      const adotado = adotar(local, s, acao.agora, copia);
      const outros = estado.turnos.filter((t) => t.chave === acao.chave || t.turno_id !== s.turno_id);
      const mudou = adotadoMudou(adotado);
      return {
        ...estado,
        desligado: false, // o servidor aceitou: o assistente está ligado
        turnos: trocar(outros, porChave(acao.chave), () => adotado),
        mudancas: estado.mudancas + (mudou ? 1 : 0),
        // O resultado do desfazer (que chips riscar) só vem no 200 que se perdeu: relê a conversa.
        releituras: estado.releituras + (ehTerminal(adotado.status) && ehComandoDesfazer(adotado.entrada) ? 1 : 0),
      };
    }

    case "VERIFICACAO_FALHOU":
      return {
        ...estado,
        turnos: trocar(estado.turnos, porChave(acao.chave), (t) =>
          t.status === VERIFICANDO ? { ...t, status: NAO_ENVIADO, conferido: false } : t,
        ),
      };

    case "ATUALIZADO": {
      const s = acao.turno;
      const antes = estado.turnos.find(porId(s?.turno_id));
      if (!antes) return estado;
      // Uma consulta que saiu antes do fim e voltou depois dele não desfaz o fim (nem religa a consulta).
      if (s.status === EM_ANDAMENTO && antes.status !== EM_ANDAMENTO) return estado;
      const junto = mesclar(antes, s);
      let consulta = null;
      if (s.status === EM_ANDAMENTO) {
        const desde = antes.consulta?.desde ?? acao.agora;
        consulta = { falhas: 0, parada: acao.agora - desde > LIMITE_CONSULTA_MS ? "DEMORA" : null, desde };
      }
      const terminou = antes.status === EM_ANDAMENTO && ehTerminal(s.status);
      // Um "desfazer" que a tela consultou em vez de receber no 200 (adotado de um envio incerto,
      // ou achado em andamento no GET da conversa): o que ele riscou só aparece relendo o fio.
      const desfez = terminou && ehComandoDesfazer(junto.entrada);
      return {
        ...estado,
        turnos: trocar(estado.turnos, porId(s.turno_id), () => ({ ...junto, consulta })),
        mudancas: estado.mudancas + (terminou && (junto.acoes.length > 0 || desfez) ? 1 : 0),
        releituras: estado.releituras + (desfez ? 1 : 0),
      };
    }

    case "CONSULTA_FALHOU":
      return {
        ...estado,
        turnos: trocar(estado.turnos, porId(acao.turnoId), (t) => {
          if (t.status !== EM_ANDAMENTO) return t;
          if (acao.codigo === "NAO_ENCONTRADO") return { ...t, status: PERDIDO, consulta: null };
          const falhas = (t.consulta?.falhas ?? 0) + 1;
          return {
            ...t,
            consulta: { ...(t.consulta ?? consultaNova(acao.agora)), falhas, parada: falhas >= FALHAS_ATE_PARAR ? "SEM_CONEXAO" : null },
          };
        }),
      };

    case "CONSULTA_RETOMADA":
      return {
        ...estado,
        turnos: trocar(estado.turnos, porId(acao.turnoId), (t) =>
          t.status === EM_ANDAMENTO ? { ...t, consulta: consultaNova(acao.agora) } : t,
        ),
      };

    case "DESFAZER_PEDIDO":
      return { ...estado, turnos: trocarAcao(estado.turnos, acao.turnoId, acao.idx, (a) => ({ ...a, desfazendo: true })) };

    case "DESFEITO":
      return {
        ...estado,
        turnos: aplicarDesfeitas(estado.turnos, acao.turnoId, acao.desfeitas, acao.em),
        mudancas: estado.mudancas + 1,
      };

    case "DESFAZER_FALHOU":
      return {
        ...estado,
        turnos: trocarAcao(estado.turnos, acao.turnoId, acao.idx, (a) => {
          if (acao.codigo === "DESFAZER_JA_FEITO") return { ...a, desfazendo: false, desfeito_em: a.desfeito_em ?? acao.em };
          return { ...a, desfazendo: false, semVolta: a.semVolta || DESFAZER_SEM_VOLTA.includes(acao.codigo) };
        }),
      };

    // O corte é o último turno NO CLIQUE: o backend põe o encerramento na fila do canal antes de um
    // turno mandado enquanto o POST esperava, e esse turno já é da conversa nova.
    case "NOVA_CONVERSA_PEDIDA":
      return { ...estado, novaConversa: "PEDINDO", corteAlvo: ultimoComId(estado.turnos)?.turno_id ?? null };
    case "NOVA_CONVERSA_FEITA":
      return { ...estado, novaConversa: "OCIOSA", corte: estado.corteAlvo ?? estado.corte, corteAlvo: null };
    case "NOVA_CONVERSA_FALHOU":
      return { ...estado, novaConversa: "OCIOSA", corteAlvo: null };

    case "REATIVAR":
      return { ...estado, desligado: false };

    case "NOTA_SALVANDO":
      return { ...estado, turnos: trocar(estado.turnos, porChave(acao.chave), (t) => ({ ...t, salvandoNota: true })) };
    case "NOTA_SALVA":
      return {
        ...estado,
        turnos: trocar(estado.turnos, porChave(acao.chave), (t) => ({ ...t, salvandoNota: false, nota: acao.nota })),
        capturas: estado.capturas + 1,
      };
    // O composer sem assistente gravou direto: um "evento …" de hoje entra no card "Hoje".
    case "CAPTURA_FEITA":
      return { ...estado, capturas: estado.capturas + 1 };
    case "NOTA_FALHOU":
      return { ...estado, turnos: trocar(estado.turnos, porChave(acao.chave), (t) => ({ ...t, salvandoNota: false })) };

    default:
      return estado;
  }
}
