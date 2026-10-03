// Ferramentas do agente — os executores das operações da ontologia. Porta do `tools.py` do CRM.
//
// - Executores chamam SÓ os serviços (src/servicos/*). Nenhum SQL aqui: é dos serviços que vêm a
//   visibilidade (views da cascata), o 404 e o histórico.
// - executeRead / executeWrite são o GARGALO ÚNICO: o motor do chat (etapa seguinte), o
//   POST /api/ops do MCP e o GET /api/resumo-do-dia passam por aqui, e só por aqui.
// - Argumentos sempre validados pelo schema da ferramenta (schemas.js), na leitura também.
//
// Duas brechas do CRM que este arquivo fecha:
//   1. Lá, uma operação desligada por flag sai da ontologia mas continua em READ_EXECUTORS, e o
//      `_require` vira no-op — a tool fica executável. Aqui o nome tem de estar nas OPERATIONS
//      LIGADAS, com o tipo certo, mesmo que exista executor: senão OPERACAO_INDISPONIVEL.
//   2. Lá, só a escrita é validada. Aqui a leitura também: um BuscarTarefas com status inventado
//      volta ARGUMENTOS_INVALIDOS em vez de uma lista vazia que o modelo leria como "não há".
//
// Recusa de serviço vira {erro, codigo} — nunca exceção para quem chama, nunca 500. Exceção de
// verdade (banco fora) vira {erro, codigo:"ERRO_INTERNO"} e log de erro.

import { txOuRecusa } from "../db/pool.js";
import { log } from "../lib/log.js";
import { recusa, sucesso } from "../lib/erros.js";
import { hojeISO, somarDias } from "../lib/datas.js";
import { COLUNA_FEITO, STATUS_CONCLUIDO, TIPOS_AGENDADOS, TIPO_EVENTO, TIPO_LEMBRETE, TIPO_NOTA } from "../dominio/enums.js";
import { MEMORIAS_ATIVAS_MAX, MEMORIA_TEXTO_MAX } from "../dominio/limites.js";
import { ACAO_BY_NAME, OPERATIONS, rotulo } from "./ontologia.js";
import { MAPAS, SCHEMAS, chaveDoId } from "./schemas.js";
import { DESFAZER_JANELA_MIN, INVERSOS } from "./desfazer.js";
import * as entradas from "../servicos/entradas.js";
import * as projetos from "../servicos/projetos.js";
import * as frentes from "../servicos/frentes.js";
import * as tarefas from "../servicos/tarefas.js";
import * as reunioes from "../servicos/reunioes.js";
import * as comentarios from "../servicos/comentarios.js";
import * as historico from "../servicos/historico.js";
import * as memorias from "../servicos/memorias.js";
import * as resumo from "../servicos/resumo.js";
import * as turnos from "../servicos/turnos.js";
import { comentariosDoAgente, reuniaoDoAgente } from "../servicos/serializadores.js";

// ── Projeções curtas (o que uma escrita devolve) ──────────────────────────────
// Toda saída leva o id ao lado do nome: o modelo encadeia pelo id, e o resumo da ação fala pelo nome.

const entradaCurta = (e) => ({
  entrada_id: e.id, tipo: e.type, titulo: e.title, data: e.date || null, hora: e.time || null,
  tags: e.tags ?? [], fixada: Boolean(e.pinned),
});
const semComentarios = ({ comentarios: _c, ...resto }) => resto;

/** Os argumentos de uma edição traduzidos para as colunas do serviço — só os que vieram. */
function camposDoMapa(editor, args) {
  const idChave = chaveDoId(editor);
  const campos = {};
  for (const [arg, coluna] of Object.entries(MAPAS[editor])) {
    if (arg !== idChave && args[arg] !== undefined) campos[coluna] = args[arg];
  }
  return campos;
}

// Encadeia passos que devolvem Resultado: o primeiro que recusa encerra, com o motivo dele.
async function depois(resultado, fn) {
  return resultado.ok ? fn(resultado.valor) : resultado;
}

// ── Leitura ───────────────────────────────────────────────────────────────────
// Assinatura de todo executor: (args validados, {db, sctx, hoje}). `sctx` é o ctx dos serviços
// ({origem, turnoId, comentariosMigrados, registros}); `hoje` é o dia no fuso de Brasília.

async function _resumoDoDia(a, x) {
  return resumo.resumoDoDia(x.db, x.sctx, a.data ?? x.hoje);
}

async function _proximosCompromissos(a, x) {
  return resumo.proximosCompromissos(x.db, x.sctx, { de: x.hoje, dias: a.dias });
}

