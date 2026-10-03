// Integração da A1 contra Postgres REAL. Pula sem TEST_DATABASE_URL (o `npm test` de todo dia roda
// sem banco). Cada teste cria um schema próprio (test_<aleatório>), roda o initDB nele — schema,
// seed e migração, como no boot de produção — e o apaga no fim.
//
//   TEST_DATABASE_URL=postgres://u:p@localhost:5432/fields_teste npm test
//   (TEST_DATABASE_SSL=true se o banco exigir TLS)
//
// O usuário precisa poder criar schema no banco. Nunca aponte para o banco de produção: o teste não
// toca o schema public, mas também não há motivo para chegar perto.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { criarApp } from "../src/app.js";
import { carregarConfig } from "../src/config.js";
import { emitirCookieSessao, gerarHashSenha } from "../src/auth/sessao.js";
import { DDL_BASE, initDB } from "../src/db/schema.js";
import { repararDivergencia } from "../src/db/migracoes.js";
import { hojeISO, somarDias } from "../src/lib/datas.js";
import { definirSaida } from "../src/lib/log.js";

const URL_TESTE = process.env.TEST_DATABASE_URL;
const skip = URL_TESTE ? false : "TEST_DATABASE_URL não definida (integração com Postgres real)";
const SSL = process.env.TEST_DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
const TOKEN = "token-de-integracao-0123456789abcdef";

let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });
const eventos = (nome) => logs.filter((l) => l.evento === nome);

let configCache;
async function config() {
  configCache ??= carregarConfig({
    DATABASE_URL: URL_TESTE,
    FIELDS_SENHA_HASH: await gerarHashSenha("senha de integração"),
    FIELDS_SEGREDO_SESSAO: "segredo-de-sessao-de-integracao-0123456789",
    FIELDS_API_TOKEN: TOKEN,
  });
  return configCache;
}

// ─── Infra: um schema por teste ───
async function comAdmin(fn) {
  const c = new pg.Client({ connectionString: URL_TESTE, ssl: SSL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function bancoNovo() {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  await comAdmin((c) => c.query(`CREATE SCHEMA ${schema}`));
  const pool = new pg.Pool({
    connectionString: URL_TESTE, ssl: SSL, max: 4,
    options: `-c TimeZone=America/Sao_Paulo -c search_path=${schema}`, // o fuso do pool de produção
  });
  pool.on("error", () => {});
  const descartar = async () => {
    await pool.end();
    await comAdmin((c) => c.query(`DROP SCHEMA ${schema} CASCADE`));
  };
  return { pool, descartar };
}

async function subir(db, estado) {
  const cfg = await config();
  const app = criarApp({ config: cfg, db, estado });
  const servidor = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const cookie = `fields_s=${emitirCookieSessao(cfg.segredoSessao)}`;
  /** Bearer (origem mcp) por padrão; {web:true} usa o cookie (origem web). */
  const chamar = async (metodo, caminho, body, { web = false } = {}) => {
    const headers = web ? { Cookie: cookie } : { Authorization: `Bearer ${TOKEN}` };
    if (metodo !== "GET") headers["Content-Type"] = "application/json";
    const res = await fetch(base + caminho, { method: metodo, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const texto = await res.text();
    let json; try { json = texto ? JSON.parse(texto) : undefined; } catch { json = undefined; }
    return { status: res.status, json };
  };
  return { chamar, fechar: () => new Promise((ok) => servidor.close(ok)) };
}

/** Banco novo → (preparo) → initDB → app no ar → fn → limpa tudo. */
async function cenario(fn, { preparar } = {}) {
  const banco = await bancoNovo();
  try {
    if (preparar) await preparar(banco.pool);
    const estado = await initDB(banco.pool);
    const s = await subir(banco.pool, estado);
    try { await fn({ ...s, pool: banco.pool, estado }); } finally { await s.fechar(); }
  } finally { await banco.descartar(); }
}

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json)); return r.json; };
const ids = (lista) => lista.map((x) => x.id);

async function arvore(chamar) {
  return ok(await chamar("GET", "/api/projects")).projects;
}

// ─── Soft-delete ───
test("entrada excluída some de toda leitura; GET/PATCH/DELETE → 404; restaurar devolve", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const amanha = somarDias(hojeISO(), 1);
    const alvo = ok(await chamar("POST", "/api/entries", { type: "event", title: "Alvo zzq", content: "c", tags: ["zzq"], date: amanha, time: "10:00", pinned: true }), 201).entry;
    const vizinha = ok(await chamar("POST", "/api/entries", { type: "note", title: "Vizinha", content: "c", tags: ["zzq"] }), 201).entry;
    assert.deepEqual(ids(ok(await chamar("GET", `/api/entries/${vizinha.id}`)).related), [alvo.id]);
    const antes = ok(await chamar("GET", "/api/entries/stats"));

    assert.deepEqual(ok(await chamar("DELETE", `/api/entries/${alvo.id}`)), { success: true });

    for (const caminho of ["/api/entries", "/api/entries?search=zzq", "/api/entries?type=event", "/api/entries?type=pinned", "/api/entries/upcoming?limit=100"]) {
      assert.ok(!ids(ok(await chamar("GET", caminho)).entries).includes(alvo.id), caminho);
    }
    const depois = ok(await chamar("GET", "/api/entries/stats"));
    assert.deepEqual([depois.total, depois.event, depois.pinned], [antes.total - 1, antes.event - 1, antes.pinned - 1]);
    assert.deepEqual(ok(await chamar("GET", `/api/entries/${vizinha.id}`)).related, [], "excluída não é relacionada");

    for (const [metodo, body] of [["GET"], ["PATCH", { title: "x" }], ["DELETE"]]) {
      const r = await chamar(metodo, `/api/entries/${alvo.id}`, body);
      assert.deepEqual([r.status, r.json], [404, { error: "Not found" }], metodo);
    }
    const { rows: [linha] } = await pool.query("SELECT title, deleted_at FROM entries WHERE id = $1", [alvo.id]);
    assert.ok(linha.deleted_at instanceof Date, "a linha continua no banco, carimbada");
    assert.equal(linha.title, "Alvo zzq", "o PATCH na excluída não escreveu nada");

    assert.deepEqual(ok(await chamar("POST", `/api/entries/${alvo.id}/restaurar`)), { success: true });
    assert.equal((await chamar("POST", `/api/entries/${alvo.id}/restaurar`)).status, 404, "restaurar o que não está excluído → 404");
    assert.ok(ids(ok(await chamar("GET", "/api/entries?type=pinned")).entries).includes(alvo.id));
    assert.deepEqual(ids(ok(await chamar("GET", `/api/entries/${vizinha.id}`)).related), [alvo.id]);
    assert.equal(ok(await chamar("GET", "/api/entries/stats")).total, antes.total);
  });
});

