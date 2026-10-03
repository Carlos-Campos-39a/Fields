#!/usr/bin/env node
/**
 * Fields' MCP — projeção da ontologia do backend, sem nenhum cadastro próprio.
 *
 * Este arquivo não declara ferramenta nenhuma. Nome, schema, descrição, enum e anotação de cada tool
 * vêm de `GET /api/ops`, que o backend gera a partir de `src/agente/ontologia.js` + `schemas.js`
 * (o mesmo JSON que vira as tools do agente do Fields). Antes, o MCP era um segundo cadastro escrito
 * à mão: ~20 tools snake_case que divergiam da REST e dos enums do front. Com uma fonte só, a
 * operação nova, o campo novo e a flag `AGENTE_SOMENTE_LEITURA` chegam aqui sem tocar neste arquivo.
 *
 * O que ele expõe (e nada além disso — contrato da Les Chats §8: nenhuma tool de arquivo, env ou SQL):
 *   - tools/list  → `GET  /api/ops`, buscado A CADA chamada (sem cache: o MCP local nunca fica
 *                   defasado do backend implantado no Railway);
 *   - tools/call  → `POST /api/ops/:name`, o mesmo `executeRead`/`executeWrite` do agente, que grava
 *                   o `historico` com `origem:'mcp'`. A escrita executa na hora e não há desfazer por
 *                   este canal: criação e edição se corrigem com outra operação, exclusão não tem
 *                   volta (o prompt do canal `mcp` diz quais, e manda confirmar antes de excluir);
 *   - resources   → `fields://ontologia` (o texto do prompt do canal `mcp`) e `fields://resumo-do-dia`;
 *   - prompts     → `assistente-fields`, o system prompt do canal `mcp`: Desktop, Code e Cowork agem
 *                   com o mesmo COMO AGIR / COMO FALAR do agente do Fields.
 *
 * ─── Configuração ──────────────────────────────────────────────────────────────────────────────
 * As duas variáveis são obrigatórias; sem uma delas o processo sai com código 1 e diz qual falta.
 *   FIELDS_API_URL   base da API, terminando em /api (https; http só para localhost)
 *   FIELDS_API_TOKEN o mesmo FIELDS_API_TOKEN do backend — vai no cabeçalho Authorization: Bearer
 *
 * Claude Desktop — e o Cowork, que usa os servidores locais do Desktop: Settings → Developer →
 * Edit Config → claude_desktop_config.json, e reiniciar o app:
 * {
 *   "mcpServers": {
 *     "fields": {
 *       "command": "node",
 *       "args": ["C:/dev/fields/fields/mcp/server.js"],
 *       "env": {
 *         "FIELDS_API_URL": "https://virtuous-enthusiasm-production-8de3.up.railway.app/api",
 *         "FIELDS_API_TOKEN": "<o mesmo FIELDS_API_TOKEN do backend>"
 *       }
 *     }
 *   }
 * }
 * Claude Code:
 *   claude mcp add fields -e FIELDS_API_URL=https://…/api -e FIELDS_API_TOKEN=… -- node C:/dev/fields/fields/mcp/server.js
 *
 * ─── Os nomes das tools MUDARAM (fase A2) ──────────────────────────────────────────────────────
 * Instruções salvas que citem os nomes antigos (o projeto Fields no Cowork, por exemplo) precisam ser
 * reescritas. A lista vale como guia de migração; a fonte é sempre o `tools/list`.
 *   list_entries → BuscarEntradas          get_entry → ConsultarEntrada
 *   create_entry → NovaEntrada             update_entry → EditarEntrada
 *   delete_entry → ExcluirEntrada (agora exclusão lógica: o dado fica no banco, mas pelo MCP não há volta)
 *   add_thread / add_task_comment / add_meeting_comment → NovoComentario (alvo entrada/tarefa/reunião)
 *   list_projects → ListarProjetos         create_project → NovoProjeto     create_frente → NovaFrente
 *   create_task → NovaTarefa               update_task / move_task_kanban → EditarTarefa
 *   delete_task → ExcluirTarefa            get_kanban_board → BuscarTarefas (filtro por coluna)
 *   list_meetings → ListarReunioes         create_meeting → NovaReuniao     update_meeting → EditarReuniao
 *   resource fields://overview → fields://resumo-do-dia (e a tool ResumoDoDia)
 *
 * ─── Log ───────────────────────────────────────────────────────────────────────────────────────
 * Uma linha JSON por evento, em STDERR: o stdout é o canal JSON-RPC do stdio, e qualquer byte a
 * mais ali corrompe o protocolo. `evento` é código estável em UPPER_SNAKE (MCP_API, MCP_CATALOGO…).
 * Argumento de tool e resultado NUNCA entram no log — são notas, tarefas e reuniões da pessoa; o
 * token também não (e chave com cara de segredo sai redigida, como no `lib/log.js` do backend).
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const { version: VERSAO } = createRequire(import.meta.url)("./package.json");

// O nome da tool vai para o PATH (`/ops/:name`). Sem esta guarda, um nome como ".." ou "../entries"
// seria normalizado pelo parser de URL e cairia numa rota REST fora do gargalo das operações — a
// única porta que este processo pode abrir. Os nomes da ontologia são PascalCase ASCII.
const NOME_OPERACAO = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Código do spec MCP para resources/read de URI que o servidor não tem.
const RECURSO_NAO_ENCONTRADO = -32002;
const TEMPO_PADRAO_MS = 60_000;

// ─── Log ──────────────────────────────────────────────────────────────────────────────────────

const EVENTO_VALIDO = /^[A-Z][A-Z0-9_]*$/;
const CHAVE_SECRETA = /senha|segredo|cookie|authorization|password|secret|bearer|^token$|_token$/i;

/** criarLog(escrever) → {info, warn, erro}(evento, campos). `escrever` recebe a linha pronta. */
export function criarLog(escrever = (linha) => process.stderr.write(linha + "\n")) {
  function emitir(nivel, evento, campos = {}) {
    const ts = new Date().toISOString();
    const registro = EVENTO_VALIDO.test(evento)
      ? { ts, nivel, evento }
      : { ts, nivel, evento: "LOG_EVENTO_INVALIDO", evento_original: String(evento) };
    for (const [chave, valor] of Object.entries(campos)) {
      if (valor === undefined || Object.hasOwn(registro, chave)) continue;
      registro[chave] = CHAVE_SECRETA.test(chave) ? "[redigido]" : valor;
    }
    escrever(JSON.stringify(registro));
  }
  return {
    info: (evento, campos) => emitir("info", evento, campos),
    warn: (evento, campos) => emitir("warn", evento, campos),
    erro: (evento, campos) => emitir("erro", evento, campos),
  };
}