async function _buscarEntradas(a, x) {
  const lista = await entradas.buscarEntradas(x.db, x.sctx, {
    texto: a.texto, tipos: a.tipo ? [a.tipo] : undefined, de: a.de, ate: a.ate,
    fixadas: a.fixadas, limite: a.limite ?? 20,
  });
  return sucesso({ entradas: lista, total: lista.length });
}

async function _consultarEntrada(a, x) {
  return depois(await entradas.obterEntrada(x.db, x.sctx, a.entrada_id), ({ entry, related }) => sucesso({
    entrada: { ...entradaCurta(entry), conteudo: entry.content },
    comentarios: comentariosDoAgente(entry.threads),
    relacionadas: related.map((e) => ({ entrada_id: e.id, tipo: e.type, titulo: e.title })),
  }));
}

async function _listarProjetos(_a, x) {
  const arvore = await projetos.listarProjetos(x.db, x.sctx);
  const aberta = (t) => t.status !== STATUS_CONCLUIDO && t.kanbanStatus !== COLUNA_FEITO;
  return sucesso({
    projetos: arvore.map((p) => ({
      projeto_id: p.id, nome: p.name, status: p.status, holder: p.holder,
      frentes: p.frentes.map((f) => ({
        frente_id: f.id, nome: f.name, tarefas_abertas: f.tasks.filter(aberta).length, tarefas: f.tasks.length,
      })),
    })),
  });
}

async function _buscarTarefas(a, x) {
  const lista = await tarefas.buscarTarefas(x.db, x.sctx, {
    texto: a.texto, projetoId: a.projeto_id, frenteId: a.frente_id, status: a.status,
    coluna: a.coluna, prazoAte: a.prazo_ate, atrasadasEm: a.atrasadas ? x.hoje : undefined,
    limite: a.limite ?? 30,
  });
  return sucesso({ tarefas: lista, total: lista.length });
}

async function _consultarTarefa(a, x) {
  return depois(await tarefas.obterTarefa(x.db, x.sctx, a.tarefa_id), (t) => sucesso({
    tarefa: semComentarios(t), comentarios: comentariosDoAgente(t.comentarios),
  }));
}

async function _listarReunioes(a, x) {
  const de = a.de ?? x.hoje;
  const ate = a.ate ?? somarDias(de, 7);
  const lista = await reunioes.listarReunioes(x.db, x.sctx, { from: de, to: ate });
  return sucesso({ de, ate, reunioes: lista.map(reuniaoDoAgente) });
}

async function _consultarReuniao(a, x) {
  return depois(await reunioes.obterReuniao(x.db, x.sctx, a.reuniao_id), (m) => sucesso({
    reuniao: reuniaoDoAgente(m), comentarios: comentariosDoAgente(m.comments),
  }));
}

const HISTORICO_MAX = 20;

async function _historicoEntidade(a, x) {
  return depois(await historico.listarHistorico(x.db, x.sctx, a.entidade_tipo, a.entidade_id), (eventos) => sucesso({
    eventos: eventos.slice(0, HISTORICO_MAX).map((e) => ({
      acao: e.acao, quando: e.criado_em, origem: e.origem, mudancas: e.mudancas, desfez_outro: e.desfaz_id != null,
    })),
    total: eventos.length,
  }));
}

export const READ_EXECUTORS = {
  ResumoDoDia: _resumoDoDia,
  ProximosCompromissos: _proximosCompromissos,
  BuscarEntradas: _buscarEntradas,
  ConsultarEntrada: _consultarEntrada,
  ListarProjetos: _listarProjetos,
  BuscarTarefas: _buscarTarefas,
  ConsultarTarefa: _consultarTarefa,
  ListarReunioes: _listarReunioes,
  ConsultarReuniao: _consultarReuniao,
  HistoricoEntidade: _historicoEntidade,
};

// ── Escrita ───────────────────────────────────────────────────────────────────
// Rodam DENTRO do tx de executeWrite (x.db é o cliente do tx). Quem exclui lê antes — depois da
// exclusão o registro é inexistente para leitura, e o resumo da ação precisa do nome.

async function _wNovaEntrada(a, x) {
  return depois(await entradas.criarEntrada(x.db, x.sctx, {
    type: a.tipo, title: a.titulo,
    // O serviço exige conteúdo; num lembrete simples ("me lembra de ligar pra Ana") o título é tudo.
    content: a.conteudo?.trim() ? a.conteudo : a.titulo,
    tags: a.tags, date: a.data ?? x.hoje, time: a.hora, pinned: a.fixada,
  }), (e) => sucesso(entradaCurta(e)));
}

async function _wEditarEntrada(a, x) {
  const campos = camposDoMapa("EditarEntrada", a);
  if (Object.keys(campos).length === 0) return recusa("NADA_A_ATUALIZAR");
  return depois(await entradas.atualizarEntrada(x.db, x.sctx, a.entrada_id, campos), (e) => sucesso(entradaCurta(e)));
}