test("projeto excluído esconde frentes e tarefas pela view; restaurar devolve; a tarefa excluída sozinha continua excluída", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const p = ok(await chamar("POST", "/api/projects", { name: "P" }), 201).project;
    const f = ok(await chamar("POST", `/api/projects/${p.id}/frentes`, { name: "F" }), 201).frente;
    const t1 = ok(await chamar("POST", `/api/frentes/${f.id}/tasks`, { name: "T1" }), 201).task;
    const t2 = ok(await chamar("POST", `/api/frentes/${f.id}/tasks`, { name: "T2" }), 201).task;

    ok(await chamar("DELETE", `/api/tasks/${t2.id}`));
    const tarefasDe = async () => (await arvore(chamar)).find((x) => x.id === p.id)?.frentes.find((x) => x.id === f.id)?.tasks.map((t) => t.id);
    assert.deepEqual(await tarefasDe(), [t1.id]);

    ok(await chamar("DELETE", `/api/projects/${p.id}`));
    assert.equal((await arvore(chamar)).find((x) => x.id === p.id), undefined);
    const { rows: [carimbos] } = await pool.query(
      "SELECT (SELECT deleted_at FROM frentes WHERE id = $1) AS frente, (SELECT deleted_at FROM tasks WHERE id = $2) AS tarefa", [f.id, t1.id]);
    assert.deepEqual(carimbos, { frente: null, tarefa: null }, "os filhos não são carimbados");

    // escondidos = inexistentes para escrita
    for (const [metodo, caminho, body] of [
      ["PATCH", `/api/tasks/${t1.id}`, { status: "Concluído" }],
      ["PATCH", `/api/frentes/${f.id}`, { name: "x" }],
      ["PATCH", `/api/projects/${p.id}`, { name: "x" }],
      ["POST", `/api/frentes/${f.id}/tasks`, { name: "T3" }],
      ["POST", `/api/projects/${p.id}/frentes`, { name: "F2" }],
    ]) {
      const r = await chamar(metodo, caminho, body);
      assert.deepEqual([r.status, r.json], [404, { error: "Not found" }], `${metodo} ${caminho}`);
    }
    assert.deepEqual(ok(await chamar("DELETE", `/api/projects/${p.id}`)), { success: true }, "DELETE repetido: o corpo de sempre");
    // ... inclusive para o DELETE (uma aba desatualizada, ou o MCP): o corpo legado, e nada carimbado
    assert.deepEqual(ok(await chamar("DELETE", `/api/tasks/${t1.id}`)), { success: true });
    assert.deepEqual(ok(await chamar("DELETE", `/api/frentes/${f.id}`)), { success: true });
    const { rows: [intactos] } = await pool.query(
      "SELECT (SELECT deleted_at FROM frentes WHERE id = $1) AS frente, (SELECT deleted_at FROM tasks WHERE id = $2) AS tarefa", [f.id, t1.id]);
    assert.deepEqual(intactos, { frente: null, tarefa: null }, "o DELETE do filho escondido não escreveu");
    assert.ok(!ok(await chamar("GET", `/api/historico/TAREFA/${t1.id}`)).eventos.some((x) => x.acao === "EXCLUIDO"));

    ok(await chamar("POST", `/api/projects/${p.id}/restaurar`));
    assert.deepEqual(await tarefasDe(), [t1.id], "volta a árvore — com a t1 do DELETE escondido —, menos a tarefa excluída sozinha");
    ok(await chamar("POST", `/api/tasks/${t2.id}/restaurar`));
    assert.deepEqual(await tarefasDe(), [t1.id, t2.id]);

    ok(await chamar("DELETE", `/api/frentes/${f.id}`));
    assert.deepEqual((await arvore(chamar)).find((x) => x.id === p.id).frentes, []);
    assert.equal((await chamar("PATCH", `/api/tasks/${t1.id}`, { status: "Concluído" })).status, 404);
    ok(await chamar("POST", `/api/frentes/${f.id}/restaurar`));
    assert.deepEqual(await tarefasDe(), [t1.id, t2.id]);

    const inexistente = await chamar("POST", "/api/projects/nao-existe/frentes", { name: "órfã" });
    assert.deepEqual([inexistente.status, inexistente.json], [404, { error: "Not found" }], "era 500 da FK");
  });
});

