// A API do chat (rotas/agente.js) — o contrato FIXO que a Home (R3) consome — sem banco e sem a API
// da Anthropic: criarApp recebe `motor` com o modelo de roteiro, a loja em memória e o executor de
// teste. O que cada rota responde, com que status e em que forma; o comportamento do motor por trás
// está em motor.test.js, e contra Postgres em motor_integracao.test.js.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { criarApp } from "../src/app.js";
import { carregarConfig } from "../src/config.js";
import { emitirCookieSessao, gerarHashSenha } from "../src/auth/sessao.js";
import { definirSaida } from "../src/lib/log.js";
import { ferramenta, modeloFalso, texto } from "./fakes/modeloFalso.js";
import { executorFalso, lojaEmMemoria } from "./fakes/lojaEmMemoria.js";

const TOKEN = "token-do-mcp-de-teste-0123456789abcdef";
const BASE_ENV = {
  DATABASE_URL: "postgres://nao-usado",
  FIELDS_SENHA_HASH: await gerarHashSenha("senha"),
  FIELDS_SEGREDO_SESSAO: "segredo-de-sessao-de-teste-0123456789",
  FIELDS_API_TOKEN: TOKEN,
};
const LIGADO = carregarConfig({ ...BASE_ENV, AGENTE_HABILITADO: "true", ANTHROPIC_API_KEY: "sk-ant-teste-nao-usada" });
const DESLIGADO = carregarConfig(BASE_ENV);
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });

/** db que falha se for tocado: a API do chat, com o motor injetado, não fala com o banco direto. */
function dbIntocado() {
  const chamadas = [];
  const query = async (sql) => { chamadas.push(sql); return { rows: [], rowCount: 0 }; };
  return { chamadas, query, connect: async () => ({ query, release() {} }) };
}

async function subir({ config = LIGADO, roteiro = [], respostas = {}, desfazer } = {}) {
  const db = dbIntocado();
  const loja = lojaEmMemoria();
  const cliente = modeloFalso(roteiro);
  const ex = executorFalso(loja, respostas);
  const motor = {
    cliente, loja, executar: ex.executar,
    desfazer: desfazer ?? (async () => ({ ok: false, motivo: "NADA_A_DESFAZER" })),
  };
  const app = criarApp({ config, db, estado: { comentariosMigrados: true }, motor });
  const servidor = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const chamar = async (metodo, caminho, corpo, headers = H) => {
    const res = await fetch(base + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const t = await res.text();
    return { status: res.status, json: t ? JSON.parse(t) : undefined };
  };
  /** Consulta o turno até ele sair de EM_ANDAMENTO — o que a tela faz a cada segundo. */
  const esperar = async (turnoId) => {
    for (let i = 0; i < 200; i++) {
      const r = await chamar("GET", `/api/agente/turnos/${turnoId}`);
      if (r.json?.status !== "EM_ANDAMENTO") return r;
      await new Promise((ok) => setTimeout(ok, 5));
    }
    throw new Error("o turno não terminou");
  };
  return { db, loja, cliente, ex, chamar, esperar, fechar: () => new Promise((ok) => servidor.close(ok)) };
}

const CHAVES_DO_TURNO = ["acoes", "concluido_em", "criado_em", "entrada", "motivo", "progresso", "sessao_id", "status", "texto", "turno_id"];

test("desligado: POST /api/agente/chat → 503 AGENTE_DESLIGADO (antes de validar o corpo), sem tocar banco nem modelo", async () => {
  const s = await subir({ config: DESLIGADO });
  try {
    for (const corpo of [{ texto: "oi" }, { lixo: 1 }]) {
      const r = await s.chamar("POST", "/api/agente/chat", corpo);
      assert.equal(r.status, 503);
      assert.deepEqual(Object.keys(r.json).sort(), ["codigo", "erro"]);
      assert.equal(r.json.codigo, "AGENTE_DESLIGADO");
    }
    assert.deepEqual([s.db.chamadas.length, s.cliente.chamadas.length, s.loja.turnos.size], [0, 0, 0]);
    await new Promise((ok) => setImmediate(ok));
    assert.equal(logs.find((l) => l.evento === "HTTP_REQ").motivo, "AGENTE_DESLIGADO");
  } finally { await s.fechar(); }
});

test("POST /chat → 202 {turno_id}; GET /turnos/:id → o turno no contrato, com as ações e o progresso", async () => {
  const s = await subir({
    roteiro: [{ content: [ferramenta("NovaTarefa", { frente_id: "f1", nome: "Revisar deck" })] }, { content: [texto("Criei a tarefa.")] }],
    respostas: {
      NovaTarefa: {
        resultado: { tarefa_id: "t1" },
        acao: { tool: "NovaTarefa", acao: "NOVA_TAREFA", resumo: "Criou a tarefa “Revisar deck”", desfazivel: true, inverso: "EXCLUIR" },
      },
    },
  });
  try {
    const r = await s.chamar("POST", "/api/agente/chat", { texto: "cria revisar deck", contexto: { tarefa_id: "abc-123" } });
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(r.json), ["turno_id"]);
    const t = await s.esperar(r.json.turno_id);
    assert.equal(t.status, 200);
    assert.deepEqual(Object.keys(t.json).sort(), CHAVES_DO_TURNO);
    assert.deepEqual(
      [t.json.turno_id, t.json.status, t.json.motivo, t.json.texto, t.json.entrada, t.json.progresso],
      [r.json.turno_id, "CONCLUIDO", null, "Criei a tarefa.", "cria revisar deck", { n_tools: 1 }]);
    assert.deepEqual(t.json.acoes, [{ idx: 0, acao: "NOVA_TAREFA", resumo: "Criou a tarefa “Revisar deck”", desfazivel: true, desfeito_em: null }]);
    assert.match(s.cliente.chamadas[0].corpo.messages[0].content[0].text, /tarefa_aberta="abc-123"/);
    assert.equal(s.db.chamadas.length, 0);
  } finally { await s.fechar(); }
});