async function _wExcluirEntrada(a, x) {
  return depois(await entradas.obterEntrada(x.db, x.sctx, a.entrada_id), async ({ entry }) =>
    depois(await entradas.excluirEntrada(x.db, x.sctx, a.entrada_id), () => sucesso({ ...entradaCurta(entry), excluida: true })));
}

async function _wNovoProjeto(a, x) {
  return depois(await projetos.criarProjeto(x.db, x.sctx, { name: a.nome, status: a.status, holder: a.holder }),
    (p) => sucesso({ projeto_id: p.id, nome: p.name, status: p.status, holder: p.holder }));
}

async function _wEditarProjeto(a, x) {
  const campos = camposDoMapa("EditarProjeto", a);
  if (Object.keys(campos).length === 0) return recusa("NADA_A_ATUALIZAR");
  return depois(await projetos.atualizarProjeto(x.db, x.sctx, a.projeto_id, campos),
    async () => projetos.obterProjeto(x.db, x.sctx, a.projeto_id));
}

async function _wExcluirProjeto(a, x) {
  return depois(await projetos.obterProjeto(x.db, x.sctx, a.projeto_id), async (p) =>
    depois(await projetos.excluirProjeto(x.db, x.sctx, a.projeto_id), () => sucesso({ ...p, excluido: true })));
}

async function _wNovaFrente(a, x) {
  return depois(await projetos.obterProjeto(x.db, x.sctx, a.projeto_id), async (p) =>
    depois(await frentes.criarFrente(x.db, x.sctx, a.projeto_id, { name: a.nome }),
      (f) => sucesso({ frente_id: f.id, nome: f.name, projeto_id: p.projeto_id, projeto: p.nome })));
}

async function _wEditarFrente(a, x) {
  const campos = camposDoMapa("EditarFrente", a);
  if (Object.keys(campos).length === 0) return recusa("NADA_A_ATUALIZAR");
  return depois(await frentes.atualizarFrente(x.db, x.sctx, a.frente_id, campos),
    async () => frentes.obterFrente(x.db, x.sctx, a.frente_id));
}

async function _wExcluirFrente(a, x) {
  return depois(await frentes.obterFrente(x.db, x.sctx, a.frente_id), async (f) =>
    depois(await frentes.excluirFrente(x.db, x.sctx, a.frente_id), () => sucesso({ ...f, excluida: true })));
}

async function _wNovaTarefa(a, x) {
  return depois(await tarefas.criarTarefa(x.db, x.sctx, a.frente_id, {
    name: a.nome, acao: a.acao, status: a.status, stakeholder: a.stakeholder, deadline: a.prazo,
    holder: a.holder, kanban_status: a.coluna, start_date: a.inicio,
  }), async (t) => depois(await tarefas.obterTarefa(x.db, x.sctx, t.id), (lida) => sucesso(semComentarios(lida))));
}

async function _wEditarTarefa(a, x) {
  const campos = camposDoMapa("EditarTarefa", a);
  if (Object.keys(campos).length === 0) return recusa("NADA_A_ATUALIZAR");
  return depois(await tarefas.atualizarTarefa(x.db, x.sctx, a.tarefa_id, campos), async () =>
    depois(await tarefas.obterTarefa(x.db, x.sctx, a.tarefa_id), (t) => sucesso(semComentarios(t))));
}

async function _wConcluirTarefa(a, x) {
  // Os DOIS eixos de uma vez, num evento só — é o que faz o desfazer devolver os dois juntos.
  return depois(await tarefas.atualizarTarefa(x.db, x.sctx, a.tarefa_id, { status: STATUS_CONCLUIDO, kanban_status: COLUNA_FEITO }),
    async () => depois(await tarefas.obterTarefa(x.db, x.sctx, a.tarefa_id), (t) => sucesso(semComentarios(t))));
}

async function _wExcluirTarefa(a, x) {
  return depois(await tarefas.obterTarefa(x.db, x.sctx, a.tarefa_id), async (t) =>
    depois(await tarefas.excluirTarefa(x.db, x.sctx, a.tarefa_id), () => sucesso({ ...semComentarios(t), excluida: true })));
}

async function _wNovaReuniao(a, x) {
  return depois(await reunioes.criarReuniao(x.db, x.sctx, {
    title: a.titulo, date: a.data, start_time: a.inicio, end_time: a.fim, description: a.pauta, must: a.must,
  }), (m) => sucesso(reuniaoDoAgente(m)));
}

async function _wEditarReuniao(a, x) {
  const campos = camposDoMapa("EditarReuniao", a);
  if (Object.keys(campos).length === 0) return recusa("NADA_A_ATUALIZAR");
  return depois(await reunioes.atualizarReuniao(x.db, x.sctx, a.reuniao_id, campos), (m) => sucesso(reuniaoDoAgente(m)));
}