test("reunião excluída some da agenda e do intervalo; PATCH → 404; restaurar devolve", { skip }, async () => {
  await cenario(async ({ chamar }) => {
    const m = ok(await chamar("POST", "/api/meetings", { title: "R", date: "2030-03-04", start_time: "10:00", must: "levar" }), 201).meeting;
    assert.ok(ids(ok(await chamar("GET", "/api/meetings?from=2030-03-01&to=2030-03-31")).meetings).includes(m.id));
    assert.deepEqual(ok(await chamar("DELETE", `/api/meetings/${m.id}`)), { success: true });
    for (const caminho of ["/api/meetings", "/api/meetings?from=2030-03-01", "/api/meetings?from=2030-03-01&to=2030-03-31"]) {
      assert.ok(!ids(ok(await chamar("GET", caminho)).meetings).includes(m.id), caminho);
    }
    assert.equal((await chamar("PATCH", `/api/meetings/${m.id}`, { title: "x" })).status, 404);
    ok(await chamar("POST", `/api/meetings/${m.id}/restaurar`));
    const volta = ok(await chamar("GET", "/api/meetings")).meetings.find((x) => x.id === m.id);
    assert.deepEqual([volta.title, volta.must], ["R", "levar"]);
  });
});

// ─── Histórico ───
test("histórico: CRIADO, ATUALIZADO só com o que mudou e com a origem, PATCH igual não grava, EXCLUIDO/RESTAURADO", { skip }, async () => {
  await cenario(async ({ chamar }) => {
    const p = ok(await chamar("POST", "/api/projects", { name: "P" }), 201).project;
    const f = ok(await chamar("POST", `/api/projects/${p.id}/frentes`, { name: "F" }), 201).frente;
    const t = ok(await chamar("POST", `/api/frentes/${f.id}/tasks`, { name: "T", deadline: "2030-01-10" }), 201).task;

    ok(await chamar("PATCH", `/api/tasks/${t.id}`, { name: "T", status: "Em andamento", deadline: "2030-01-10" }, { web: true }));
    ok(await chamar("PATCH", `/api/tasks/${t.id}`, { name: "T", status: "Em andamento" }, { web: true })); // nada muda
    ok(await chamar("DELETE", `/api/tasks/${t.id}`));
    ok(await chamar("POST", `/api/tasks/${t.id}/restaurar`));

    const { eventos } = ok(await chamar("GET", `/api/historico/TAREFA/${t.id}`));
    assert.deepEqual(eventos.map((e) => [e.acao, e.origem]), [
      ["RESTAURADO", "mcp"], ["EXCLUIDO", "mcp"], ["ATUALIZADO", "web"], ["CRIADO", "mcp"],
    ], "mais novo primeiro; o PATCH sem mudança não virou evento");
    const [restaurado, excluido, atualizado, criado] = eventos;
    assert.deepEqual(atualizado.mudancas, [{ campo: "status", de: "Pendente", para: "Em andamento" }]);
    assert.deepEqual(criado.mudancas.find((m) => m.campo === "frente_id"), { campo: "frente_id", para: f.id });
    assert.deepEqual(criado.mudancas.find((m) => m.campo === "deadline"), { campo: "deadline", para: "2030-01-10" });
    assert.ok(criado.mudancas.every((m) => !("de" in m)), "CRIADO guarda só o para");
    assert.equal(excluido.mudancas[0].campo, "deleted_at");
    assert.deepEqual([excluido.mudancas[0].de, restaurado.mudancas[0].para], [null, null]);
    assert.equal(restaurado.mudancas[0].de, excluido.mudancas[0].para, "o restaurar sabe quando a tarefa tinha saído");
    assert.ok(eventos.every((e) => typeof e.id === "number" && !Number.isNaN(Date.parse(e.criado_em))));

    assert.deepEqual(ok(await chamar("GET", `/api/historico/PROJETO/${p.id}`)).eventos.map((e) => e.acao), ["CRIADO"]);
    assert.deepEqual(ok(await chamar("GET", "/api/historico/TAREFA/nao-existe")).eventos, []);
    const ruim = await chamar("GET", `/api/historico/tarefa/${t.id}`);
    assert.deepEqual([ruim.status, ruim.json], [400, { error: "tipo_invalido" }]);
  });
});

