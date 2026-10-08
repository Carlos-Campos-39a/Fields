// O MCP como projeção do backend, contra um backend FALSO em node:http que fala o contrato HTTP da
// fase A2 (GET /api/ops, POST /api/ops/:name, /api/ontologia/prompt, /api/resumo-do-dia). O cliente
// MCP real do SDK conversa com o servidor por InMemoryTransport — o mesmo caminho do stdio, sem
// processo filho. O que se trava aqui é a promessa do arquivo: nenhuma tool própria, catálogo sem
// cache, erro nunca mudo e o Bearer em todo pedido.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { criarLog, criarServidor, lerConfig } from "../server.js";

const SERVIDOR = fileURLToPath(new URL("../server.js", import.meta.url));
const TOKEN = "tk-teste-9f3a1c";
const PROMPT_MCP = "Você é o assistente do Fields'.\n\nCOMO AGIR\n- Dois ou mais → pergunte pelo NOME.";
const RESUMO = { data: "2026-10-03", reunioes: [], tarefas: [{ id: "t9", nome: "Pagar DAS", prazo: "2026-10-03" }] };

const BUSCAR_TAREFAS = {
  name: "BuscarTarefas",
  tipo: "READ",
  title: "Buscar tarefas",
  description: "Busca tarefas por texto, projeto, frente, status ou coluna.",
  input_schema: {
    type: "object",
    properties: {
      texto: { type: "string", description: "Trecho do nome ou da ação" },
      coluna: { type: "string", enum: ["A fazer", "Fazendo", "Espera", "Feito"] },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

const NOVA_TAREFA = {
  name: "NovaTarefa",
  tipo: "WRITE",
  title: "Nova tarefa",
  description: "Cria uma tarefa numa frente. Criar uma tarefa dentro de uma frente existente.",
  input_schema: {
    type: "object",
    properties: {
      frente_id: { type: "string", description: "Id da frente (use ListarProjetos)" },
      nome: { type: "string" },
      prazo: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["frente_id", "nome", "prazo"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

// ─── Backend falso ────────────────────────────────────────────────────────────────────────────

function responderJson(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(corpo));
}

async function lerCorpo(req) {
  const partes = [];
  for await (const p of req) partes.push(p);
  const texto = Buffer.concat(partes).toString("utf8");
  return texto ? JSON.parse(texto) : undefined;
}

async function subirBackend(t) {
  const estado = { ops: [BUSCAR_TAREFAS, NOVA_TAREFA], pedidos: [] };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const corpo = await lerCorpo(req);
    estado.pedidos.push({ metodo: req.method, caminho: url.pathname, busca: url.search,
      authorization: req.headers.authorization, contentType: req.headers["content-type"], corpo });

    // A guarda do A0: Bearer errado → 401 no formato {error} da A0, sem código.
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return responderJson(res, 401, { error: "nao_autenticado" });

    if (req.method === "GET" && url.pathname === "/api/ops") {
      const versao = createHash("sha256").update(JSON.stringify(estado.ops)).digest("hex");
      return responderJson(res, 200, { versao, ops: estado.ops });
    }
    // Uma operação que sumiu do backend depois de listada (deploy, flag): 404 do gargalo.
    if (req.method === "POST" && estado.desligada && url.pathname === `/api/ops/${estado.desligada}`) {
      return responderJson(res, 404, { erro: "operação indisponível", codigo: "OPERACAO_INDISPONIVEL" });
    }
    if (req.method === "POST" && url.pathname === "/api/ops/NovaTarefa") {
      if (!corpo?.nome) {
        return responderJson(res, 400, { erro: "argumentos inválidos", codigo: "ARGUMENTOS_INVALIDOS",
          campos: { nome: "obrigatório", prazo: ["formato AAAA-MM-DD", "ou null"] } });
      }
      return responderJson(res, 200, {
        resultado: { id: "t1", nome: corpo.nome, frente_id: corpo.frente_id },
        acao: { turno_id: "tr-1", idx: 0, acao: "NOVA_TAREFA", resumo: `Criou a tarefa “${corpo.nome}”`, desfazivel: true },
      });
    }
    if (req.method === "POST" && url.pathname === "/api/ops/BuscarTarefas") {
      return responderJson(res, 200, { resultado: [{ id: "t1", nome: "Ligar para o contador" }] });
    }
    if (req.method === "POST" && url.pathname === "/api/ops/ConsultarTarefa") {
      return responderJson(res, 404, { erro: "tarefa não encontrada", codigo: "NAO_ENCONTRADO" });
    }
    // As recusas da memória levam campos a mais, que a mensagem manda o modelo olhar.
    if (req.method === "POST" && url.pathname === "/api/ops/Esquecer") {
      return responderJson(res, 409, { erro: "Mais de uma linha da memória tem esse trecho — veja `candidatos` e pergunte qual.",
        codigo: "AMBIGUO", candidatos: ["a Ana só atende de manhã", "cobrar a Ana; no dia 20"] });
    }
    if (req.method === "POST" && url.pathname === "/api/ops/Lembrar") {
      return responderJson(res, 409, { erro: "A memória está cheia (20 linhas). Pergunte ao Carlos qual pode sair.",
        codigo: "MEMORIA_CHEIA", limite: 20 });
    }
    if (req.method === "POST" && url.pathname === "/api/ops/Lenta") return; // nunca responde
    if (req.method === "POST" && url.pathname.startsWith("/api/ops/")) {
      return responderJson(res, 404, { erro: "operação indisponível", codigo: "OPERACAO_INDISPONIVEL" });
    }
    if (req.method === "GET" && url.pathname === "/api/ontologia/prompt") {
      if (url.searchParams.get("canal") !== "mcp") return responderJson(res, 400, { erro: "canal inválido", codigo: "CANAL_INVALIDO" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(PROMPT_MCP);
    }
    if (req.method === "GET" && url.pathname === "/api/resumo-do-dia") return responderJson(res, 200, { resultado: RESUMO });
    return responderJson(res, 404, { error: "Not found" });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => { srv.closeAllConnections(); srv.close(ok); }));
  return { estado, apiUrl: `http://127.0.0.1:${srv.address().port}/api` };
}

/** Servidor MCP + cliente do SDK ligados em memória. `linhas` coleta o log (para o teste do token). */
async function conectar(t, opcoes) {
  const linhas = [];
  const servidor = criarServidor({ token: TOKEN, log: criarLog((l) => linhas.push(l)), ...opcoes });
  const cliente = new Client({ name: "teste", version: "0.0.0" });
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  await Promise.all([cliente.connect(doCliente), servidor.connect(doServidor)]);
  t.after(async () => { await cliente.close(); await servidor.close(); });
  return { cliente, linhas };
}

const esperado = (op) => ({ name: op.name, title: op.title, description: op.description,
  inputSchema: op.input_schema, annotations: op.annotations });

// ─── tools/list ───────────────────────────────────────────────────────────────────────────────

test("tools/list é o catálogo do backend: nomes, ordem, schema, título, descrição e anotações", async (t) => {
  const { apiUrl } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });
  const { tools } = await cliente.listTools();
  assert.deepEqual(tools, [esperado(BUSCAR_TAREFAS), esperado(NOVA_TAREFA)]);
});

test("tools/list não tem cache: AGENTE_SOMENTE_LEITURA no backend tira a WRITE na próxima listagem", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  const { cliente, linhas } = await conectar(t, { apiUrl });
  assert.deepEqual((await cliente.listTools()).tools.map((x) => x.name), ["BuscarTarefas", "NovaTarefa"]);

  estado.ops = estado.ops.filter((op) => op.tipo === "READ");
  assert.deepEqual((await cliente.listTools()).tools.map((x) => x.name), ["BuscarTarefas"]);

  assert.equal(estado.pedidos.filter((p) => p.caminho === "/api/ops").length, 2);
  const catalogos = linhas.map((l) => JSON.parse(l)).filter((l) => l.evento === "MCP_CATALOGO");
  assert.deepEqual(catalogos.map((l) => l.mudou), [false, true]);
});

test("tools/list com o backend fora do ar é ERRO, nunca uma lista vazia", async (t) => {
  const { apiUrl } = await subirBackend(t);
  const morto = http.createServer();
  await new Promise((ok) => morto.listen(0, "127.0.0.1", ok));
  const porta = morto.address().port;
  await new Promise((ok) => morto.close(ok));

  const { cliente } = await conectar(t, { apiUrl: `http://127.0.0.1:${porta}/api` });
  await assert.rejects(cliente.listTools(), /catálogo de operações.*GET \/api\/ops.*FIELDS_API_URL/s);

  // Token recusado: o erro diz qual variável conferir.
  const { cliente: outro } = await conectar(t, { apiUrl, token: "errado" });
  await assert.rejects(outro.listTools(), /HTTP_401: nao_autenticado[\s\S]*FIELDS_API_TOKEN/);
});

test("tools/list com catálogo fora do contrato falha alto e diz qual operação", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  const { cliente, linhas } = await conectar(t, { apiUrl });
  estado.ops = [BUSCAR_TAREFAS, { ...NOVA_TAREFA, input_schema: { type: "string" } }];
  await assert.rejects(cliente.listTools(), /fora do contrato.*NovaTarefa/);
  assert.ok(linhas.some((l) => JSON.parse(l).evento === "MCP_CATALOGO_INVALIDO"));
});

// ─── tools/call ───────────────────────────────────────────────────────────────────────────────

test("tools/call de escrita: repassa os argumentos e abre com a linha da ação — sem prometer desfazer", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });
  const args = { frente_id: "f1", nome: "Ligar para o contador", prazo: null };
  const r = await cliente.callTool({ name: "NovaTarefa", arguments: args });

  assert.notEqual(r.isError, true);
  const [linha1, , ...resto] = r.content[0].text.split("\n");
  // O backend manda desfazivel:true, mas o desfazer por turno não está ao alcance deste canal:
  // anunciar "(desfazível)" fazia o modelo prometer uma volta que o Carlos não tem.
  assert.equal(linha1, "Ação registrada: Criou a tarefa “Ligar para o contador”");
  assert.doesNotMatch(r.content[0].text, /desfaz|tr-1/i, "nem a promessa, nem o turno_id que o canal não usa");
  assert.deepEqual(JSON.parse(resto.join("\n")), { id: "t1", nome: "Ligar para o contador", frente_id: "f1" });

  const post = estado.pedidos.find((p) => p.caminho === "/api/ops/NovaTarefa");
  assert.deepEqual(post.corpo, args);
  assert.match(post.contentType, /^application\/json/);
});