// ─── Configuração ─────────────────────────────────────────────────────────────────────────────

const HOSTS_LOCAIS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * lerConfig(env) → {ok:true, valor:{apiUrl, token}} | {ok:false, motivo, mensagem}.
 * Recusa devolve o MOTIVO (código estável) e uma mensagem que diz o que fazer — nunca o token.
 */
export function lerConfig(env) {
  const bruta = (env.FIELDS_API_URL ?? "").trim();
  const token = (env.FIELDS_API_TOKEN ?? "").trim();
  if (!bruta) {
    return { ok: false, motivo: "API_URL_AUSENTE",
      mensagem: "FIELDS_API_URL não definida. Exemplo: https://meu-app.up.railway.app/api" };
  }
  let url;
  try { url = new URL(bruta); } catch { url = null; }
  if (!url || !["https:", "http:"].includes(url.protocol)) {
    return { ok: false, motivo: "API_URL_INVALIDA",
      mensagem: "FIELDS_API_URL não é uma URL http(s). Exemplo: https://meu-app.up.railway.app/api" };
  }
  // O Bearer viaja em todo pedido: em http puro ele sai legível na rede. Só a máquina local escapa.
  if (url.protocol === "http:" && !HOSTS_LOCAIS.has(url.hostname) && !url.hostname.endsWith(".localhost")) {
    return { ok: false, motivo: "API_URL_SEM_TLS",
      mensagem: "FIELDS_API_URL precisa ser https (o token vai em todo pedido); http só vale para localhost." };
  }
  if (!token) {
    return { ok: false, motivo: "TOKEN_AUSENTE",
      mensagem: "FIELDS_API_TOKEN não definida. Use o mesmo valor de FIELDS_API_TOKEN configurado no backend (a API exige Bearer)." };
  }
  return { ok: true, valor: { apiUrl: bruta.replace(/\/+$/, ""), token } };
}

// ─── Renderização ─────────────────────────────────────────────────────────────────────────────

