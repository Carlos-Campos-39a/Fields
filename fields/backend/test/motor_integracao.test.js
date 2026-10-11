// Integração da A2b (motor + canal web) contra Postgres REAL, com o modelo de roteiro no lugar da
// API. Pula sem TEST_DATABASE_URL, como as outras integrações — e usa o mesmo desenho: um schema por
// teste, initDB nele, app no ar, schema apagado no fim.
//
//   TEST_DATABASE_URL=postgres://u:p@localhost:5432/fields_teste npm test
//
// O que só o banco prova: o SQL das sessões e dos turnos; o histórico gravado como TEXT volta byte a
// byte (o invariante de prefixo atravessando o Postgres); a escrita do agente com origem 'agente' e a
// ação no turno do chat; o "desfazer" pelo chat; a renovação por prompt_versao; a recuperação no boot;
// e o índice de uma sessão ativa por canal.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { criarApp } from "../src/app.js";
import { carregarConfig } from "../src/config.js";
import { emitirCookieSessao, gerarHashSenha } from "../src/auth/sessao.js";
import { initDB } from "../src/db/schema.js";
import { promptVersao } from "../src/agente/sessoes.js";
import { TEXTO_FALHA } from "../src/servicos/turnos.js";
import { definirSaida } from "../src/lib/log.js";
import { ferramenta, modeloFalso, pensamento, texto } from "./fakes/modeloFalso.js";

const URL_TESTE = process.env.TEST_DATABASE_URL;
const skip = URL_TESTE ? false : "TEST_DATABASE_URL não definida (integração com Postgres real)";
const SSL = process.env.TEST_DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
const TOKEN = "token-de-integracao-0123456789abcdef";

let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });

let configCache;
async function config() {
  configCache ??= carregarConfig({
    DATABASE_URL: URL_TESTE ?? "postgres://nao-usado",
    FIELDS_SENHA_HASH: await gerarHashSenha("senha de integração"),
    FIELDS_SEGREDO_SESSAO: "segredo-de-sessao-de-integracao-0123456789",
    FIELDS_API_TOKEN: TOKEN,
    AGENTE_HABILITADO: "true",
    ANTHROPIC_API_KEY: "sk-ant-integracao-nao-usada",
  });
  return configCache;
}