test("tools/call de leitura: só o resultado, sem linha de ação; sem argumentos manda {}", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });
  const r = await cliente.callTool({ name: "BuscarTarefas" });
  assert.notEqual(r.isError, true);
  assert.doesNotMatch(r.content[0].text, /Ação registrada/);
  assert.deepEqual(JSON.parse(r.content[0].text), [{ id: "t1", nome: "Ligar para o contador" }]);
  assert.deepEqual(estado.pedidos.at(-1).corpo, {});
});

test("tools/call com 400 vira isError com o código e os campos", async (t) => {
  const { apiUrl } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });
  const r = await cliente.callTool({ name: "NovaTarefa", arguments: { frente_id: "f1" } });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text,
    "ARGUMENTOS_INVALIDOS: argumentos inválidos\nCampos:\n- nome: obrigatório\n- prazo: formato AAAA-MM-DD; ou null");
});

test("tools/call com recusa de domínio (404 NAO_ENCONTRADO) vira isError com o código", async (t) => {
  const { apiUrl } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });
  const r = await cliente.callTool({ name: "ConsultarTarefa", arguments: { id: "nao-existe" } });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "NAO_ENCONTRADO: tarefa não encontrada");
});

test("tools/call com 409 AMBIGUO leva os candidatos ao modelo; MEMORIA_CHEIA leva o limite", async (t) => {
  const { apiUrl } = await subirBackend(t);
  const { cliente, linhas } = await conectar(t, { apiUrl });

  const ambiguo = await cliente.callTool({ name: "Esquecer", arguments: { trecho: "Ana" } });
  assert.equal(ambiguo.isError, true);
  assert.equal(ambiguo.content[0].text,
    "AMBIGUO: Mais de uma linha da memória tem esse trecho — veja `candidatos` e pergunte qual.\n" +
    "Detalhes:\n" +
    '- candidatos: ["a Ana só atende de manhã","cobrar a Ana; no dia 20"]');
  // O "; " dentro de um candidato não se confunde com a separação entre eles: vai em JSON.
  const lista = JSON.parse(ambiguo.content[0].text.split("- candidatos: ")[1]);
  assert.deepEqual(lista, ["a Ana só atende de manhã", "cobrar a Ana; no dia 20"]);

  const cheia = await cliente.callTool({ name: "Lembrar", arguments: { texto: "x" } });
  assert.equal(cheia.isError, true);
  assert.match(cheia.content[0].text, /^MEMORIA_CHEIA: .*\nDetalhes:\n- limite: 20$/);

  // Os candidatos são texto do Carlos: vão ao modelo, nunca ao log.
  for (const l of linhas) assert.doesNotMatch(l, /Ana/);
});

