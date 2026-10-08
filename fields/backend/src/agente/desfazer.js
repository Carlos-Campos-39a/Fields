// O desfazer do agente — a rede de proteção que substitui a aprovação prévia. Porta do
// `desfazer_service.py` do CRM.
//
// A escrita do agente acontece na hora; o caminho de volta fica a um gesto ("desfazer" no WhatsApp,
// o botão na tela) pelo tempo da janela. Isso torna barato o caso comum (o agente entendeu certo)
// sem deixar caro o raro.
//
// ## Por que isto não chama LLM
//
// Desfazer não é interpretação, é inversão. O turno já anotou o que escreveu (agente_turnos.acoes,
// gravado no mesmo tx de cada escrita), e o resto é mecânico. Um segundo turno de modelo para
// "desfaz" poderia desfazer a coisa errada, e falharia justamente quando o primeiro falhou.
//
// ## Por que passa pelos SERVIÇOS e não por SQL próprio
//
// Porque é dos serviços que vêm, de graça e sem chance de divergir: a visibilidade (a tarefa de um
// projeto excluído é inexistente), o 404, e o registro no histórico — com a origem de quem desfez e
// o `desfaz_id` apontando o evento revertido. Um UPDATE próprio aqui teria de reimplementar os três,
// e o terceiro em silêncio.
//
// ## O que difere do CRM
//
// O corpo do pedido é só {turno_id, idx?}: a ação vem do BANCO (o que o servidor anotou), nunca do
// cliente. Por isso não há a guarda "o tipo de entidade casa com a tool" — o cliente não tem como
// apontar uma ferramenta para outra entidade. E a guarda de autoria do CRM ("o último evento é de
// outra pessoa") vira ALTERADO_DEPOIS: com um usuário só, a pergunta não é QUEM mexeu, é se alguém
// — a tela, o MCP, outro turno — mexeu DEPOIS da escrita do agente. No registro ou, quando o
// inverso é excluir, em qualquer coisa que a exclusão esconderia junto (a árvore e os comentários).

import { txOuRecusa } from "../db/pool.js";
import { log } from "../lib/log.js";
import { recusa, sucesso } from "../lib/erros.js";
import { MAPAS, chaveDoId } from "./schemas.js";
import * as entradas from "../servicos/entradas.js";
import * as projetos from "../servicos/projetos.js";
import * as frentes from "../servicos/frentes.js";
import * as tarefas from "../servicos/tarefas.js";
import * as reunioes from "../servicos/reunioes.js";
import * as comentarios from "../servicos/comentarios.js";
import * as historico from "../servicos/historico.js";
import * as turnos from "../servicos/turnos.js";

// ── O inverso de cada escrita ───────────────────────────────────────────────────────────────────
//
//   EXCLUIR   — a escrita CRIOU o registro; o inverso é a exclusão lógica.
//   RESTAURAR — a escrita EXCLUIU o registro; o inverso apaga o carimbo (a árvore volta junto).
//   REVERTER  — a escrita ALTEROU campos; o estado anterior vem do `historico` (os valores `de` do
//               evento que a escrita gravou). Não há snapshot próprio, e não deve haver: dois
//               lugares guardando "como era antes" divergem.
//
// Toda WRITE da ontologia tem veredito aqui, inclusive `null`. Ausência se lê como esquecimento;
// `null` se lê como decisão — e o teste reflexivo cobra a linha. Lembrar/Esquecer são `null` pelo
// mesmo motivo do CRM: mexem na memória do próprio Carlos, e desfazer é pedir de novo, numa frase.
export const INVERSOS = {
  NovaEntrada: "EXCLUIR",
  NovoProjeto: "EXCLUIR",
  NovaFrente: "EXCLUIR",
  NovaTarefa: "EXCLUIR",
  NovaReuniao: "EXCLUIR",
  NovoComentario: "EXCLUIR",
  EditarEntrada: "REVERTER",
  EditarProjeto: "REVERTER",
  EditarFrente: "REVERTER",
  EditarTarefa: "REVERTER",
  ConcluirTarefa: "REVERTER",
  EditarReuniao: "REVERTER",
  ExcluirEntrada: "RESTAURAR",
  ExcluirProjeto: "RESTAURAR",
  ExcluirFrente: "RESTAURAR",
  ExcluirTarefa: "RESTAURAR",
  ExcluirReuniao: "RESTAURAR",
  Lembrar: null,
  Esquecer: null,
};