// ─── Comentários ───
test("comentários: API nova, GET no formato legado, adaptador do PATCH de array e colisão global", { skip }, async () => {
  await cenario(async ({ chamar, pool, estado }) => {
    assert.equal(estado.comentariosMigrados, true, "banco novo: a migração roda (vazia) e o modo é o migrado");
    const e = ok(await chamar("POST", "/api/entries", { title: "E", content: "c" }), 201).entry;

    const c1 = ok(await chamar("POST", "/api/comentarios", { alvo_tipo: "ENTRADA", alvo_id: e.id, texto: "  primeiro  " }), 201).comentario;
    assert.deepEqual([c1.texto, c1.alvo_tipo, c1.alvo_id, c1.origem], ["primeiro", "ENTRADA", e.id, "mcp"]);
    const threads = ok(await chamar("GET", `/api/entries/${e.id}`)).entry.threads;
    assert.deepEqual(threads, [{ id: c1.id, text: "primeiro", createdAt: c1.criado_em }]);
    assert.deepEqual(Object.keys(threads[0]), ["id", "text", "createdAt"]);

    for (const [body, status, error] of [
      [{ alvo_tipo: "ENTRADA", alvo_id: e.id, texto: "   " }, 400, "texto_obrigatorio"],
      [{ alvo_tipo: "ENTRADA", alvo_id: e.id, texto: "x".repeat(5001) }, 400, "texto_longo_demais"],
      [{ alvo_tipo: "PROJETO", alvo_id: e.id, texto: "x" }, 400, "alvo_invalido"],
      [{ alvo_tipo: "ENTRADA", texto: "x" }, 400, "alvo_invalido"],
      [{ alvo_tipo: "ENTRADA", alvo_id: "nao-existe", texto: "x" }, 404, "Not found"],
    ]) {
      const r = await chamar("POST", "/api/comentarios", body);
      assert.deepEqual([r.status, r.json], [status, { error }], JSON.stringify(body).slice(0, 80));
    }
    const c2 = ok(await chamar("POST", "/api/comentarios", { alvo_tipo: "ENTRADA", alvo_id: e.id, texto: "y".repeat(5000) }), 201).comentario;
    assert.deepEqual(ids(ok(await chamar("GET", `/api/comentarios?alvo_tipo=ENTRADA&alvo_id=${e.id}`)).comentarios), [c1.id, c2.id]);

    // PATCH legado: edita o c2, acrescenta um novo — e muda o título na mesma request
    const r = ok(await chamar("PATCH", `/api/entries/${e.id}`, {
      title: "E editada",
      threads: [
        { id: c1.id, text: "primeiro", createdAt: c1.criado_em },
        { id: c2.id, text: "c2 editado", createdAt: c2.criado_em },
        { id: "1696334400000", text: "via array", createdAt: "2026-10-01T00:00:00.000Z" },
      ],
    }, { web: true }));
    assert.equal(r.entry.title, "E editada");
    assert.deepEqual(r.entry.threads.map((x) => [x.id, x.text]),
      [["1696334400000", "via array"], [c1.id, "primeiro"], [c2.id, "c2 editado"]], "ordem de criação");
    const legado = eventos("LEGADO_ARRAY_PATCH")[0];
    assert.deepEqual([legado.alvo_tipo, legado.inseridos, legado.removidos, legado.editados], ["ENTRADA", 1, 0, 1]);
    // PATCH legado "remover um": o array sem o c1
    const semC1 = ok(await chamar("PATCH", `/api/entries/${e.id}`, { threads: r.entry.threads.filter((x) => x.id !== c1.id) }, { web: true }));
    assert.deepEqual(ids(semC1.entry.threads), ["1696334400000", c2.id]);
    const { rows: [backup] } = await pool.query("SELECT threads FROM entries WHERE id = $1", [e.id]);
    assert.deepEqual(backup.threads, [], "a coluna jsonb não é escrita no modo migrado");
    const { rows: [c1Linha] } = await pool.query("SELECT deleted_at FROM comentarios WHERE id = $1", [c1.id]);
    assert.ok(c1Linha.deleted_at instanceof Date, "o que sumiu do array foi excluído logicamente, não apagado");
    assert.deepEqual(ok(await chamar("GET", `/api/historico/COMENTARIO/${c2.id}`)).eventos.map((x) => [x.acao, x.origem]),
      [["ATUALIZADO", "web"], ["CRIADO", "mcp"]]);

    // excluir / restaurar pela API nova
    ok(await chamar("DELETE", `/api/comentarios/${c2.id}`));
    assert.equal((await chamar("DELETE", `/api/comentarios/${c2.id}`)).status, 404);
    assert.deepEqual(ids(ok(await chamar("GET", `/api/entries/${e.id}`)).entry.threads), ["1696334400000"]);
    ok(await chamar("POST", `/api/comentarios/${c2.id}/restaurar`));
    assert.equal((await chamar("POST", `/api/comentarios/${c2.id}/restaurar`)).status, 404);

    // Retrato velho: o front antigo guarda o array de quando abriu; a API nova escreve por fora dele.
    const retrato = ok(await chamar("GET", `/api/entries/${e.id}`)).entry.threads; // [1696…, c2]
    const c3 = ok(await chamar("POST", "/api/comentarios", { alvo_tipo: "ENTRADA", alvo_id: e.id, texto: "depois do retrato" }), 201).comentario;
    ok(await chamar("DELETE", `/api/comentarios/${c2.id}`));
    logs = [];
    const novo = { id: "1696334400999", text: "acrescentado sobre o retrato", createdAt: "2026-10-03T00:00:00.000Z" };
    ok(await chamar("PATCH", `/api/entries/${e.id}`, { threads: [...retrato, novo] }, { web: true }));
    assert.deepEqual(ids(ok(await chamar("GET", `/api/entries/${e.id}`)).entry.threads).sort(),
      ["1696334400000", novo.id, c3.id].sort(), "o c3 (mais novo que o retrato) fica; o c2 (excluído depois) não volta");
    const velho = eventos("LEGADO_ARRAY_PATCH")[0];
    assert.deepEqual([velho.nivel, velho.inseridos, velho.removidos, velho.remocoes_ignoradas, velho.restauros_ignorados], ["warn", 1, 0, 1, 1]);
    assert.deepEqual(ok(await chamar("GET", `/api/historico/COMENTARIO/${c2.id}`)).eventos.map((x) => x.acao)[0], "EXCLUIDO",
      "nenhum RESTAURADO em nome do web");
    // "remover um" sobre o mesmo retrato: faltam o c3 e o removido — 409, nada sai
    const ambigua = await chamar("PATCH", `/api/entries/${e.id}`, { threads: retrato.filter((x) => x.id !== c2.id) }, { web: true });
    assert.deepEqual([ambigua.status, ambigua.json], [409, { error: "comentarios_desatualizados" }]);
    assert.equal(ok(await chamar("GET", `/api/entries/${e.id}`)).entry.threads.length, 3);

    // tarefa e reunião, com colisão GLOBAL de id pelo adaptador
    const p = ok(await chamar("POST", "/api/projects", { name: "P" }), 201).project;
    const f = ok(await chamar("POST", `/api/projects/${p.id}/frentes`, { name: "F" }), 201).frente;
    const t = ok(await chamar("POST", `/api/frentes/${f.id}/tasks`, { name: "T" }), 201).task;
    ok(await chamar("PATCH", `/api/tasks/${t.id}`, { status: "Concluído", comments: [{ id: "tc1", text: "oi", created_at: "2026-10-02T10:00:00.000Z" }] }));
    const tarefa = (await arvore(chamar)).find((x) => x.id === p.id).frentes[0].tasks[0];
    assert.equal(tarefa.status, "Concluído");
    assert.deepEqual(tarefa.comments, [{ id: "tc1", text: "oi", created_at: "2026-10-02T10:00:00.000Z" }]);

    const m = ok(await chamar("POST", "/api/meetings", { title: "R", date: "2030-03-04" }), 201).meeting;
    const rm = ok(await chamar("PATCH", `/api/meetings/${m.id}`, { must: "levar", comments: [{ id: "tc1", text: "da reunião", created_at: "2026-10-03T10:00:00.000Z" }] }));
    assert.equal(rm.meeting.must, "levar");
    assert.deepEqual(rm.meeting.comments, [{ id: `REUNIAO:${m.id}:tc1`, text: "da reunião", created_at: "2026-10-03T10:00:00.000Z" }]);
    // o cliente ainda manda "tc1" (o id que ele mesmo gerou): casa pelo alias, sem duplicar
    const de_novo = ok(await chamar("PATCH", `/api/meetings/${m.id}`, { comments: [{ id: "tc1", text: "da reunião", created_at: "2026-10-03T10:00:00.000Z" }] }));
    assert.deepEqual(ids(de_novo.meeting.comments), [`REUNIAO:${m.id}:tc1`]);

    // alvo excluído: a lista some (404) e não se comenta nele
    ok(await chamar("DELETE", `/api/entries/${e.id}`));
    assert.equal((await chamar("GET", `/api/comentarios?alvo_tipo=ENTRADA&alvo_id=${e.id}`)).status, 404);
    assert.equal((await chamar("POST", "/api/comentarios", { alvo_tipo: "ENTRADA", alvo_id: e.id, texto: "x" })).status, 404);
  });
});