test("tools/call de operação que sumiu depois de listada: isError OPERACAO_INDISPONIVEL e aviso de lista mudada", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });
  let avisos = 0;
  cliente.setNotificationHandler(ToolListChangedNotificationSchema, () => { avisos++; });
  const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

  // Nunca listada: engano do cliente, a lista dele não mudou — erro, mas sem aviso.
  const r1 = await cliente.callTool({ name: "ExcluirProjeto", arguments: { id: "p1" } });
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /^OPERACAO_INDISPONIVEL: /);
  await espera(300);
  assert.equal(avisos, 0, "nome que nunca esteve no catálogo não dispara list_changed");

  // Listada e depois desligada no backend: aí a lista mudou de verdade.
  await cliente.listTools();
  estado.desligada = "NovaTarefa";
  const r2 = await cliente.callTool({ name: "NovaTarefa", arguments: { frente_id: "f1", nome: "X", prazo: null } });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /^OPERACAO_INDISPONIVEL: /);
  for (let i = 0; i < 20 && avisos === 0; i++) await espera(100);
  assert.equal(avisos, 1);
});

test("tools/call com nome que escaparia de /ops/:name é recusada SEM ir ao backend", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });
  for (const name of ["..", "../entries", "NovaTarefa/../../projects", "Nova Tarefa", "%2e%2e"]) {
    const r = await cliente.callTool({ name, arguments: {} });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /^OPERACAO_INDISPONIVEL: /, name);
  }
  assert.equal(estado.pedidos.length, 0);
});