async function _wExcluirReuniao(a, x) {
  return depois(await reunioes.obterReuniao(x.db, x.sctx, a.reuniao_id), async (m) =>
    depois(await reunioes.excluirReuniao(x.db, x.sctx, a.reuniao_id), () => sucesso({ ...reuniaoDoAgente(m), excluida: true })));
}

// O nome do alvo, para o resumo ("comentou na tarefa X") — e a leitura já confirma que ele existe.
async function nomeDoAlvo(x, alvoTipo, alvoId) {
  switch (alvoTipo) {
    case "ENTRADA": return depois(await entradas.obterEntrada(x.db, x.sctx, alvoId), ({ entry }) => sucesso(entry.title));
    case "TAREFA": return depois(await tarefas.obterTarefa(x.db, x.sctx, alvoId), (t) => sucesso(t.nome));
    case "REUNIAO": return depois(await reunioes.obterReuniao(x.db, x.sctx, alvoId), (m) => sucesso(m.title));
    default: return recusa("ALVO_INVALIDO");
  }
}

async function _wNovoComentario(a, x) {
  return depois(await nomeDoAlvo(x, a.alvo_tipo, a.alvo_id), async (alvoNome) =>
    depois(await comentarios.criarComentario(x.db, x.sctx, { alvo_tipo: a.alvo_tipo, alvo_id: a.alvo_id, texto: a.texto }),
      (c) => sucesso({ comentario_id: c.id, alvo_tipo: c.alvo_tipo, alvo_id: c.alvo_id, alvo_nome: alvoNome })));
}

async function _wLembrar(a, x) {
  return memorias.lembrar(x.db, x.sctx, { texto: a.texto, lembrar_em: a.lembrar_em ?? null });
}

async function _wEsquecer(a, x) {
  return memorias.esquecer(x.db, x.sctx, { trecho: a.trecho });
}

export const WRITE_EXECUTORS = {
  NovaEntrada: _wNovaEntrada,
  EditarEntrada: _wEditarEntrada,
  ExcluirEntrada: _wExcluirEntrada,
  NovoProjeto: _wNovoProjeto,
  EditarProjeto: _wEditarProjeto,
  ExcluirProjeto: _wExcluirProjeto,
  NovaFrente: _wNovaFrente,
  EditarFrente: _wEditarFrente,
  ExcluirFrente: _wExcluirFrente,
  NovaTarefa: _wNovaTarefa,
  EditarTarefa: _wEditarTarefa,
  ConcluirTarefa: _wConcluirTarefa,
  ExcluirTarefa: _wExcluirTarefa,
  NovaReuniao: _wNovaReuniao,
  EditarReuniao: _wEditarReuniao,
  ExcluirReuniao: _wExcluirReuniao,
  NovoComentario: _wNovoComentario,
  Lembrar: _wLembrar,
  Esquecer: _wEsquecer,
};

// ── O que uma escrita ACABOU de tocar ─────────────────────────────────────────
//
// [entidade_tipo, chave do id na saída do executor]. O entidade_tipo é o vocabulário de ENTIDADES
// (o mesmo do histórico): é por ele que o desfazer acha o evento da escrita.
//
// `null` marca a escrita SEM alvo desfazível — explícito, não ausente: ausência se lê como
// esquecimento, e é isso que o teste reflexivo distingue. Lembrar/Esquecer mexem na memória do
// próprio Carlos, não em dado de trabalho.
export const ALVO_DA_ESCRITA = {
  NovaEntrada: ["ENTRADA", "entrada_id"],
  EditarEntrada: ["ENTRADA", "entrada_id"],
  ExcluirEntrada: ["ENTRADA", "entrada_id"],
  NovoProjeto: ["PROJETO", "projeto_id"],
  EditarProjeto: ["PROJETO", "projeto_id"],
  ExcluirProjeto: ["PROJETO", "projeto_id"],
  NovaFrente: ["FRENTE", "frente_id"],
  EditarFrente: ["FRENTE", "frente_id"],
  ExcluirFrente: ["FRENTE", "frente_id"],
  NovaTarefa: ["TAREFA", "tarefa_id"],
  EditarTarefa: ["TAREFA", "tarefa_id"],
  ConcluirTarefa: ["TAREFA", "tarefa_id"],
  ExcluirTarefa: ["TAREFA", "tarefa_id"],
  NovaReuniao: ["REUNIAO", "reuniao_id"],
  EditarReuniao: ["REUNIAO", "reuniao_id"],
  ExcluirReuniao: ["REUNIAO", "reuniao_id"],
  NovoComentario: ["COMENTARIO", "comentario_id"],
  Lembrar: null,
  Esquecer: null,
};