const erroMcp = (codigo, mensagem) => Object.assign(new Error(mensagem), { code: codigo });
const falhaDeTool = (texto) => ({ isError: true, content: [{ type: "text", text: texto }] });

/**
 * O sucesso de uma operação, legível para quem lê: a ação (se houve) em uma linha, e o resultado.
 *
 * Sem "(desfazível)", e sem turno_id/idx: o `desfazivel` do backend quer dizer "o POST
 * /api/agente/desfazer consegue inverter", e este canal não chama esse endpoint. Anunciar a volta
 * aqui fazia o modelo garantir ao Carlos um desfazer que ele não tem como executar — num
 * ExcluirProjeto, a árvore inteira. Como voltar atrás pelo MCP (e o que não tem volta) está no
 * prompt do canal, que o backend gera da ontologia.
 */
function textoDeSucesso({ resultado, acao }) {
  const corpo = typeof resultado === "string" ? resultado : JSON.stringify(resultado ?? null, null, 2);
  if (!acao) return corpo;
  return `Ação registrada: ${acao.resumo ?? acao.acao}\n\n${corpo}`;
}

const valorDeCampo = (v) =>
  Array.isArray(v) ? v.join("; ") : typeof v === "string" ? v : JSON.stringify(v);

// Um detalhe da recusa vai inteiro e sem ambiguidade: uma lista de textos (os `candidatos` do
// Esquecer) em JSON, porque um "; " dentro de um candidato confundiria a junção de valorDeCampo.
const valorDeDetalhe = (v) => (typeof v === "string" ? v : JSON.stringify(v));

// As chaves que o texto já mostra — tudo o mais que o backend mandar é detalhe da recusa.
const CHAVES_DO_ERRO = new Set(["erro", "error", "codigo", "campos"]);

/**
 * Resposta não-2xx → "<codigo>: <erro>". As rotas do contrato mandam {erro, codigo}; as da A0
 * (auth, parse, 500) mandam {error} sem código — essas viram HTTP_<status>, para o texto nunca sair
 * vazio. Corpo que não é JSON (a página de erro do proxy do Railway) não vai para o contexto do modelo.
 *
 * Toda chave a mais do corpo (candidatos do AMBIGUO, limite do MEMORIA_CHEIA) sai em "Detalhes:":
 * a mensagem do backend manda o modelo olhar esses campos ("veja `candidatos` e pergunte qual"), e
 * descartá-los o deixava sem como perguntar "qual?".
 */
function textoDeErro({ status, json, tipo }) {
  const corpo = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const codigo = typeof corpo.codigo === "string" ? corpo.codigo : `HTTP_${status}`;
  const mensagem = corpo.erro ?? corpo.error ?? `resposta sem corpo JSON (${tipo || "sem content-type"})`;
  const linhas = [`${codigo}: ${mensagem}`];
  if (status === 401) {
    linhas.push("O backend não aceitou o token: confira se FIELDS_API_TOKEN é o mesmo configurado no Fields.");
  }
  if (corpo.campos && typeof corpo.campos === "object") {
    linhas.push("Campos:");
    for (const [campo, v] of Object.entries(corpo.campos)) linhas.push(`- ${campo}: ${valorDeCampo(v)}`);
  }
  const detalhes = Object.entries(corpo).filter(([chave, v]) => !CHAVES_DO_ERRO.has(chave) && v !== undefined);
  if (detalhes.length) {
    linhas.push("Detalhes:");
    for (const [chave, v] of detalhes) linhas.push(`- ${chave}: ${valorDeDetalhe(v)}`);
  }
  return linhas.join("\n");
}

/** Valida o pedaço do catálogo de que a projeção depende. Devolve o problema, ou null. */
function problemaNoCatalogo(json) {
  if (!json || typeof json !== "object" || typeof json.versao !== "string" || !Array.isArray(json.ops)) {
    return { motivo: "FORMATO", mensagem: "esperado {versao, ops:[…]}" };
  }
  for (const [i, op] of json.ops.entries()) {
    if (!op || typeof op.name !== "string" || !NOME_OPERACAO.test(op.name)) {
      return { motivo: "NOME", posicao: i, mensagem: `a operação na posição ${i} não tem um nome válido` };
    }
    const schema = op.input_schema;
    if (!schema || typeof schema !== "object" || schema.type !== "object") {
      return { motivo: "INPUT_SCHEMA", op: op.name, mensagem: `${op.name} sem input_schema do tipo object` };
    }
  }
  return null;
}