test("tools/call sem rede vira isError API_INALCANCAVEL", async (t) => {
  const falhar = async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); };
  const { cliente, linhas } = await conectar(t, { apiUrl: "http://127.0.0.1:9/api", fetch: falhar });
  const r = await cliente.callTool({ name: "BuscarTarefas", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^API_INALCANCAVEL: sem resposta de http:\/\/127\.0\.0\.1:9/);
  const falha = linhas.map((l) => JSON.parse(l)).find((l) => l.evento === "MCP_API_FALHA");
  assert.equal(falha.motivo, "REDE");
  assert.equal(falha.causa, "ECONNREFUSED");
});

test("tools/call que estoura o prazo avisa que a escrita pode ter acontecido", async (t) => {
  const { apiUrl } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl, timeoutMs: 150 });
  const r = await cliente.callTool({ name: "Lenta", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^TEMPO_ESGOTADO: .*pode ter sido executada/);
});

// ─── resources e prompt ───────────────────────────────────────────────────────────────────────

test("resources: fields://ontologia é o prompt do canal mcp; fields://resumo-do-dia é o resultado", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });

  const { resources } = await cliente.listResources();
  assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]),
    [["fields://ontologia", "text/plain"], ["fields://resumo-do-dia", "application/json"]]);

  const ont = await cliente.readResource({ uri: "fields://ontologia" });
  assert.deepEqual(ont.contents, [{ uri: "fields://ontologia", mimeType: "text/plain", text: PROMPT_MCP }]);
  assert.equal(estado.pedidos.at(-1).busca, "?canal=mcp");

  const resumo = await cliente.readResource({ uri: "fields://resumo-do-dia" });
  assert.equal(resumo.contents[0].mimeType, "application/json");
  assert.deepEqual(JSON.parse(resumo.contents[0].text), RESUMO);
  assert.equal(estado.pedidos.at(-1).busca, "", "sem ?data: o 'hoje' é do backend");

  await assert.rejects(cliente.readResource({ uri: "fields://overview" }), /Recurso desconhecido/);
});