// A ferramenta de EDIÇÃO de cada tipo. É do MAPA dela (schemas.js) que sai o que uma reversão pode
// escrever — nunca de um literal. A invariante que isso compra: **o desfazer só alcança o que o
// agente poderia ter mudado**. Escrita à mão, a lista envelheceria para os dois lados: sobrando um
// campo que nenhuma ferramenta alcança (o desfazer viraria porta dos fundos para ele) ou faltando
// um que alcança (a reversão ficaria pela metade, sem erro). ConcluirTarefa reverte pelo editor de
// tarefa: status e coluna estão nele.
export const EDITOR = {
  ENTRADA: "EditarEntrada",
  PROJETO: "EditarProjeto",
  FRENTE: "EditarFrente",
  TAREFA: "EditarTarefa",
  REUNIAO: "EditarReuniao",
};

/** Os ARGUMENTOS que uma reversão pode tocar neste editor: as chaves do MAPA menos o id. */
export function camposReversiveis(editor) {
  const idChave = chaveDoId(editor);
  return Object.keys(MAPAS[editor]).filter((arg) => arg !== idChave);
}

/** As COLUNAS correspondentes — é nelas que o histórico grava `{campo, de, para}`. */
function colunasReversiveis(editor) {
  return new Set(camposReversiveis(editor).map((arg) => MAPAS[editor][arg]));
}

// Quanto tempo depois da escrita o desfazer ainda vale. Lido no import (env do Railway; muda com
// restart). Depois disso, "desfazer" deixa de ser o gesto de corrigir o que acabou de acontecer e
// passa a ser uma edição às cegas sobre um registro que pode ter mudado de sentido.
export const DESFAZER_JANELA_MIN = Number(process.env.DESFAZER_JANELA_MIN) > 0
  ? Number(process.env.DESFAZER_JANELA_MIN)
  : 60;

// Os serviços de cada entidade — o ÚNICO caminho até o banco (ver o cabeçalho).
const SERVICOS = {
  ENTRADA: { excluir: entradas.excluirEntrada, restaurar: entradas.restaurarEntrada, atualizar: entradas.atualizarEntrada },
  PROJETO: { excluir: projetos.excluirProjeto, restaurar: projetos.restaurarProjeto, atualizar: projetos.atualizarProjeto },
  FRENTE: { excluir: frentes.excluirFrente, restaurar: frentes.restaurarFrente, atualizar: frentes.atualizarFrente },
  TAREFA: { excluir: tarefas.excluirTarefa, restaurar: tarefas.restaurarTarefa, atualizar: tarefas.atualizarTarefa },
  REUNIAO: { excluir: reunioes.excluirReuniao, restaurar: reunioes.restaurarReuniao, atualizar: reunioes.atualizarReuniao },
  COMENTARIO: { excluir: comentarios.excluirComentario, restaurar: comentarios.restaurarComentario },
};

// ── Partes puras (testadas sem banco) ─────────────────────────────────────────

/**
 * Quais ações desfazer, em que ordem — ou o motivo de não desfazer nenhuma.
 *
 * Sem `idx`: o turno inteiro, em LIFO (a última escrita volta primeiro: a segunda pode depender da
 * primeira, como a tarefa criada numa frente criada no mesmo turno). Com `idx`: só aquela ação —
 * e a guarda ALTERADO_DEPOIS recusa se uma ação POSTERIOR do turno, ainda de pé, tocou a mesma
 * entidade (é o LIFO cobrado por entidade).
 */