// ─── Migração comentarios_v1 ───
const TS = (s) => new Date(s);
test("comentário de alvo excluído ou escondido é inexistente para escrita; o fio volta intacto com o alvo", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const carimbado = async (id) => (await pool.query("SELECT deleted_at FROM comentarios WHERE id = $1", [id])).rows[0].deleted_at;

    // alvo excluído diretamente
    const e = ok(await chamar("POST", "/api/entries", { title: "E", content: "c" }), 201).entry;
    const ce = ok(await chamar("POST", "/api/comentarios", { alvo_tipo: "ENTRADA", alvo_id: e.id, texto: "fica" }), 201).comentario;
    ok(await chamar("DELETE", `/api/entries/${e.id}`));
    assert.equal((await chamar("DELETE", `/api/comentarios/${ce.id}`)).status, 404);
    assert.equal((await chamar("POST", `/api/comentarios/${ce.id}/restaurar`)).status, 404);
    assert.equal(await carimbado(ce.id), null, "o DELETE no comentário de alvo excluído não carimba");
    ok(await chamar("POST", `/api/entries/${e.id}/restaurar`));
    assert.deepEqual(ids(ok(await chamar("GET", `/api/entries/${e.id}`)).entry.threads), [ce.id]);

    // alvo escondido pela view: tarefa de projeto excluído
    const p = ok(await chamar("POST", "/api/projects", { name: "P" }), 201).project;
    const f = ok(await chamar("POST", `/api/projects/${p.id}/frentes`, { name: "F" }), 201).frente;
    const t = ok(await chamar("POST", `/api/frentes/${f.id}/tasks`, { name: "T" }), 201).task;
    const ct = ok(await chamar("POST", "/api/comentarios", { alvo_tipo: "TAREFA", alvo_id: t.id, texto: "da tarefa" }), 201).comentario;
    ok(await chamar("DELETE", `/api/projects/${p.id}`));
    assert.equal((await chamar("DELETE", `/api/comentarios/${ct.id}`)).status, 404);
    assert.equal(await carimbado(ct.id), null, "tarefa escondida pela view: comentário intocado");
    ok(await chamar("POST", `/api/projects/${p.id}/restaurar`));
    const tarefa = (await arvore(chamar)).flatMap((x) => x.frentes).flatMap((x) => x.tasks).find((x) => x.id === t.id);
    assert.deepEqual(ids(tarefa.comments), [ct.id]);
  });
});