test("enquanto roda: GET /turnos/:id responde EM_ANDAMENTO, texto nulo, e o n_tools do momento", async () => {
  let soltar;
  const trava = new Promise((ok) => { soltar = ok; });
  const s = await subir({ roteiro: [{ content: [ferramenta("ListarProjetos")] }, async () => { await trava; return { content: [texto("Pronto.")] }; }] });
  try {
    const { json: { turno_id } } = await s.chamar("POST", "/api/agente/chat", { texto: "lista" });
    let r;
    for (let i = 0; i < 100; i++) {
      r = await s.chamar("GET", `/api/agente/turnos/${turno_id}`);
      if (r.json.progresso.n_tools === 1) break;
      await new Promise((ok) => setTimeout(ok, 5));
    }
    assert.deepEqual([r.json.status, r.json.texto, r.json.progresso], ["EM_ANDAMENTO", null, { n_tools: 1 }]);
    soltar();
    assert.equal((await s.esperar(turno_id)).json.status, "CONCLUIDO");
  } finally { soltar(); await s.fechar(); }
});

test("'desfazer' no chat → 200 síncrono com o turno e o `desfazer`, sem chamar o modelo", async () => {
  const s = await subir({
    roteiro: [{ content: [ferramenta("NovaTarefa", {})] }, { content: [texto("Criei.")] }],
    respostas: { NovaTarefa: { resultado: { tarefa_id: "t1" }, acao: { tool: "NovaTarefa", acao: "NOVA_TAREFA", resumo: "Criou a tarefa “X”", desfazivel: true } } },
    desfazer: async () => ({ ok: true, valor: { desfeitas: [{ idx: 0, resumo: "Criou a tarefa “X”" }] } }),
  });
  try {
    const criou = await s.chamar("POST", "/api/agente/chat", { texto: "cria X" });
    await s.esperar(criou.json.turno_id);
    const antes = s.cliente.chamadas.length;
    const r = await s.chamar("POST", "/api/agente/chat", { texto: "Desfazer" });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), [...CHAVES_DO_TURNO, "desfazer"].sort());
    assert.deepEqual([r.json.status, r.json.texto], ["CONCLUIDO", "Desfeito: Criou a tarefa “X”."]);
    assert.deepEqual(r.json.desfazer, { turno_id: criou.json.turno_id, desfeitas: [{ idx: 0, resumo: "Criou a tarefa “X”" }] });
    assert.equal(s.cliente.chamadas.length, antes, "zero chamadas ao modelo");
  } finally { await s.fechar(); }
});