/**
 * {entidade_tipo, entidade_id} da escrita que acabou de rodar, ou null. null é silêncio LEGÍTIMO
 * (escrita sem alvo, saída sem o id) e não lança: roda DEPOIS de a escrita dar certo, e derrubar o
 * turno aqui trocaria "não dá para desfazer" por "a ação falhou" — mentira sobre algo já gravado.
 */
export function alvoDaEscrita(nome, saida) {
  const alvo = ALVO_DA_ESCRITA[nome];
  if (!alvo || !saida || typeof saida !== "object") return null;
  const [entidadeTipo, chave] = alvo;
  const entidadeId = saida[chave];
  if (!entidadeId) return null;
  return { entidade_tipo: entidadeTipo, entidade_id: String(entidadeId) };
}

// ── O resumo de cada ação, em português e sem id ──────────────────────────────
// É o que o chip da tela mostra ("Criou a tarefa “X”"), o que o desfazer devolve, e o que o MCP
// repassa. Nomes e rótulos, nunca ids nem valores crus de enum.

const ROTULO_DO_CAMPO = {
  tipo: "tipo", titulo: "título", conteudo: "conteúdo", tags: "tags", data: "data", hora: "hora",
  fixada: "fixada", nome: "nome", status: "status", holder: "responsável", coluna: "coluna",
  prazo: "prazo", inicio: "início", acao: "ação", stakeholder: "stakeholder", fim: "fim",
  pauta: "pauta", must: "must",
};
// Texto longo não cabe numa linha de resumo: diz-se só que mudou.
const SO_O_CAMPO = { content: "novo conteúdo", description: "nova pauta" };

function aspas(texto, max = 80) {
  const t = String(texto ?? "").trim() || "sem título";
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
}