async function semearLegado(pool, { comentariosDaTarefa }) {
  await pool.query(DDL_BASE); // o banco como a A0 deixou
  await pool.query(
    `INSERT INTO entries (id, type, title, content, tags, threads, created_at) VALUES
     ('e1', 'note', 'E1', 'c', '[]', $1, $2), ('e2', 'note', 'E2', 'c', '[]', '[]', $2)`,
    [JSON.stringify([
      { id: "1001", text: "nota 1", createdAt: "2026-09-01T10:00:00.000Z" },
      { id: "c1", text: "colide", createdAt: "2026-09-02T10:00:00.000Z" },
    ]), TS("2026-08-01T12:00:00Z")]
  );
  await pool.query("INSERT INTO projects (id, name) VALUES ('p1', 'P')");
  await pool.query("INSERT INTO frentes (id, project_id, name) VALUES ('f1', 'p1', 'F')");
  await pool.query("INSERT INTO tasks (id, frente_id, name, comments) VALUES ('t1', 'f1', 'T', $1)", [JSON.stringify(comentariosDaTarefa)]);
  await pool.query(
    "INSERT INTO meetings (id, title, date, comments, created_at) VALUES ('m1', 'R', '2030-01-01', $1, $2)",
    [JSON.stringify([{ id: "m-1", text: "sem data" }]), TS("2026-08-20T12:00:00Z")]
  );
}