test("prompt assistente-fields devolve o texto do backend como mensagem do usuário", async (t) => {
  const { apiUrl } = await subirBackend(t);
  const { cliente } = await conectar(t, { apiUrl });
  const { prompts } = await cliente.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ["assistente-fields"]);

  const p = await cliente.getPrompt({ name: "assistente-fields" });
  assert.deepEqual(p.messages, [{ role: "user", content: { type: "text", text: PROMPT_MCP } }]);
  await assert.rejects(cliente.getPrompt({ name: "outro" }), /Prompt desconhecido/);
});

// ─── Bearer e segredo ─────────────────────────────────────────────────────────────────────────

test("o Bearer vai em TODO pedido, e o token nunca aparece no log", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  const { cliente, linhas } = await conectar(t, { apiUrl });
  await cliente.listTools();
  await cliente.callTool({ name: "BuscarTarefas", arguments: {} });
  await cliente.callTool({ name: "NovaTarefa", arguments: { frente_id: "f1", nome: "X", prazo: null } });
  await cliente.callTool({ name: "NovaTarefa", arguments: {} });
  await cliente.readResource({ uri: "fields://ontologia" });
  await cliente.readResource({ uri: "fields://resumo-do-dia" });
  await cliente.getPrompt({ name: "assistente-fields" });

  assert.equal(estado.pedidos.length, 7);
  for (const p of estado.pedidos) assert.equal(p.authorization, `Bearer ${TOKEN}`, `${p.metodo} ${p.caminho}`);
  assert.ok(linhas.length >= 7);
  for (const l of linhas) {
    assert.doesNotMatch(l, new RegExp(TOKEN));
    assert.doesNotMatch(l, /Ligar para o contador|"X"/, "argumento de tool não entra no log");
  }
});

// ─── Configuração ─────────────────────────────────────────────────────────────────────────────

