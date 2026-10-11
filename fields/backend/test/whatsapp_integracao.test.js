// Integração da A3 (o webhook do WhatsApp) contra Postgres REAL, com o modelo de roteiro no lugar da
// API. Pula sem TEST_DATABASE_URL, como as outras integrações — e usa o mesmo desenho: um schema por
// teste, initDB nele, app no ar, schema apagado no fim.
//
//   TEST_DATABASE_URL=postgres://u:p@localhost:5432/fields_teste npm test
//
// O que só o banco prova: o SQL de eventos_recebidos (a reserva, a contagem de tentativas, a resposta
// guardada e devolvida igual, a absorção da rajada) e de canais_whatsapp (o upsert); a escrita do agente pelo WhatsApp com
// origem 'whatsapp' no histórico; o "desfazer" pelo WhatsApp revertendo no banco; e a limpeza de 7 dias.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { criarApp } from "../src/app.js";
import { carregarConfig } from "../src/config.js";
import { gerarHashSenha } from "../src/auth/sessao.js";
import { initDB } from "../src/db/schema.js";
import { assinar } from "../src/integracoes/leschats.js";
import { limparEventosAntigos } from "../src/servicos/whatsapp.js";
import { definirSaida } from "../src/lib/log.js";
import { ferramenta, modeloFalso, texto } from "./fakes/modeloFalso.js";

const URL_TESTE = process.env.TEST_DATABASE_URL;
const skip = URL_TESTE ? false : "TEST_DATABASE_URL não definida (integração com Postgres real)";
const SSL = process.env.TEST_DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
const TOKEN = "token-de-integracao-0123456789abcdef";
const SEGREDO = "segredo-hmac-de-integracao-0123456789abc";
const DONO = "5511999998888";
const FIXTURE = readFileSync(new URL("./fixtures/leschats/mensagem-texto.json", import.meta.url));

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
    WHATSAPP_HABILITADO: "true",
    LESCHATS_SEGREDO: SEGREDO,
    FIELDS_DONO_WA_ID: DONO,
  });
  return configCache;
}