test("migração: copia o legado exatamente, remapeia a colisão, é idempotente, e o backup fica intocado", { skip }, async () => {
  const daTarefa = [{ id: "c1", text: "da tarefa", created_at: "2026-09-03T10:00:00.000Z" }];
  await cenario(async ({ chamar, pool, estado }) => {
    assert.equal(estado.comentariosMigrados, true);
    const e1 = ok(await chamar("GET", "/api/entries/e1")).entry;
    assert.deepEqual(e1.threads, [
      { id: "1001", text: "nota 1", createdAt: "2026-09-01T10:00:00.000Z" },
      { id: "c1", text: "colide", createdAt: "2026-09-02T10:00:00.000Z" },
    ], "ids, textos e datas exatamente como no array legado");
    const t1 = (await arvore(chamar))[0].frentes[0].tasks[0];
    assert.deepEqual(t1.comments, [{ id: "TAREFA:t1:c1", text: "da tarefa", created_at: "2026-09-03T10:00:00.000Z" }]);
    const m1 = ok(await chamar("GET", "/api/meetings")).meetings[0];
    assert.deepEqual(m1.comments, [{ id: "m-1", text: "sem data", created_at: "2026-08-20T12:00:00.000Z" }], "sem data → a do pai");

    const aplicada = eventos("MIGRACAO_APLICADA")[0];
    assert.deepEqual([aplicada.entradas, aplicada.tarefas, aplicada.reunioes, aplicada.remapeados, aplicada.reparados], [2, 1, 1, 1, 1]);
    assert.equal(eventos("MIGRACAO_COMENTARIO_ID_REMAPEADO")[0].tarefas, 1);
    assert.equal(eventos("DB_PRONTO")[0].comentarios_migrados, true);
    const { rows: [{ origens }] } = await pool.query("SELECT array_agg(DISTINCT origem) AS origens FROM comentarios");
    assert.deepEqual(origens, ["sistema"]);

    const { rows: [backup] } = await pool.query("SELECT threads FROM entries WHERE id = 'e1'");
    assert.deepEqual(backup.threads.map((x) => x.id), ["1001", "c1"], "a coluna legada não foi tocada");

    // segunda subida: nada se repete
    logs = [];
    assert.deepEqual(await initDB(pool), { comentariosMigrados: true });
    assert.equal(eventos("MIGRACAO_JA_APLICADA").length, 1);
    assert.equal(eventos("MIGRACAO_APLICADA").length, 0);
    assert.equal(eventos("MIGRACAO_COMENTARIO_DIVERGENTE").length, 0);
    const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM comentarios");
    assert.equal(n, 4);

    // escrita no jsonb DEPOIS da migração (a instância antiga, ou um rollback para a A0) — inclusive
    // com o id "c1", que já existe noutro alvo, e por cima de uma exclusão feita na A1
    ok(await chamar("DELETE", "/api/comentarios/1001"));
    await pool.query(`UPDATE entries SET threads = threads || '[{"id":"tardio","text":"x","createdAt":"2026-10-03T00:00:00.000Z"}]'::jsonb WHERE id = 'e1'`);
    await pool.query(`UPDATE meetings SET comments = comments || '[{"id":"c1","text":"na A0","created_at":"2026-10-03T01:00:00.000Z"}]'::jsonb WHERE id = 'm1'`);
    logs = [];
    await initDB(pool);
    const rec = eventos("MIGRACAO_COMENTARIO_RECUPERADO")[0];
    assert.deepEqual([rec.momento, rec.entradas, rec.tarefas, rec.reunioes, rec.remapeados], ["boot", 1, 0, 1, 1]);
    assert.deepEqual(ok(await chamar("GET", "/api/entries/e1")).entry.threads.map((x) => [x.id, x.text]),
      [["c1", "colide"], ["tardio", "x"]], "o tardio aparece; o 1001, excluído na A1, continua excluído");
    const m1Depois = ok(await chamar("GET", "/api/meetings")).meetings[0];
    assert.deepEqual(ids(m1Depois.comments), ["m-1", "REUNIAO:m1:c1"]);
    const { rows: [tardio] } = await pool.query("SELECT origem FROM comentarios WHERE id = 'tardio'");
    assert.equal(tardio.origem, "sistema");
    assert.deepEqual(ok(await chamar("GET", "/api/historico/COMENTARIO/tardio")).eventos.map((x) => [x.acao, x.origem]), [["CRIADO", "sistema"]]);
    const { rows: [backupDepois] } = await pool.query("SELECT threads FROM entries WHERE id = 'e1'");
    assert.deepEqual(backupDepois.threads.map((x) => x.id), ["1001", "c1", "tardio"], "o reparo não reescreve o jsonb");

    // idempotente: a próxima subida (e o reparo pós-deploy) não acham mais nada
    logs = [];
    await initDB(pool);
    await repararDivergencia(pool, { momento: "pos_deploy" });
    assert.equal(eventos("MIGRACAO_COMENTARIO_RECUPERADO").length, 0);
    const { rows: [{ n: total }] } = await pool.query("SELECT COUNT(*)::int AS n FROM comentarios");
    assert.equal(total, 6);
  }, { preparar: (pool) => semearLegado(pool, { comentariosDaTarefa: daTarefa }) });
});