export function selecionarAcoes(turno, idx, agora, janelaMin = DESFAZER_JANELA_MIN) {
  const acoes = Array.isArray(turno?.acoes) ? turno.acoes : [];
  if (acoes.length === 0) return recusa("NADA_A_DESFAZER");

  let escolhidas;
  if (idx !== undefined && idx !== null) {
    const acao = acoes.find((a) => a.idx === idx);
    if (!acao) return recusa("NAO_ENCONTRADO");
    if (!acao.desfazivel) return recusa("SEM_INVERSO");
    if (acao.desfeito_em) return recusa("DESFAZER_JA_FEITO");
    escolhidas = [acao];
  } else {
    const desfaziveis = acoes.filter((a) => a.desfazivel);
    if (desfaziveis.length === 0) return recusa("SEM_INVERSO");
    const pendentes = desfaziveis.filter((a) => !a.desfeito_em);
    if (pendentes.length === 0) return recusa("DESFAZER_JA_FEITO");
    escolhidas = [...pendentes].sort((a, b) => b.idx - a.idx);
  }

  const idadeMs = new Date(agora).getTime() - new Date(turno.criado_em).getTime();
  if (idadeMs > janelaMin * 60_000) return recusa("DESFAZER_EXPIRADO");
  return sucesso(escolhidas);
}

/**
 * Os eventos posteriores que NÃO são do próprio desfazer. Um evento posterior é aceitável se é
 * deste turno E (é um desfazer — tem desfaz_id — OU é o evento de uma ação deste turno já desfeita).
 * Qualquer outro é alguém mexendo depois, e reverter por cima apagaria esse trabalho.
 *
 * Com UMA exceção, que vale para qualquer turno: o PAR escrita → desfazer dela, os dois depois da
 * ação. É o desfazer em pilha entre turnos — o Carlos concluiu a tarefa (turno 1), excluiu (turno 2),
 * desfez a exclusão e agora desfaz a conclusão. Sem a exceção, o par EXCLUIDO/RESTAURADO do turno 2
 * contava como "alguém mexeu depois", e a conclusão ficava sem volta para sempre, embora o registro
 * esteja exatamente como o turno 1 o deixou. O par se anula porque o desfazer só existe se a guarda
 * DELE passou (nada alheio entre a escrita e a volta, na mesma entidade) e porque ele devolve tudo o
 * que a escrita do agente mudou (o MAPA do editor cobre todo campo que uma ferramenta escreve). O
 * desfazer de um evento que não está na lista (anterior à ação) continua alheio: o par não está
 * inteiro aqui, e o que ele mexeu pode ser justamente o estado que a ação deixou.
 */
export function eventosAlheios(posteriores, turnoId, historicosDesfeitos) {
  const porId = new Map(posteriores.map((e) => [e.id, e]));
  const anulados = new Set();
  for (const volta of posteriores) {
    const escrita = volta.desfaz_id != null ? porId.get(volta.desfaz_id) : undefined;
    // O desfazer grava o turno_id do turno desfeito: par de turnos diferentes não é par.
    if (escrita && escrita.turno_id === volta.turno_id) {
      anulados.add(escrita.id);
      anulados.add(volta.id);
    }
  }
  return posteriores.filter((e) =>
    !anulados.has(e.id) &&
    !(e.turno_id === turnoId && (e.desfaz_id != null || historicosDesfeitos.has(e.id)))
  );
}

/** {coluna: valor de antes} do evento, só nas colunas que o editor da entidade alcança. */
export function payloadDeReversao(entidadeTipo, mudancas) {
  const editor = EDITOR[entidadeTipo];
  if (!editor) return {};
  const permitidas = colunasReversiveis(editor);
  return Object.fromEntries(
    (Array.isArray(mudancas) ? mudancas : [])
      .filter((m) => m && permitidas.has(m.campo))
      .map((m) => [m.campo, m.de ?? null])
  );
}

// ── O desfazer ────────────────────────────────────────────────────────────────

async function aplicarInverso(c, sctx, acao) {
  const servico = SERVICOS[acao.entidade_tipo];
  if (!servico) return recusa("SEM_INVERSO");
  switch (acao.inverso) {
    case "EXCLUIR": return servico.excluir(c, sctx, acao.entidade_id);
    case "RESTAURAR": return servico.restaurar(c, sctx, acao.entidade_id);
    case "REVERTER": {
      const evento = await historico.obterEvento(c, acao.historico_id);
      const payload = payloadDeReversao(acao.entidade_tipo, evento?.mudancas);
      // Acontece se o evento só mudou campo que nenhuma ferramenta alcança: não há o que voltar.
      if (Object.keys(payload).length === 0) return recusa("NADA_A_DESFAZER");
      return servico.atualizar(c, sctx, acao.entidade_id, payload);
    }
    default: return recusa("SEM_INVERSO");
  }
}