// Só os cinco campos do contrato: um campo a mais vindo do backend (outputSchema, execution) mudaria
// o comportamento do cliente MCP sem que ninguém tivesse decidido isso aqui.
const paraTool = (op) => ({
  name: op.name,
  title: op.title,
  description: op.description,
  inputSchema: op.input_schema,
  annotations: op.annotations,
});

// ─── Servidor ─────────────────────────────────────────────────────────────────────────────────

const RECURSOS = [
  {
    uri: "fields://ontologia",
    name: "ontologia",
    title: "Ontologia do Fields'",
    description: "Entidades, relações, operações, rótulos e o jeito de agir — o mesmo texto que o agente do Fields lê no canal mcp.",
    mimeType: "text/plain",
  },
  {
    uri: "fields://resumo-do-dia",
    name: "resumo-do-dia",
    title: "Resumo do dia",
    description: "Reuniões de hoje, tarefas vencendo ou atrasadas e lembretes — o mesmo resultado da operação ResumoDoDia.",
    mimeType: "application/json",
  },
];

const PROMPT_ASSISTENTE = {
  name: "assistente-fields",
  title: "Assistente do Fields'",
  description: "Como agir no Fields': o prompt de sistema do agente no canal mcp — entidades, operações, rótulos, COMO AGIR e COMO FALAR.",
};

const INSTRUCOES =
  "Ferramentas do Fields' (notas, projetos → frentes → tarefas, kanban e agenda), projetadas da ontologia " +
  "do backend. Antes de agir, leia o prompt `assistente-fields` (ou o recurso fields://ontologia). " +
  "Uma escrita executa na hora e não há desfazer por este canal: uma exclusão não tem volta — " +
  "confirme o alvo com o Carlos antes. A data de hoje (fuso de Brasília) vem do ResumoDoDia.";

/**
 * criarServidor({apiUrl, token, fetch?, log?, timeoutMs?}) → Server do SDK, ainda sem transporte.
 * O `fetch` e o `log` são injetáveis para o teste; em produção valem os globais.
 */