test("migração que falha: ROLLBACK, MIGRACAO_FALHOU, e o servidor segue servindo o formato legado", { skip }, async () => {
  const daTarefa = [{ id: "ruim", text: 42 }]; // item ilegível
  await cenario(async ({ chamar, pool, estado }) => {
    assert.equal(estado.comentariosMigrados, false);
    const falhou = eventos("MIGRACAO_FALHOU")[0];
    assert.deepEqual([falhou.nome, falhou.erro, falhou.motivo, falhou.alvo_tipo], ["comentarios_v1", "ErroMigracao", "ITEM_INVALIDO", "TAREFA"]);
    assert.equal(eventos("DB_PRONTO")[0].comentarios_migrados, false);
    const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM comentarios");
    assert.equal(n, 0, "a cópia parcial (as entradas vieram antes) voltou atrás");
    assert.equal((await pool.query("SELECT 1 FROM migracoes WHERE nome = 'comentarios_v1'")).rows.length, 0);

    // o legado continua de pé: GET do jsonb, PATCH no jsonb, API nova em 503
    const e1 = ok(await chamar("GET", "/api/entries/e1")).entry;
    assert.deepEqual(ids(e1.threads), ["1001", "c1"]);
    const novo = { id: "1002", text: "no modo legado", createdAt: "2026-10-03T00:00:00.000Z" };
    ok(await chamar("PATCH", "/api/entries/e1", { threads: [...e1.threads, novo] }));
    const { rows: [linha] } = await pool.query("SELECT threads FROM entries WHERE id = 'e1'");
    assert.deepEqual(ids(linha.threads), ["1001", "c1", "1002"]);
    assert.deepEqual((await chamar("POST", "/api/comentarios", { alvo_tipo: "ENTRADA", alvo_id: "e1", texto: "x" })).json, { error: "comentarios_indisponiveis" });
    const { eventos: hist } = ok(await chamar("GET", "/api/historico/ENTRADA/e1"));
    assert.deepEqual(hist[0].mudancas.map((m) => m.campo), ["threads"], "no modo legado o array é campo auditado da entrada");

    // corrigido o item, a próxima subida migra — inclusive o que foi escrito no modo legado
    await pool.query(`UPDATE tasks SET comments = '[{"id":"ruim","text":"42"}]' WHERE id = 't1'`);
    logs = [];
    assert.deepEqual(await initDB(pool), { comentariosMigrados: true });
    const { rows } = await pool.query("SELECT id FROM comentarios WHERE alvo_tipo = 'ENTRADA' ORDER BY criado_em");
    assert.deepEqual(ids(rows), ["1001", "c1", "1002"]);
  }, { preparar: (pool) => semearLegado(pool, { comentariosDaTarefa: daTarefa }) });
});