async function comAdmin(fn) {
  const c = new pg.Client({ connectionString: URL_TESTE, ssl: SSL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Um schema novo, o app no ar com o modelo de roteiro, e tudo apagado no fim. */
async function cenario(roteiro, fn) {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  await comAdmin((c) => c.query(`CREATE SCHEMA ${schema}`));
  const pool = new pg.Pool({
    connectionString: URL_TESTE, ssl: SSL, max: 4,
    options: `-c TimeZone=America/Sao_Paulo -c search_path=${schema}`,
  });
  pool.on("error", () => {});
  try {
    const estado = await initDB(pool);
    const cliente = modeloFalso(roteiro);
    const app = criarApp({ config: await config(), db: pool, estado, motor: { cliente } });
    const servidor = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
    const base = `http://127.0.0.1:${servidor.address().port}`;
    const cookie = `fields_s=${emitirCookieSessao((await config()).segredoSessao)}`;
    /** Bearer (origem mcp) por padrão; {web:true} usa o cookie da tela (origem web). */
    const chamar = async (metodo, caminho, body, { web = false } = {}) => {
      const headers = web ? { Cookie: cookie } : { Authorization: `Bearer ${TOKEN}` };
      if (metodo !== "GET") headers["Content-Type"] = "application/json";
      const res = await fetch(base + caminho, { method: metodo, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const t = await res.text();
      return { status: res.status, json: t ? JSON.parse(t) : undefined };
    };
    const esperar = async (turnoId) => {
      for (let i = 0; i < 400; i++) {
        const r = await chamar("GET", `/api/agente/turnos/${turnoId}`);
        if (r.json?.status !== "EM_ANDAMENTO") return r.json;
        await new Promise((ok) => setTimeout(ok, 10));
      }
      throw new Error("o turno não terminou");
    };
    const falar = async (t) => {
      const r = await chamar("POST", "/api/agente/chat", { texto: t });
      if (r.status === 200) return r.json; // o "desfazer"
      assert.equal(r.status, 202, JSON.stringify(r.json));
      return esperar(r.json.turno_id);
    };
    try {
      await fn({ chamar, falar, esperar, pool, cliente, estado });
    } finally { await new Promise((ok) => servidor.close(ok)); }
  } finally {
    await pool.end();
    await comAdmin((c) => c.query(`DROP SCHEMA ${schema} CASCADE`));
  }
}

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json)); return r.json; };

async function frente(chamar) {
  const p = ok(await chamar("POST", "/api/ops/NovoProjeto", { nome: "McKinsey" })).resultado;
  return ok(await chamar("POST", "/api/ops/NovaFrente", { projeto_id: p.projeto_id, nome: "Cobrança" })).resultado;
}

async function mensagensDe(pool, sessaoId) {
  const { rows } = await pool.query("SELECT seq, role, content, turno_id FROM agente_mensagens WHERE sessao_id = $1 ORDER BY seq", [sessaoId]);
  return rows;
}

// ─── O turno inteiro, pelo banco ───

test("chat → 202 → CONCLUIDO com a ação; escrita com origem agente no turno do chat; histórico gravado como o JSON exato", { skip }, async () => {
  let f;
  const roteiro = [
    () => ({ content: [pensamento("sig-1"), ferramenta("NovaTarefa", { frente_id: f.frente_id, nome: "Revisar deck" }, "toolu_1")] }),
    { content: [pensamento("sig-2"), texto("Criei a tarefa Revisar deck na frente Cobrança.")] },
    { content: [texto("Vence quando você quiser.")] },
  ];
  await cenario(roteiro, async ({ chamar, falar, pool, cliente }) => {
    f = await frente(chamar);
    const t = await falar("cria a tarefa revisar deck na cobrança");
    assert.deepEqual([t.status, t.texto, t.progresso], ["CONCLUIDO", "Criei a tarefa Revisar deck na frente Cobrança.", { n_tools: 1 }]);
    assert.deepEqual(t.acoes.map((a) => [a.idx, a.acao, a.desfazivel]), [[0, "NOVA_TAREFA", true]]);

    const { rows: [turno] } = await pool.query("SELECT canal, status, sessao_id, metricas, concluido_em, entrada FROM agente_turnos WHERE id = $1", [t.turno_id]);
    assert.deepEqual([turno.canal, turno.status, turno.entrada], ["web", "CONCLUIDO", "cria a tarefa revisar deck na cobrança"]);
    assert.ok(turno.concluido_em instanceof Date);
    assert.deepEqual([turno.metricas.chamadas, turno.metricas.n_tools], [2, 1]);

    const { rows: [tarefa] } = await pool.query("SELECT id FROM tasks WHERE name = 'Revisar deck'");
    const { rows: eventos } = await pool.query("SELECT acao, origem, turno_id FROM historico WHERE entidade_tipo = 'TAREFA' AND entidade_id = $1", [tarefa.id]);
    assert.deepEqual(eventos.map((e) => [e.acao, e.origem, e.turno_id]), [["CRIADO", "agente", t.turno_id]]);

    // O histórico: 4 mensagens, cada content é o JSON.stringify do que foi mandado/recebido.
    const msgs = await mensagensDe(pool, turno.sessao_id);
    assert.deepEqual(msgs.map((m) => [m.seq, m.role, m.turno_id]), [[0, "user", t.turno_id], [1, "assistant", t.turno_id], [2, "user", t.turno_id], [3, "assistant", t.turno_id]]);
    const segunda = cliente.chamadas[1].corpo.messages;
    for (let i = 0; i < 3; i++) assert.equal(msgs[i].content, JSON.stringify(segunda[i].content), `mensagem ${i}`);
    assert.equal(typeof msgs[0].content, "string", "TEXT, não jsonb");

    // O 2º turno manda o histórico RELIDO do banco: prefixo exato do que foi mandado antes.
    await falar("e quando vence?");
    const terceira = cliente.chamadas[2].corpo.messages;
    assert.equal(JSON.stringify(terceira.slice(0, segunda.length)), JSON.stringify(segunda));
    assert.equal(JSON.stringify(terceira[3].content), msgs[3].content);
    assert.equal(cliente.restantes, 0);
    const { rows: [sessao] } = await pool.query("SELECT status, n_mensagens, prompt_versao, modelo FROM agente_sessoes WHERE id = $1", [turno.sessao_id]);
    assert.deepEqual([sessao.status, sessao.n_mensagens, sessao.prompt_versao, sessao.modelo], ["ATIVA", 6, promptVersao("web"), "claude-opus-5-5"]);
  });
});

test("'desfazer' pelo chat: reverte o último turno com ação, sem modelo; o par entra no histórico; de novo → nada a desfazer", { skip }, async () => {
  let f;
  const roteiro = [
    () => ({ content: [ferramenta("NovaTarefa", { frente_id: f.frente_id, nome: "Por engano" })] }),
    { content: [texto("Criei.")] },
  ];
  await cenario(roteiro, async ({ chamar, falar, pool, cliente }) => {
    f = await frente(chamar);
    const criou = await falar("cria por engano");
    const r = await falar("desfazer");
    assert.equal(cliente.chamadas.length, 2, "o desfazer não chamou o modelo");
    assert.deepEqual([r.status, r.motivo, r.desfazer.turno_id, r.desfazer.desfeitas.length], ["CONCLUIDO", null, criou.turno_id, 1]);
    const { rows: [tarefa] } = await pool.query("SELECT deleted_at FROM tasks WHERE name = 'Por engano'");
    assert.ok(tarefa.deleted_at instanceof Date);
    const depois = ok(await chamar("GET", `/api/agente/turnos/${criou.turno_id}`));
    assert.ok(depois.acoes[0].desfeito_em, "o chip fica riscado");
    const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM agente_mensagens");
    assert.equal(n, 6, "4 do turno + o par do desfazer");

    const deNovo = await falar("desfaz");
    assert.deepEqual([deNovo.motivo, deNovo.desfazer], ["NADA_A_DESFAZER", null]);
  });
});

test("renovação por prompt_versao: a sessão com versão velha encerra e a próxima abre outra — e só uma fica ATIVA", { skip }, async () => {
  await cenario([{ content: [texto("Um.")] }, { content: [texto("Dois.")] }], async ({ falar, pool }) => {
    const um = await falar("um");
    await pool.query("UPDATE agente_sessoes SET prompt_versao = 'velha'");
    const dois = await falar("dois");
    assert.notEqual(dois.sessao_id, um.sessao_id);
    const { rows } = await pool.query("SELECT id, status, motivo FROM agente_sessoes ORDER BY criado_em");
    assert.deepEqual(rows.map((s) => [s.status, s.motivo]), [["ENCERRADA", "PROMPT_VERSAO"], ["ATIVA", null]]);
    assert.equal(logs.find((l) => l.evento === "AGENTE_SESSAO_NOVA" && l.motivo === "PROMPT_VERSAO")?.canal, "web");
    // O índice único parcial: uma segunda ATIVA no mesmo canal não entra.
    await assert.rejects(
      pool.query("INSERT INTO agente_sessoes (id, canal, prompt_versao, modelo) VALUES ('x', 'web', 'v', 'm')"),
      (err) => err.code === "23505"
    );
  });
});

test("nova conversa e conversa: encerra a ativa (PEDIDO); a conversa lista os turnos do canal em ordem", { skip }, async () => {
  await cenario([{ content: [texto("Um.")] }, { content: [texto("Dois.")] }], async ({ chamar, falar, pool }) => {
    await falar("um");
    assert.deepEqual(ok(await chamar("POST", "/api/agente/nova-conversa", {})), { encerrada: true });
    await falar("dois");
    const { rows } = await pool.query("SELECT motivo FROM agente_sessoes ORDER BY criado_em");
    assert.deepEqual(rows.map((s) => s.motivo), ["PEDIDO", null]);
    const conversa = ok(await chamar("GET", "/api/agente/conversa?limite=10"));
    assert.deepEqual(conversa.turnos.map((t) => [t.entrada, t.texto, t.status]), [["um", "Um.", "CONCLUIDO"], ["dois", "Dois.", "CONCLUIDO"]]);
  });
});

test("recuperação no boot: EM_ANDAMENTO há mais de 5 min vira FALHOU/REINICIO; o recente fica", { skip }, async () => {
  await cenario([], async ({ pool }) => {
    await pool.query(
      `INSERT INTO agente_turnos (id, canal, status, entrada, criado_em, concluido_em) VALUES
         ('velho', 'web', 'EM_ANDAMENTO', 'x', NOW() - interval '10 minutes', NULL),
         ('novo', 'web', 'EM_ANDAMENTO', 'y', NOW() - interval '1 minute', NULL)`
    );
    await initDB(pool); // o boot de novo (idempotente)
    const { rows } = await pool.query("SELECT id, status, motivo, resposta, concluido_em FROM agente_turnos ORDER BY id");
    const porId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual([porId.velho.status, porId.velho.motivo, porId.velho.resposta], ["FALHOU", "REINICIO", TEXTO_FALHA]);
    assert.ok(porId.velho.concluido_em instanceof Date);
    assert.deepEqual([porId.novo.status, porId.novo.concluido_em], ["EM_ANDAMENTO", null]);
    assert.equal(logs.find((l) => l.evento === "AGENTE_TURNO_RECUPERADO").turnos, 1);
  });
});

test("a ação da tela por /api/ops (turno web sem sessão) não entra na conversa nem é alvo do 'desfazer' do chat", { skip }, async () => {
  await cenario([], async ({ chamar, falar, pool }) => {
    const f = await frente(chamar);
    const pelaTela = ok(await chamar("POST", "/api/ops/NovaTarefa", { frente_id: f.frente_id, nome: "Pela tela" }, { web: true }));
    const { rows: [turnoDaTela] } = await pool.query("SELECT canal, sessao_id FROM agente_turnos WHERE id = $1", [pelaTela.acao.turno_id]);
    assert.deepEqual([turnoDaTela.canal, turnoDaTela.sessao_id], ["web", null]);
    const r = await falar("desfazer");
    assert.equal(r.motivo, "NADA_A_DESFAZER");
    const conversa = ok(await chamar("GET", "/api/agente/conversa"));
    assert.deepEqual(conversa.turnos.map((t) => t.entrada), ["desfazer"]);
  });
});

test("o desfazer não alcança turno fora da janela", { skip }, async () => {
  let f;
  await cenario([
    () => ({ content: [ferramenta("NovaTarefa", { frente_id: f.frente_id, nome: "Antiga" })] }),
    { content: [texto("Criei.")] },
  ], async ({ chamar, falar, pool }) => {
    f = await frente(chamar);
    const criou = await falar("cria antiga");
    await pool.query("UPDATE agente_turnos SET criado_em = NOW() - interval '2 hours' WHERE id = $1", [criou.turno_id]);
    const r = await falar("desfazer");
    assert.equal(r.motivo, "NADA_A_DESFAZER");
    const { rows: [tarefa] } = await pool.query("SELECT deleted_at FROM tasks WHERE name = 'Antiga'");
    assert.equal(tarefa.deleted_at, null);
  });
});