function dataCurta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}` : String(iso ?? "");
}

function valorHumano(coluna, v) {
  if (v === null || v === undefined) return "sem valor";
  switch (coluna) {
    case "type": return rotulo("tipo_entrada", v);
    case "status": return rotulo("status", v);
    case "kanban_status": return rotulo("kanban", v);
    case "holder": return rotulo("holder", v);
    case "date": case "deadline": case "start_date": return dataCurta(v);
    case "pinned": return v ? "sim" : "não";
    case "tags": return v.length ? v.join(", ") : "nenhuma";
    default: return aspas(v, 60);
  }
}

function listaMudancas(editor, args) {
  const idChave = chaveDoId(editor);
  return Object.entries(MAPAS[editor])
    .filter(([arg]) => arg !== idChave && args[arg] !== undefined)
    .map(([arg, coluna]) => SO_O_CAMPO[coluna] ?? `${ROTULO_DO_CAMPO[arg] ?? arg} → ${valorHumano(coluna, args[arg])}`)
    .join("; ");
}

// "a nota", "o evento", "o lembrete", "a nota de francês".
function aEntrada(tipo) {
  const r = rotulo("tipo_entrada", tipo);
  if (tipo === TIPO_EVENTO || tipo === TIPO_LEMBRETE) return `o ${r}`;
  if (tipo === TIPO_NOTA) return `a ${r}`;
  return `a nota de ${r}`;
}

const quando = (data, hora) => (data ? ` para ${dataCurta(data)}${hora ? ` às ${hora}` : ""}` : "");

/** Uma frase no passado, com nomes e rótulos — nunca ids. */
export function resumoAcao(nome, args = {}, saida = {}) {
  const s = saida ?? {};
  switch (nome) {
    // A data só é notícia em evento e lembrete; numa nota é o dia do registro.
    case "NovaEntrada": return `Criou ${aEntrada(s.tipo)} ${aspas(s.titulo)}${TIPOS_AGENDADOS.includes(s.tipo) ? quando(s.data, s.hora) : ""}`;
    case "EditarEntrada": return `Editou ${aEntrada(s.tipo)} ${aspas(s.titulo)}: ${listaMudancas(nome, args)}`;
    case "ExcluirEntrada": return `Excluiu ${aEntrada(s.tipo)} ${aspas(s.titulo)}`;
    case "NovoProjeto": return `Criou o projeto ${aspas(s.nome)}`;
    case "EditarProjeto": return `Editou o projeto ${aspas(s.nome)}: ${listaMudancas(nome, args)}`;
    case "ExcluirProjeto": return `Excluiu o projeto ${aspas(s.nome)}, com as frentes e tarefas dele`;
    case "NovaFrente": return `Criou a frente ${aspas(s.nome)} no projeto ${aspas(s.projeto)}`;
    case "EditarFrente": return `Editou a frente ${aspas(s.nome)}: ${listaMudancas(nome, args)}`;
    case "ExcluirFrente": return `Excluiu a frente ${aspas(s.nome)}, com as tarefas dela`;
    case "NovaTarefa": return `Criou a tarefa ${aspas(s.nome)} na frente ${aspas(s.frente)}${s.prazo ? `, para ${dataCurta(s.prazo)}` : ""}`;
    case "EditarTarefa": return `Editou a tarefa ${aspas(s.nome)}: ${listaMudancas(nome, args)}`;
    case "ConcluirTarefa": return `Concluiu a tarefa ${aspas(s.nome)}`;
    case "ExcluirTarefa": return `Excluiu a tarefa ${aspas(s.nome)}`;
    case "NovaReuniao": return `Marcou a reunião ${aspas(s.titulo)}${quando(s.data, s.inicio)}`;
    case "EditarReuniao": return `Editou a reunião ${aspas(s.titulo)}: ${listaMudancas(nome, args)}`;
    case "ExcluirReuniao": return `Excluiu a reunião ${aspas(s.titulo)}`;
    case "NovoComentario": return `Comentou na ${rotulo("alvo_comentario", s.alvo_tipo)} ${aspas(s.alvo_nome)}`;
    case "Lembrar": return `Guardou na memória: ${aspas(s.texto, 120)}${s.lembrar_em ? ` (a partir de ${dataCurta(s.lembrar_em)})` : ""}`;
    case "Esquecer": return `Tirou da memória: ${aspas(s.texto, 120)}`;
    default: return "Executou uma ação";
  }
}

function montarAcao(nome, args, saida, registros) {
  const alvo = alvoDaEscrita(nome, saida);
  // O evento da escrita é o ÚLTIMO que ela gravou sobre o alvo (ex.: NovoComentario grava só o do
  // comentário). Sem evento — uma edição que não mudou nada — não há o que desfazer.
  const evento = alvo
    ? [...registros].reverse().find((r) => r.entidade_tipo === alvo.entidade_tipo && r.entidade_id === alvo.entidade_id)
    : null;
  const inverso = INVERSOS[nome] ?? null;
  return {
    tool: nome,
    acao: ACAO_BY_NAME[nome],
    entidade_tipo: alvo?.entidade_tipo ?? null,
    entidade_id: alvo?.entidade_id ?? null,
    historico_id: evento?.id ?? null,
    inverso,
    resumo: resumoAcao(nome, args, saida),
    desfazivel: Boolean(inverso && evento?.id != null),
    desfeito_em: null,
  };
}

// ── Recusa → {erro, codigo} ───────────────────────────────────────────────────

const MENSAGENS = {
  OPERACAO_INDISPONIVEL: "Esta operação não existe ou está desligada.",
  ARGUMENTOS_INVALIDOS: "Argumentos inválidos — veja `campos`.",
  ERRO_INTERNO: "Falha interna ao executar a operação.",
  NAO_ENCONTRADO: "Não encontrei esse registro — ele pode ter sido excluído.",
  NAO_ENCONTRADA: "Nenhuma linha da memória tem esse trecho.",
  AMBIGUO: "Mais de uma linha da memória tem esse trecho — veja `candidatos` e pergunte qual.",
  MEMORIA_CHEIA: `A memória está cheia (${MEMORIAS_ATIVAS_MAX} linhas). Pergunte ao Carlos qual pode sair.`,
  NADA_A_ATUALIZAR: "Nenhum campo para mudar foi enviado.",
  NOME_OBRIGATORIO: "O nome é obrigatório.",
  TITULO_E_CONTEUDO_OBRIGATORIOS: "Título e conteúdo são obrigatórios.",
  TITULO_E_DATA_OBRIGATORIOS: "Título e data são obrigatórios.",
  TEXTO_OBRIGATORIO: "O texto é obrigatório.",
  TEXTO_LONGO_DEMAIS: `Texto longo demais (até ${MEMORIA_TEXTO_MAX} caracteres na memória).`,
  TRECHO_OBRIGATORIO: "Diga um trecho do que deve sair da memória.",
  DATA_INVALIDA: "Data inválida (use AAAA-MM-DD).",
  ALVO_INVALIDO: "Alvo de comentário inválido.",
  TIPO_INVALIDO: "Tipo de registro inválido.",
  COMENTARIOS_INDISPONIVEIS: "Os comentários estão indisponíveis no momento.",
  COMENTARIOS_INVALIDOS: "Comentários ilegíveis.",
  COMENTARIOS_DESATUALIZADOS: "Os comentários mudaram nesse meio-tempo.",
  // desfazer.js
  NADA_A_DESFAZER: "Não há nada a desfazer nesse turno.",
  SEM_INVERSO: "Essa ação não tem como ser desfeita automaticamente.",
  DESFAZER_JA_FEITO: "Isso já foi desfeito.",
  DESFAZER_EXPIRADO: `Passou da janela de ${DESFAZER_JANELA_MIN} minutos para desfazer.`,
  ALTERADO_DEPOIS: "O registro — ou algo criado dentro dele — mudou depois dessa ação; confira na tela antes de desfazer.",
};

/** O texto pt-BR de um código de recusa (o motivo cru, se não houver texto: feio e visível). */
export function mensagemDaRecusa(codigo) {
  return MENSAGENS[codigo] ?? `Recusado: ${codigo}.`;
}

/** {ok:false, motivo, ...extras} → {erro, codigo, ...extras} — o formato do contrato HTTP e do modelo. */
export function erroDe(resultado) {
  const { ok: _ok, motivo, ...extras } = resultado;
  return { erro: mensagemDaRecusa(motivo), codigo: motivo, ...extras };
}

/** Issues do zod → {campo: mensagem}. Chave desconhecida vira o próprio nome dela. */
export function camposDoErro(erro) {
  const campos = {};
  for (const issue of erro.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) campos[[...issue.path, k].join(".")] = "campo desconhecido";
      continue;
    }
    const chave = issue.path.length ? issue.path.join(".") : "(raiz)";
    campos[chave] ??= issue.message;
  }
  return campos;
}

/** Valida os argumentos pelo schema da ferramenta: sucesso(dados normalizados) ou ARGUMENTOS_INVALIDOS. */
export function validarArgs(nome, args) {
  const schema = SCHEMAS[nome];
  if (!schema) return recusa("OPERACAO_INDISPONIVEL");
  const r = schema.safeParse(args ?? {});
  return r.success ? sucesso(r.data) : { ...recusa("ARGUMENTOS_INVALIDOS"), campos: camposDoErro(r.error) };
}

// ── O gargalo ─────────────────────────────────────────────────────────────────

const PG_CODIGO = /^[0-9A-Z]{5}$/;
// O nome vem de fora (URL do MCP, tool_use do modelo): só vai ao log se tiver cara de nome de tool.
const nomeParaLog = (nome) => (typeof nome === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(nome) ? nome : "(invalido)");
const chavesDe = (args) => (args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args).sort() : []);

/**
 * O único ponto por onde toda ferramenta passa — e por isso o único a instrumentar.
 *
 * AGENTE_TOOL (info) leva a ferramenta, o tipo, os NOMES dos argumentos (ordenados) e a duração —
 * nunca os valores: argumento de ferramenta é texto do Carlos (título de tarefa, conteúdo de nota).
 * AGENTE_TOOL_ERRO (warn para recusa, erro para exceção) leva o código.
 */
async function _executarComLog(nome, tipo, args, fn) {
  const inicio = process.hrtime.bigint();
  const ms = () => Math.round(Number(process.hrtime.bigint() - inicio) / 1e5) / 10;
  let resultado;
  try {
    resultado = await fn();
  } catch (err) {
    log.erro("AGENTE_TOOL_ERRO", {
      tool: nomeParaLog(nome), tipo, codigo: "ERRO_INTERNO", erro: err?.name ?? typeof err,
      pg_codigo: PG_CODIGO.test(err?.code ?? "") ? err.code : undefined, duration_ms: ms(),
    });
    return erroDe(recusa("ERRO_INTERNO"));
  }
  if (!resultado.ok) {
    log.warn("AGENTE_TOOL_ERRO", {
      tool: nomeParaLog(nome), tipo, codigo: resultado.motivo,
      campos: resultado.campos ? Object.keys(resultado.campos).sort() : undefined, duration_ms: ms(),
    });
    return erroDe(resultado);
  }
  log.info("AGENTE_TOOL", { tool: nome, tipo, argumentos: chavesDe(args), duration_ms: ms() });
  return resultado.valor;
}

// Fecha a brecha do CRM: executor existir não basta — a operação tem de estar LIGADA, e com o tipo
// pedido (um READ não entra por executeWrite, nem o contrário).
function portao(nome, tipo, operacoes) {
  const op = operacoes.find((o) => o.name === nome);
  const executores = tipo === "READ" ? READ_EXECUTORS : WRITE_EXECUTORS;
  if (!op || op.tipo !== tipo || !Object.hasOwn(executores, nome)) return recusa("OPERACAO_INDISPONIVEL");
  return null;
}

function ambiente(ctx, db, registros) {
  return {
    db,
    sctx: {
      origem: ctx.origem, turnoId: ctx.turnoId ?? null, comentariosMigrados: ctx.comentariosMigrados,
      registros,
    },
    hoje: hojeISO(ctx.agora ?? new Date()),
  };
}

const CANAL_DA_ORIGEM = { mcp: "mcp", whatsapp: "whatsapp" };

/**
 * Executa uma leitura. ctx = {db, origem, comentariosMigrados, agora}. Devolve {resultado} ou
 * {erro, codigo, ...}. `operacoes` é a costura dos testes (a flag ligada sem mexer em env).
 */
export async function executeRead(nome, args, ctx, { operacoes = OPERATIONS } = {}) {
  return _executarComLog(nome, "READ", args, async () => {
    const fechado = portao(nome, "READ", operacoes);
    if (fechado) return fechado;
    const v = validarArgs(nome, args);
    if (!v.ok) return v;
    return depois(await READ_EXECUTORS[nome](v.valor, ambiente(ctx, ctx.db, [])), (valor) => sucesso({ resultado: valor }));
  });
}

/**
 * Executa uma escrita e anota a ação no turno — no MESMO tx: a ação existe se e somente se a
 * escrita foi gravada. Recusa (do executor ou do serviço) volta tudo atrás, inclusive a linha do
 * turno criada aqui (txOuRecusa).
 *
 * ctx = {db, origem, turnoId, agora, comentariosMigrados, canal?, entrada?}. `canal` default vem da
 * origem (mcp → mcp, whatsapp → whatsapp, o resto → web).
 *
 * Devolve {resultado, acao:{turno_id, idx, tool, acao, entidade_tipo, entidade_id, historico_id,
 * inverso, resumo, desfazivel, desfeito_em}} ou {erro, codigo, ...}.
 */
export async function executeWrite(nome, args, ctx, { operacoes = OPERATIONS } = {}) {
  return _executarComLog(nome, "WRITE", args, async () => {
    const fechado = portao(nome, "WRITE", operacoes);
    if (fechado) return fechado;
    const v = validarArgs(nome, args);
    if (!v.ok) return v;
    if (typeof ctx?.turnoId !== "string" || !ctx.turnoId) {
      throw new TypeError("executeWrite: ctx.turnoId é obrigatório — toda escrita do agente pertence a um turno");
    }
    const canal = ctx.canal ?? CANAL_DA_ORIGEM[ctx.origem] ?? "web";
    return txOuRecusa(ctx.db, async (c) => {
      const registros = [];
      await turnos.garantirTurno(c, { id: ctx.turnoId, canal, entrada: ctx.entrada ?? null });
      const saida = await WRITE_EXECUTORS[nome](v.valor, ambiente(ctx, c, registros));
      if (!saida.ok) return saida;
      const acao = await turnos.registrarAcao(c, ctx.turnoId, montarAcao(nome, v.valor, saida.valor, registros));
      return sucesso({ resultado: saida.valor, acao: { turno_id: ctx.turnoId, ...acao } });
    });
  });
}

// ── O retorno de uma ferramenta, para o modelo ────────────────────────────────

export const RESULTADO_MAX = 8000;
const TEXTO_CORTE = 1000;

const json = (v) => JSON.stringify(v ?? null, (_k, x) => (typeof x === "bigint" ? String(x) : x));

function cortarTextos(v) {
  if (typeof v === "string") return v.length > TEXTO_CORTE ? `${v.slice(0, TEXTO_CORTE)}…` : v;
  if (Array.isArray(v)) return v.map(cortarTextos);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cortarTextos(x)]));
  return v;
}

/**
 * Serializa o retorno de uma ferramenta cabendo em `max` caracteres — porta do `_serializar_tool`.
 *
 * Trunca por NÚMERO DE ITENS, nunca por caractere: o corte cego (`JSON.stringify(...).slice(0, MAX)`)
 * produz JSON inválido no meio de uma chave. Corta as listas do topo pela metade, acumulando entre
 * as listas (ao contrário do CRM, que recomeçava do original a cada chave); depois, os textos longos
 * (uma nota inteira). Sempre marca `truncado: true`. Último recurso: um objeto de erro VÁLIDO.
 */
export function serializarResultado(obj, max = RESULTADO_MAX) {
  const inteiro = json(obj);
  if (inteiro.length <= max) return inteiro;

  let atual = Array.isArray(obj) ? { itens: obj } : obj && typeof obj === "object" ? { ...obj } : null;
  if (atual) {
    atual.truncado = true;
    for (const [chave, valor] of Object.entries(atual)) {
      if (!Array.isArray(valor) || valor.length === 0) continue;
      let itens = valor;
      while (itens.length > 1 && json({ ...atual, [chave]: itens }).length > max) {
        itens = itens.slice(0, Math.max(1, Math.floor(itens.length / 2)));
      }
      atual = { ...atual, [chave]: itens };
      if (json(atual).length <= max) return json(atual);
    }
    const curto = json(cortarTextos(atual));
    if (curto.length <= max) return curto;
  }
  return json({ erro: "resultado grande demais para exibir", truncado: true });
}