test("lerConfig: recusa com motivo, exige https fora de localhost e normaliza a barra final", () => {
  assert.equal(lerConfig({}).motivo, "API_URL_AUSENTE");
  assert.equal(lerConfig({ FIELDS_API_URL: "nada", FIELDS_API_TOKEN: TOKEN }).motivo, "API_URL_INVALIDA");
  assert.equal(lerConfig({ FIELDS_API_URL: "ftp://x/api", FIELDS_API_TOKEN: TOKEN }).motivo, "API_URL_INVALIDA");
  assert.equal(lerConfig({ FIELDS_API_URL: "http://exemplo.com/api", FIELDS_API_TOKEN: TOKEN }).motivo, "API_URL_SEM_TLS");
  assert.equal(lerConfig({ FIELDS_API_URL: "https://exemplo.com/api" }).motivo, "TOKEN_AUSENTE");
  assert.equal(lerConfig({ FIELDS_API_URL: "https://exemplo.com/api", FIELDS_API_TOKEN: "  " }).motivo, "TOKEN_AUSENTE");
  assert.deepEqual(lerConfig({ FIELDS_API_URL: "https://exemplo.com/api/", FIELDS_API_TOKEN: TOKEN }),
    { ok: true, valor: { apiUrl: "https://exemplo.com/api", token: TOKEN } });
  assert.equal(lerConfig({ FIELDS_API_URL: "http://localhost:3001/api", FIELDS_API_TOKEN: TOKEN }).ok, true);
  assert.doesNotMatch(lerConfig({ FIELDS_API_URL: "http://exemplo.com/api", FIELDS_API_TOKEN: TOKEN }).mensagem,
    new RegExp(TOKEN));
});

function rodar(env) {
  const base = { ...process.env };
  delete base.FIELDS_API_URL;
  delete base.FIELDS_API_TOKEN;
  return spawnSync(process.execPath, [SERVIDOR], { env: { ...base, ...env }, input: "", encoding: "utf8", timeout: 15_000 });
}

test("executado sem as variáveis, o processo sai com 1 e diz qual falta — sem imprimir o token", () => {
  const semUrl = rodar({ FIELDS_API_TOKEN: TOKEN });
  assert.equal(semUrl.status, 1);
  assert.match(semUrl.stderr, /"evento":"MCP_CONFIG_RECUSA".*"motivo":"API_URL_AUSENTE".*FIELDS_API_URL/);
  assert.doesNotMatch(semUrl.stderr + semUrl.stdout, new RegExp(TOKEN));

  const semToken = rodar({ FIELDS_API_URL: "https://exemplo.com/api" });
  assert.equal(semToken.status, 1);
  assert.match(semToken.stderr, /"motivo":"TOKEN_AUSENTE".*FIELDS_API_TOKEN/);
  assert.equal(semToken.stdout, "", "stdout é do JSON-RPC");
});

test("ponta a ponta pelo stdio: o processo real lista o catálogo e executa uma operação", async (t) => {
  const { apiUrl, estado } = await subirBackend(t);
  // env explícito: o transporte do SDK herda só o ambiente mínimo, então nenhum FIELDS_* da máquina vaza.
  const transporte = new StdioClientTransport({ command: process.execPath, args: [SERVIDOR],
    env: { FIELDS_API_URL: apiUrl, FIELDS_API_TOKEN: TOKEN }, stderr: "pipe" });
  const cliente = new Client({ name: "teste-stdio", version: "0.0.0" });
  await cliente.connect(transporte);
  t.after(() => cliente.close());

  assert.deepEqual((await cliente.listTools()).tools, [esperado(BUSCAR_TAREFAS), esperado(NOVA_TAREFA)]);
  const r = await cliente.callTool({ name: "NovaTarefa", arguments: { frente_id: "f1", nome: "Y", prazo: null } });
  assert.match(r.content[0].text, /^Ação registrada: Criou a tarefa “Y”\n/);
  assert.ok(estado.pedidos.every((p) => p.authorization === `Bearer ${TOKEN}`));
});

test("executado com config válida, sobe no stdio, loga MCP_INICIO no stderr e sai quando o stdin fecha", () => {
  const r = rodar({ FIELDS_API_URL: "http://127.0.0.1:9/api", FIELDS_API_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /"evento":"MCP_INICIO"/);
  assert.equal(r.stdout, "");
  assert.doesNotMatch(r.stderr, new RegExp(TOKEN));
});