export function criarServidor({ apiUrl, token, fetch: fetchFn = globalThis.fetch, log = criarLog(), timeoutMs = TEMPO_PADRAO_MS }) {
  const base = apiUrl.replace(/\/+$/, "");
  const { origin, pathname } = new URL(base);
  const prefixo = pathname.replace(/\/+$/, ""); // "/api", para as mensagens dizerem a rota real
  let versaoVista;

  /**
   * Um pedido ao backend. Devolve {status, json, tipo} quando houve resposta HTTP (qualquer status)
   * ou {falha: "REDE"|"TEMPO"|"CANCELADO"} quando não houve. Loga alvo, status e duration_ms.
   */
  async function pedir(metodo, caminho, { rota, op, corpo, aceita = "application/json", sinal } = {}) {
    const tempo = AbortSignal.timeout(timeoutMs);
    const inicio = performance.now();
    const ms = () => Math.round(performance.now() - inicio);
    try {
      const res = await fetchFn(base + caminho, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: aceita,
          ...(corpo !== undefined && { "Content-Type": "application/json" }),
        },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: sinal ? AbortSignal.any([sinal, tempo]) : tempo,
      });
      const texto = await res.text();
      const tipo = res.headers.get("content-type") ?? "";
      let json;
      if (/json/i.test(tipo)) { try { json = JSON.parse(texto); } catch { json = undefined; } }
      const codigo = typeof json?.codigo === "string" ? json.codigo : undefined;
      (res.ok ? log.info : log.warn)("MCP_API", { metodo, rota, op, status: res.status, codigo, duration_ms: ms() });
      return { status: res.status, json, texto, tipo };
    } catch (err) {
      const falha = tempo.aborted ? "TEMPO" : sinal?.aborted ? "CANCELADO" : "REDE";
      log.warn("MCP_API_FALHA", { metodo, rota, op, motivo: falha, causa: err?.cause?.code ?? err?.name, duration_ms: ms() });
      return { falha };
    }
  }

  const porque = (falha) => ({
    REDE: `sem resposta de ${origin} — confira FIELDS_API_URL e se o backend está no ar`,
    TEMPO: `o backend não respondeu em ${Math.round(timeoutMs / 1000)} s`,
    CANCELADO: "o pedido foi cancelado pelo cliente",
  })[falha];

  /** Uma leitura de apoio (catálogo, prompt, resumo): falha vira erro JSON-RPC com o motivo. */
  async function lerOuFalhar(caminho, rota, oQue, { aceita, sinal } = {}) {
    const r = await pedir("GET", caminho, { rota, aceita, sinal });
    if (r.falha) throw erroMcp(ErrorCode.InternalError, `Não consegui ler ${oQue} (GET ${prefixo}${rota}): ${porque(r.falha)}.`);
    if (r.status !== 200) throw erroMcp(ErrorCode.InternalError, `O Fields recusou ${oQue} (GET ${prefixo}${rota}): ${textoDeErro(r)}`);
    return r;
  }

  /** O corpo 2xx de leitura que embrulha {resultado}. Sem a chave, é contrato quebrado — não "vazio". */
  function resultadoOuFalhar(r, rota, oQue) {
    if (r.json && typeof r.json === "object" && Object.hasOwn(r.json, "resultado")) return r.json.resultado;
    log.erro("MCP_RESPOSTA_INVALIDA", { rota, status: r.status });
    throw erroMcp(ErrorCode.InternalError, `O Fields devolveu ${oQue} fora do contrato (GET ${prefixo}${rota}): faltou "resultado".`);
  }

  async function lerPromptMcp(sinal) {
    const r = await lerOuFalhar("/ontologia/prompt?canal=mcp", "/ontologia/prompt", "o prompt do canal mcp", { aceita: "text/plain", sinal });
    if (!r.texto) {
      log.erro("MCP_RESPOSTA_INVALIDA", { rota: "/ontologia/prompt", status: r.status });
      throw erroMcp(ErrorCode.InternalError, `O Fields devolveu o prompt do canal mcp vazio (GET ${prefixo}/ontologia/prompt).`);
    }
    return r.texto;
  }

  const servidor = new Server(
    { name: "fields", title: "Fields'", version: VERSAO },
    {
      // listChanged: quando uma operação some do backend (deploy, AGENTE_SOMENTE_LEITURA), o 404
      // OPERACAO_INDISPONIVEL avisa o cliente para listar de novo — o Desktop só lista ao conectar.
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      instructions: INSTRUCOES,
    },
  );

  // Só avisa quando a operação ESTAVA no último catálogo listado: aí ela de fato sumiu (deploy, flag).
  // Um nome que nunca existiu é engano do cliente, e a lista dele não mudou.
  let nomesListados = new Set();
  function avisarListaMudou(op) {
    if (!nomesListados.has(op)) return;
    log.info("MCP_LISTA_MUDOU", { op });
    servidor.sendToolListChanged().catch((err) => log.warn("MCP_AVISO_FALHOU", { op, causa: err?.name }));
  }

  // tools/list: o catálogo do backend, buscado a cada chamada. Backend fora → erro explícito, nunca
  // uma lista vazia: "nenhuma ferramenta" e "não consegui perguntar" não podem parecer a mesma coisa.
  servidor.setRequestHandler(ListToolsRequestSchema, async (_pedido, extra) => {
    const r = await lerOuFalhar("/ops", "/ops", "o catálogo de operações", { sinal: extra.signal });
    const problema = problemaNoCatalogo(r.json);
    if (problema) {
      log.erro("MCP_CATALOGO_INVALIDO", { motivo: problema.motivo, op: problema.op, posicao: problema.posicao });
      throw erroMcp(ErrorCode.InternalError, `O catálogo do Fields veio fora do contrato (GET ${prefixo}/ops): ${problema.mensagem}.`);
    }
    const { versao, ops } = r.json;
    log.info("MCP_CATALOGO", {
      versao,
      n_ops: ops.length,
      n_write: ops.filter((op) => op.tipo === "WRITE").length,
      mudou: versaoVista !== undefined && versaoVista !== versao,
    });
    versaoVista = versao;
    nomesListados = new Set(ops.map((op) => op.name));
    return { tools: ops.map(paraTool) };
  });

  // tools/call: repassa ao gargalo do backend. Não há lista local de nomes permitidos de propósito: quem
  // sabe o que está ligado é o backend (flag, deploy), e uma segunda lista aqui seria o descompasso
  // que esta fase elimina. O backend responde 404 OPERACAO_INDISPONIVEL para o que não está na ontologia.
  servidor.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const { name, arguments: args } = params;
    if (!NOME_OPERACAO.test(name)) {
      log.warn("MCP_OP_RECUSA", { motivo: "NOME_FORA_DO_FORMATO" });
      return falhaDeTool(`OPERACAO_INDISPONIVEL: "${String(name).slice(0, 80)}" não é uma operação do Fields. Liste as ferramentas de novo.`);
    }
    const rota = "/ops/:name";
    const r = await pedir("POST", `/ops/${name}`, { rota, op: name, corpo: args ?? {}, sinal: extra.signal });
    if (r.falha === "TEMPO") {
      return falhaDeTool(`TEMPO_ESGOTADO: ${porque(r.falha)}. Se ${name} era uma escrita, ela pode ter sido executada — consulte antes de repetir.`);
    }
    if (r.falha) return falhaDeTool(`API_INALCANCAVEL: ${porque(r.falha)}.`);

    if (r.status >= 200 && r.status < 300) {
      if (!r.json || typeof r.json !== "object" || !Object.hasOwn(r.json, "resultado")) {
        log.erro("MCP_RESPOSTA_INVALIDA", { rota, op: name, status: r.status });
        return falhaDeTool(`RESPOSTA_INVALIDA: o Fields aceitou ${name} (HTTP ${r.status}), mas a resposta veio sem "resultado". Consulte antes de repetir.`);
      }
      return { content: [{ type: "text", text: textoDeSucesso(r.json) }] };
    }
    if (r.status === 404 && r.json?.codigo === "OPERACAO_INDISPONIVEL") avisarListaMudou(name);
    return falhaDeTool(textoDeErro(r));
  });

  servidor.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RECURSOS }));

  servidor.setRequestHandler(ReadResourceRequestSchema, async ({ params }, extra) => {
    const { uri } = params;
    if (uri === "fields://ontologia") {
      const text = await lerPromptMcp(extra.signal);
      return { contents: [{ uri, mimeType: "text/plain", text }] };
    }
    if (uri === "fields://resumo-do-dia") {
      // Sem ?data: o "hoje" é do backend (fuso America/Sao_Paulo), não do relógio desta máquina.
      const r = await lerOuFalhar("/resumo-do-dia", "/resumo-do-dia", "o resumo do dia", { sinal: extra.signal });
      const resultado = resultadoOuFalhar(r, "/resumo-do-dia", "o resumo do dia");
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(resultado, null, 2) }] };
    }
    log.warn("MCP_RECURSO_RECUSA", { motivo: "URI_DESCONHECIDA" });
    throw erroMcp(RECURSO_NAO_ENCONTRADO, `Recurso desconhecido: ${String(uri).slice(0, 120)}. Os recursos são ${RECURSOS.map((r) => r.uri).join(" e ")}.`);
  });

  servidor.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [PROMPT_ASSISTENTE] }));

  servidor.setRequestHandler(GetPromptRequestSchema, async ({ params }, extra) => {
    if (params.name !== PROMPT_ASSISTENTE.name) {
      log.warn("MCP_PROMPT_RECUSA", { motivo: "NOME_DESCONHECIDO" });
      throw erroMcp(ErrorCode.InvalidParams, `Prompt desconhecido: ${String(params.name).slice(0, 80)}. O único é ${PROMPT_ASSISTENTE.name}.`);
    }
    const text = await lerPromptMcp(extra.signal);
    return {
      description: PROMPT_ASSISTENTE.description,
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  });

  return servidor;
}

// ─── Execução direta (stdio) ──────────────────────────────────────────────────────────────────
// Importado (pelo teste), o módulo só exporta a fábrica; o stdio sobe apenas quando é o principal.
// realpath dos dois lados: o `bin` do npm chega por link simbólico, e o argv[1] seria o link.

function ehPrincipal() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function principal() {
  const log = criarLog();
  const config = lerConfig(process.env);
  if (!config.ok) {
    log.erro("MCP_CONFIG_RECUSA", { motivo: config.motivo, mensagem: config.mensagem });
    // exitCode em vez de process.exit(): a linha no stderr termina de sair antes do processo acabar.
    process.exitCode = 1;
    return;
  }
  const servidor = criarServidor({ ...config.valor, log });
  await servidor.connect(new StdioServerTransport());
  log.info("MCP_INICIO", { api: new URL(config.valor.apiUrl).host, versao: VERSAO });
}

if (ehPrincipal()) await principal();