test("corpo inválido → 400 ARGUMENTOS_INVALIDOS com os campos; turno inexistente → 404", async () => {
  const s = await subir();
  try {
    const casos = [
      [{}, ["texto"]],
      [{ texto: "   " }, ["texto"]],
      [{ texto: "oi", extra: 1 }, ["extra"]],
      [{ texto: "oi", contexto: { tarefa_id: 'x" onload="' } }, ["contexto.tarefa_id"]],
      [{ texto: "oi", contexto: { tarefa_id: "t1", outro: 1 } }, ["contexto.outro"]],
      [{ texto: "x".repeat(10_001) }, ["texto"]],
    ];
    for (const [corpo, campos] of casos) {
      const r = await s.chamar("POST", "/api/agente/chat", corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo).slice(0, 60));
      assert.equal(r.json.codigo, "ARGUMENTOS_INVALIDOS");
      assert.deepEqual(Object.keys(r.json.campos).sort(), campos);
    }
    assert.equal(s.loja.turnos.size, 0, "nenhum turno aberto");
    const sumido = await s.chamar("GET", "/api/agente/turnos/nao-existe");
    assert.deepEqual([sumido.status, sumido.json.codigo], [404, "NAO_ENCONTRADO"]);
  } finally { await s.fechar(); }
});

test("GET /conversa → {turnos} do canal, do mais antigo ao mais novo, com limite; canal e limite validados", async () => {
  const s = await subir({ roteiro: [{ content: [texto("Um.")] }, { content: [texto("Dois.")] }, { content: [texto("Três.")] }] });
  try {
    for (const t of ["um", "dois", "três"]) await s.esperar((await s.chamar("POST", "/api/agente/chat", { texto: t })).json.turno_id);
    const todos = await s.chamar("GET", "/api/agente/conversa");
    assert.equal(todos.status, 200);
    assert.deepEqual(Object.keys(todos.json), ["turnos"]);
    assert.deepEqual(todos.json.turnos.map((t) => [t.entrada, t.texto]), [["um", "Um."], ["dois", "Dois."], ["três", "Três."]]);
    for (const t of todos.json.turnos) assert.deepEqual(Object.keys(t).sort(), CHAVES_DO_TURNO);
    const dois = await s.chamar("GET", "/api/agente/conversa?canal=web&limite=2");
    assert.deepEqual(dois.json.turnos.map((t) => t.entrada), ["dois", "três"]);
    assert.deepEqual((await s.chamar("GET", "/api/agente/conversa?canal=whatsapp")).json, { turnos: [] });
    for (const q of ["canal=mcp", "canal=sms", "limite=0", "limite=101", "limite=abc"]) {
      const r = await s.chamar("GET", `/api/agente/conversa?${q}`);
      assert.deepEqual([r.status, r.json.codigo], [400, "ARGUMENTOS_INVALIDOS"], q);
    }
  } finally { await s.fechar(); }
});

test("POST /nova-conversa → {encerrada}; a próxima mensagem abre sessão nova", async () => {
  const s = await subir({ roteiro: [{ content: [texto("Um.")] }, { content: [texto("Dois.")] }] });
  try {
    assert.deepEqual((await s.chamar("POST", "/api/agente/nova-conversa", {})).json, { encerrada: false }, "sem sessão ainda");
    await s.esperar((await s.chamar("POST", "/api/agente/chat", { texto: "um" })).json.turno_id);
    assert.deepEqual((await s.chamar("POST", "/api/agente/nova-conversa", { canal: "web" })).json, { encerrada: true });
    await s.esperar((await s.chamar("POST", "/api/agente/chat", { texto: "dois" })).json.turno_id);
    assert.deepEqual(s.loja.sessoes.map((x) => [x.status, x.motivo]), [["ENCERRADA", "PEDIDO"], ["ATIVA", null]]);
    const ruim = await s.chamar("POST", "/api/agente/nova-conversa", { canal: "mcp" });
    assert.deepEqual([ruim.status, ruim.json.codigo], [400, "ARGUMENTOS_INVALIDOS"]);
  } finally { await s.fechar(); }
});

test("pela tela (cookie): o chat funciona com o JSON de sempre, e sem JSON é 415 (a guarda de CSRF)", async () => {
  const s = await subir({ roteiro: [{ content: [texto("Oi.")] }] });
  try {
    const cookie = `fields_s=${emitirCookieSessao(LIGADO.segredoSessao)}`;
    const r = await s.chamar("POST", "/api/agente/chat", { texto: "oi" }, { Cookie: cookie, "Content-Type": "application/json" });
    assert.equal(r.status, 202);
    assert.equal((await s.esperar(r.json.turno_id)).json.texto, "Oi.");
    const semJson = await s.chamar("POST", "/api/agente/chat", { texto: "oi" }, { Cookie: cookie, "Content-Type": "text/plain" });
    assert.equal(semJson.status, 415);
  } finally { await s.fechar(); }
});