async function comAdmin(fn) {
  const c = new pg.Client({ connectionString: URL_TESTE, ssl: SSL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** O envelope do §3.3 com o texto e o wamid trocados, indentado como o da Les Chats. */
function envelope(textoDaMensagem, eventId) {
  const o = JSON.parse(FIXTURE.toString("utf8"));
  Object.assign(o, { event_id: eventId, history: [] });
  Object.assign(o.message, { text: textoDaMensagem, external_id: eventId });
  return Buffer.from(JSON.stringify(o, null, 2));
}

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
    const bearer = async (metodo, caminho, body) => {
      const res = await fetch(base + caminho, {
        method: metodo,
        headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    /** O POST da Les Chats, assinado. */
    const whatsapp = async (corpo) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(`${base}/api/agente/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", "X-LesChats-Timestamp": ts, "X-LesChats-Signature": assinar(corpo, ts, SEGREDO) },
        body: corpo,
      });
      const t = await res.text();
      return { status: res.status, texto: t, json: t ? JSON.parse(t) : undefined };
    };
    try {
      await fn({ bearer, whatsapp, pool, cliente });
    } finally { await new Promise((ok) => servidor.close(ok)); }
  } finally {
    await pool.end();
    await comAdmin((c) => c.query(`DROP SCHEMA ${schema} CASCADE`));
  }
}

test("WhatsApp → turno no canal whatsapp; a escrita com origem whatsapp; o wamid repetido devolve o mesmo corpo, sem turno novo; o canal gravado", { skip }, async () => {
  let f;
  const roteiro = [
    () => ({ content: [ferramenta("NovaTarefa", { frente_id: f.frente_id, nome: "Ligar para o banco" })] }),
    { content: [texto("Criei a tarefa **Ligar para o banco**.")] },
  ];
  await cenario(roteiro, async ({ bearer, whatsapp, pool, cliente }) => {
    const p = (await bearer("POST", "/api/ops/NovoProjeto", { nome: "Pessoal" })).json.resultado;
    f = (await bearer("POST", "/api/ops/NovaFrente", { projeto_id: p.projeto_id, nome: "Casa" })).json.resultado;

    const corpo = envelope("cria a tarefa ligar para o banco", "wamid.integracao-1");
    const r = await whatsapp(corpo);
    assert.deepEqual([r.status, r.json], [200, { text: "Criei a tarefa *Ligar para o banco*." }]);

    const { rows: [ev] } = await pool.query("SELECT status, resposta, turno_id, tentativas, concluido_em FROM eventos_recebidos WHERE event_id = 'wamid.integracao-1'");
    assert.deepEqual([ev.status, ev.resposta, ev.tentativas], ["CONCLUIDO", r.json, 1]);
    assert.ok(ev.concluido_em instanceof Date);
    const { rows: [turno] } = await pool.query("SELECT canal, status, entrada FROM agente_turnos WHERE id = $1", [ev.turno_id]);
    assert.deepEqual([turno.canal, turno.status, turno.entrada], ["whatsapp", "CONCLUIDO", "cria a tarefa ligar para o banco"]);
    const { rows: [tarefa] } = await pool.query("SELECT id FROM tasks WHERE name = 'Ligar para o banco'");
    const { rows: hist } = await pool.query("SELECT acao, origem, turno_id FROM historico WHERE entidade_tipo = 'TAREFA' AND entidade_id = $1", [tarefa.id]);
    assert.deepEqual(hist.map((h) => [h.acao, h.origem, h.turno_id]), [["CRIADO", "whatsapp", ev.turno_id]]);
    const { rows: canais } = await pool.query("SELECT wa_id, conversation_id, bot_id FROM canais_whatsapp");
    assert.deepEqual(canais.map((c) => [c.wa_id, Number(c.conversation_id), Number(c.bot_id)]), [[DONO, 42, 3]]);

    // A retentativa: o mesmo corpo (relido do jsonb), sem turno novo e sem chamada ao modelo.
    const deNovo = await whatsapp(corpo);
    assert.deepEqual(deNovo.json, r.json);
    assert.equal(cliente.chamadas.length, 2);
    const { rows: [{ n, tentativas }] } = await pool.query(
      "SELECT (SELECT COUNT(*)::int FROM agente_turnos WHERE canal = 'whatsapp') AS n, (SELECT tentativas FROM eventos_recebidos WHERE event_id = 'wamid.integracao-1') AS tentativas"
    );
    assert.deepEqual([n, tentativas], [1, 2]);

    // "desfazer" pelo WhatsApp: sem modelo, e a tarefa sai (soft-delete).
    const d = await whatsapp(envelope("desfazer", "wamid.integracao-2"));
    assert.match(d.json.text, /^Desfeito: /);
    assert.equal(cliente.chamadas.length, 2, "o desfazer não chamou o modelo");
    const { rows: [depois] } = await pool.query("SELECT deleted_at FROM tasks WHERE id = $1", [tarefa.id]);
    assert.ok(depois.deleted_at instanceof Date);
  });
});

test("rajada (§6.2) contra o Postgres: a anterior nova entra no turno e fica CONCLUIDA com {}; a que já tinha linha fica como estava; o POST atrasado recebe {}", { skip }, async () => {
  await cenario([{ content: [texto("Anotado.")] }], async ({ whatsapp, pool, cliente }) => {
    await pool.query(
      "INSERT INTO eventos_recebidos (event_id, status, resposta, turno_id, concluido_em) VALUES ($1, 'CONCLUIDO', $2::jsonb, 't-antigo', NOW())",
      ["wamid.ja-recebida", JSON.stringify({ text: "Criei." })]
    );
    const o = JSON.parse(FIXTURE.toString("utf8"));
    const doCliente = o.history[0]; // a entrada CUSTOMER do §3.3
    const agora = Date.now();
    o.event_id = "wamid.rajada-atual";
    Object.assign(o.message, { text: "pra amanhã", external_id: "wamid.rajada-atual", created_at: new Date(agora).toISOString() });
    o.history.push(
      { ...doCliente, external_id: "wamid.ja-recebida", text: "cria a tarefa X", created_at: new Date(agora - 4000).toISOString() },
      { ...doCliente, external_id: "wamid.nova", text: "na frente Casa", created_at: new Date(agora - 2000).toISOString() },
    );
    const r = await whatsapp(Buffer.from(JSON.stringify(o, null, 2)));
    assert.deepEqual(r.json, { text: "Anotado." });

    const { rows } = await pool.query(
      `SELECT event_id, status, resposta, turno_id, concluido_em IS NOT NULL AS concluido FROM eventos_recebidos
       WHERE event_id IN ('wamid.ja-recebida', 'wamid.nova') ORDER BY event_id`
    );
    assert.deepEqual(rows.map((x) => [x.event_id, x.status, x.resposta, x.turno_id, x.concluido]), [
      ["wamid.ja-recebida", "CONCLUIDO", { text: "Criei." }, "t-antigo", true],
      ["wamid.nova", "CONCLUIDO", {}, null, true],
    ]);
    const { rows: [turno] } = await pool.query("SELECT entrada FROM agente_turnos WHERE canal = 'whatsapp'");
    assert.equal(turno.entrada, "na frente Casa\npra amanhã");
    assert.match(cliente.chamadas[0].corpo.messages[0].content[1].text, /^<mensagens_anteriores_sem_resposta>\n<mensagem>\nna frente Casa\n<\/mensagem>\n<\/mensagens_anteriores_sem_resposta>$/);

    // O POST atrasado da anterior absorvida: {} relido do jsonb, sem turno novo.
    const atrasado = await whatsapp(envelope("na frente Casa", "wamid.nova"));
    assert.deepEqual(atrasado.json, {});
    const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM agente_turnos WHERE canal = 'whatsapp'");
    assert.equal(n, 1);
  });
});

test("limparEventosAntigos: só o que passou de 7 dias sai (inclusive um EM_VOO esquecido); o recente fica", { skip }, async () => {
  await cenario([], async ({ pool }) => {
    await pool.query(
      `INSERT INTO eventos_recebidos (event_id, status, criado_em) VALUES
         ('velho', 'CONCLUIDO', NOW() - interval '8 days'),
         ('orfao', 'EM_VOO', NOW() - interval '7 days 1 hour'),
         ('novo', 'CONCLUIDO', NOW() - interval '6 days')`
    );
    assert.equal(await limparEventosAntigos(pool), 2);
    const { rows } = await pool.query("SELECT event_id FROM eventos_recebidos ORDER BY event_id");
    assert.deepEqual(rows.map((r) => r.event_id), ["novo"]);
    // O CHECK do status: só os dois do enum.
    await assert.rejects(pool.query("INSERT INTO eventos_recebidos (event_id, status) VALUES ('x', 'OUTRO')"), (err) => err.code === "23514");
  });
});