/**
 * Desfaz o turno inteiro (LIFO) ou só a ação `idx`. Tudo ou nada, num tx só: se a terceira inversão
 * recusa, as duas primeiras voltam — um "desfiz metade" seria impossível de explicar numa frase.
 *
 * ctx = {origem, comentariosMigrados, agora}. As inversões gravam histórico com a origem de QUEM
 * desfez, o turno_id do turno desfeito e o desfaz_id do evento revertido.
 *
 * Devolve sucesso({desfeitas:[{idx, resumo}]}) ou recusa(motivo): NAO_ENCONTRADO, NADA_A_DESFAZER,
 * SEM_INVERSO, DESFAZER_JA_FEITO, DESFAZER_EXPIRADO, ALTERADO_DEPOIS — ou a recusa do serviço.
 */
export async function desfazerTurno(db, ctx, { turnoId, idx } = {}) {
  const agora = ctx.agora ?? new Date();
  const feitas = [];

  const resultado = await txOuRecusa(db, async (c) => {
    const turno = await turnos.turnoParaDesfazer(c, turnoId);
    if (!turno) return recusa("NAO_ENCONTRADO");
    const selecao = selecionarAcoes(turno, idx, agora);
    if (!selecao.ok) return selecao;

    const historicosDesfeitos = new Set(
      turno.acoes.filter((a) => a.desfeito_em && a.historico_id != null).map((a) => a.historico_id)
    );
    for (const acao of selecao.valor) {
      // O inverso EXCLUIR esconde mais que a linha: a árvore pelas views da cascata (frentes e
      // tarefas de um projeto, tarefas de uma frente) e os comentários do alvo. Então a guarda olha
      // também o que nasceu ou mudou DENTRO dela depois — com a mesma tolerância (o próprio turno
      // desfazendo, em LIFO). REVERTER e RESTAURAR não escondem nada: basta a própria entidade.
      const posteriores = acao.inverso === "EXCLUIR"
        ? await historico.eventosDepoisNaArvore(c, acao.entidade_tipo, acao.entidade_id, acao.historico_id)
        : await historico.eventosDepois(c, acao.entidade_tipo, acao.entidade_id, acao.historico_id);
      const alheios = eventosAlheios(posteriores, turno.id, historicosDesfeitos);
      if (alheios.length) {
        return { ...recusa("ALTERADO_DEPOIS"), idx: acao.idx, eventos_depois: alheios.length };
      }
      const sctx = {
        origem: ctx.origem, turnoId: turno.id, comentariosMigrados: ctx.comentariosMigrados,
        desfazId: acao.historico_id,
      };
      const feito = await aplicarInverso(c, sctx, acao);
      if (!feito.ok) return { ...feito, idx: acao.idx };
      historicosDesfeitos.add(acao.historico_id);
      feitas.push(acao);
    }
    await turnos.marcarDesfeitas(c, turno.id, feitas.map((a) => a.idx), new Date(agora).toISOString());
    return sucesso({ desfeitas: feitas.map((a) => ({ idx: a.idx, resumo: a.resumo })) });
  });

  // Depois do COMMIT (ou do ROLLBACK): log de algo que voltou atrás mente. Sem texto do Carlos —
  // o resumo leva nomes; vão a ferramenta, o inverso e o tipo.
  if (resultado.ok) {
    for (const a of feitas) {
      log.info("AGENTE_DESFAZER", { tool: a.tool, inverso: a.inverso, entidade_tipo: a.entidade_tipo, idx: a.idx, origem: ctx.origem });
    }
  } else {
    log.warn("AGENTE_DESFAZER_RECUSA", {
      motivo: resultado.motivo, idx: resultado.idx ?? idx, inteiro: idx === undefined || idx === null,
      eventos_depois: resultado.eventos_depois, origem: ctx.origem,
    });
  }
  return resultado;
}
