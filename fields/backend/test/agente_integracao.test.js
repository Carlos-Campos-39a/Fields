// Integração da A2 (ontologia, ferramentas, desfazer) contra Postgres REAL. Pula sem
// TEST_DATABASE_URL, como integracao.test.js — e usa o mesmo desenho: um schema por teste, initDB
// nele (schema, seed, migração), app no ar, e o schema apagado no fim.
//
//   TEST_DATABASE_URL=postgres://u:p@localhost:5432/fields_teste npm test
//
// O que só o banco prova: a ação existe se e somente se a escrita foi gravada (mesmo tx); cada
// inverso (EXCLUIR, RESTAURAR, REVERTER) passa pelo serviço e grava desfaz_id; ALTERADO_DEPOIS;
// LIFO dentro do turno; a janela; a memória com teto e arquivamento; o resumo do dia.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { criarApp } from "../src/app.js";
import { carregarConfig } from "../src/config.js";
import { emitirCookieSessao, gerarHashSenha } from "../src/auth/sessao.js";
import { initDB } from "../src/db/schema.js";
import { executeWrite } from "../src/agente/ferramentas.js";
import { desfazerTurno } from "../src/agente/desfazer.js";
import { catalogo } from "../src/agente/catalogo.js";
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
    options: `-c TimeZone=America/Sao_Paulo -c search_path=${schema}`,
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

async function cenario(fn) {
  const banco = await bancoNovo();
  try {
    const estado = await initDB(banco.pool);
    const s = await subir(banco.pool, estado);
    try { await fn({ ...s, pool: banco.pool, estado }); } finally { await s.fechar(); }
  } finally { await banco.descartar(); }
}

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json)); return r.json; };
const op = (chamar, nome, args = {}, opcoes) => chamar("POST", `/api/ops/${nome}`, args, opcoes);
const desfazer = (chamar, corpo, opcoes) => chamar("POST", "/api/agente/desfazer", corpo, opcoes);
const AMANHA = () => somarDias(hojeISO(), 1);

async function arvoreBasica(chamar) {
  const p = ok(await op(chamar, "NovoProjeto", { nome: "McKinsey" })).resultado;
  const f = ok(await op(chamar, "NovaFrente", { projeto_id: p.projeto_id, nome: "Cobrança" })).resultado;
  const t = ok(await op(chamar, "NovaTarefa", { frente_id: f.frente_id, nome: "Revisar deck", prazo: AMANHA(), coluna: "Fazendo" })).resultado;
  return { p, f, t };
}

async function tarefa(pool, id) {
  const { rows: [linha] } = await pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
  return linha;
}

async function eventosDe(pool, tipo, id) {
  const { rows } = await pool.query(
    "SELECT id, acao, origem, turno_id, desfaz_id, mudancas FROM historico WHERE entidade_tipo = $1 AND entidade_id = $2 ORDER BY id", [tipo, id]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), desfaz_id: r.desfaz_id == null ? null : Number(r.desfaz_id) }));
}

// ─── A escrita e a ação no mesmo tx ───

test("POST /api/ops (MCP): NovaTarefa grava a tarefa, o histórico com origem mcp e o turno com a ação", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    assert.deepEqual(ok(await chamar("GET", "/api/ops")), JSON.parse(JSON.stringify(catalogo())));
    const { f } = await arvoreBasica(chamar);
    const r = ok(await op(chamar, "NovaTarefa", { frente_id: f.frente_id, nome: "Mandar proposta", prazo: "2030-01-10", inicio: "2030-01-02", coluna: "Espera" }));
    const { resultado, acao } = r;
    assert.deepEqual([resultado.nome, resultado.coluna, resultado.inicio, resultado.frente, resultado.projeto],
      ["Mandar proposta", "Espera", "2030-01-02", "Cobrança", "McKinsey"]);
    assert.deepEqual(Object.keys(acao).sort(), ["acao", "desfazivel", "idx", "resumo", "turno_id"]);
    assert.deepEqual([acao.acao, acao.idx, acao.desfazivel], ["NOVA_TAREFA", 0, true]);
    assert.equal(acao.resumo, "Criou a tarefa “Mandar proposta” na frente “Cobrança”, para 10/01");

    const { rows: [turno] } = await pool.query("SELECT canal, status, acoes, concluido_em FROM agente_turnos WHERE id = $1", [acao.turno_id]);
    assert.deepEqual([turno.canal, turno.status], ["mcp", "CONCLUIDO"]);
    assert.ok(turno.concluido_em instanceof Date);
    assert.equal(turno.acoes.length, 1);
    assert.deepEqual([turno.acoes[0].entidade_tipo, turno.acoes[0].entidade_id, turno.acoes[0].inverso], ["TAREFA", resultado.tarefa_id, "EXCLUIR"]);

    const eventos = await eventosDe(pool, "TAREFA", resultado.tarefa_id);
    assert.deepEqual(eventos.map((e) => [e.acao, e.origem, e.turno_id]), [["CRIADO", "mcp", acao.turno_id]], "UM evento: coluna e início nasceram juntos");
    assert.equal(eventos[0].id, turno.acoes[0].historico_id);
    const linha = await tarefa(pool, resultado.tarefa_id);
    assert.deepEqual([linha.kanban_status, linha.start_date], ["Espera", "2030-01-02"]);
  });
});

test("pela tela (cookie) a escrita é do canal web e o histórico diz origem web", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const r = ok(await op(chamar, "NovoProjeto", { nome: "Tese" }, { web: true }));
    const { rows: [turno] } = await pool.query("SELECT canal FROM agente_turnos WHERE id = $1", [r.acao.turno_id]);
    assert.equal(turno.canal, "web");
    assert.deepEqual((await eventosDe(pool, "PROJETO", r.resultado.projeto_id)).map((e) => e.origem), ["web"]);
  });
});

test("escrita recusada não deixa turno nem ação; erros do contrato: 404, 400 com campos", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const r = await op(chamar, "NovaFrente", { projeto_id: randomUUID(), nome: "F" });
    assert.equal(r.status, 404);
    assert.equal(r.json.codigo, "NAO_ENCONTRADO");
    assert.equal(typeof r.json.erro, "string");
    const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM agente_turnos");
    assert.equal(n, 0, "a linha do turno voltou atrás junto com a escrita");

    const desconhecida = await op(chamar, "ApagarTudo", {});
    assert.deepEqual([desconhecida.status, desconhecida.json.codigo], [404, "OPERACAO_INDISPONIVEL"]);
    const invalida = await op(chamar, "NovaTarefa", { nome: "sem frente", status: "Quase" });
    assert.equal(invalida.status, 400);
    assert.equal(invalida.json.codigo, "ARGUMENTOS_INVALIDOS");
    assert.deepEqual(Object.keys(invalida.json.campos).sort(), ["frente_id", "status"]);
  });
});

// ─── Cada inverso ───

test("EXCLUIR: desfazer a criação exclui (lógico) pelo serviço, com desfaz_id; de novo → 409 DESFAZER_JA_FEITO", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const { f } = await arvoreBasica(chamar);
    const r = ok(await op(chamar, "NovaTarefa", { frente_id: f.frente_id, nome: "Por engano" }));
    const d = ok(await desfazer(chamar, { turno_id: r.acao.turno_id }, { web: true }));
    assert.deepEqual(d, { desfeitas: [{ idx: 0, resumo: r.acao.resumo }] });

    assert.ok((await tarefa(pool, r.resultado.tarefa_id)).deleted_at instanceof Date, "exclusão lógica: a linha continua");
    const [criado, excluido] = await eventosDe(pool, "TAREFA", r.resultado.tarefa_id);
    assert.deepEqual([excluido.acao, excluido.origem, excluido.turno_id, excluido.desfaz_id], ["EXCLUIDO", "web", r.acao.turno_id, criado.id]);
    const { rows: [turno] } = await pool.query("SELECT acoes, desfeito_em FROM agente_turnos WHERE id = $1", [r.acao.turno_id]);
    assert.ok(turno.desfeito_em instanceof Date);
    assert.ok(turno.acoes[0].desfeito_em);

    const deNovo = await desfazer(chamar, { turno_id: r.acao.turno_id });
    assert.deepEqual([deNovo.status, deNovo.json.codigo], [409, "DESFAZER_JA_FEITO"]);
    const sumido = await desfazer(chamar, { turno_id: randomUUID() });
    assert.deepEqual([sumido.status, sumido.json.codigo], [404, "NAO_ENCONTRADO"]);
    const corpoRuim = await desfazer(chamar, { turno: "x" });
    assert.deepEqual([corpoRuim.status, corpoRuim.json.codigo], [400, "ARGUMENTOS_INVALIDOS"]);
  });
});

test("RESTAURAR: desfazer ExcluirTarefa devolve a tarefa; desfazer ExcluirProjeto devolve a árvore", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const { p, t } = await arvoreBasica(chamar);
    const ex = ok(await op(chamar, "ExcluirTarefa", { tarefa_id: t.tarefa_id }));
    assert.equal(ex.acao.resumo, "Excluiu a tarefa “Revisar deck”");
    assert.equal(ok(await op(chamar, "ConsultarTarefa", { tarefa_id: t.tarefa_id }), 404).codigo, "NAO_ENCONTRADO");
    ok(await desfazer(chamar, { turno_id: ex.acao.turno_id }));
    assert.equal(ok(await op(chamar, "ConsultarTarefa", { tarefa_id: t.tarefa_id })).resultado.tarefa.nome, "Revisar deck");
    const eventos = await eventosDe(pool, "TAREFA", t.tarefa_id);
    assert.equal(eventos.at(-1).acao, "RESTAURADO");
    assert.equal(eventos.at(-1).desfaz_id, eventos.at(-2).id);

    const exP = ok(await op(chamar, "ExcluirProjeto", { projeto_id: p.projeto_id }));
    assert.equal(ok(await op(chamar, "BuscarTarefas", { projeto_id: p.projeto_id })).resultado.total, 0, "a cascata esconde");
    ok(await desfazer(chamar, { turno_id: exP.acao.turno_id }));
    assert.equal(ok(await op(chamar, "BuscarTarefas", { projeto_id: p.projeto_id })).resultado.total, 1, "restaurar devolve a árvore");
  });
});

test("REVERTER: ConcluirTarefa volta os DOIS eixos; EditarTarefa volta prazo, holder e nome", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const { t } = await arvoreBasica(chamar);
    const c = ok(await op(chamar, "ConcluirTarefa", { tarefa_id: t.tarefa_id }));
    assert.deepEqual([c.resultado.status, c.resultado.coluna], ["Concluído", "Feito"]);
    ok(await desfazer(chamar, { turno_id: c.acao.turno_id }));
    let linha = await tarefa(pool, t.tarefa_id);
    assert.deepEqual([linha.status, linha.kanban_status], ["Pendente", "Fazendo"]);

    const e = ok(await op(chamar, "EditarTarefa", { tarefa_id: t.tarefa_id, prazo: null, holder: "Eles", nome: "Deck v2" }));
    assert.equal(e.acao.resumo, "Editou a tarefa “Deck v2”: prazo → sem valor; nome → “Deck v2”; responsável → com terceiros");
    ok(await desfazer(chamar, { turno_id: e.acao.turno_id }));
    linha = await tarefa(pool, t.tarefa_id);
    assert.deepEqual([linha.deadline, linha.holder, linha.name], [AMANHA(), "", "Revisar deck"]);
    const ultimo = (await eventosDe(pool, "TAREFA", t.tarefa_id)).at(-1);
    assert.equal(ultimo.origem, "mcp");
    assert.ok(ultimo.desfaz_id != null);

    // Entrada: tags (jsonb) e fixada voltam pelo mesmo caminho.
    const n = ok(await op(chamar, "NovaEntrada", { tipo: "note", titulo: "Ideia", tags: ["a"] })).resultado;
    const ed = ok(await op(chamar, "EditarEntrada", { entrada_id: n.entrada_id, tags: ["a", "b"], fixada: true }));
    ok(await desfazer(chamar, { turno_id: ed.acao.turno_id }));
    const { rows: [entrada] } = await pool.query("SELECT tags, pinned FROM entries WHERE id = $1", [n.entrada_id]);
    assert.deepEqual([entrada.tags, entrada.pinned], [["a"], false]);
  });
});

test("ALTERADO_DEPOIS: a tela mexeu depois da escrita do agente → 409, e nada muda", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const { t } = await arvoreBasica(chamar);
    const e = ok(await op(chamar, "EditarTarefa", { tarefa_id: t.tarefa_id, status: "Em andamento" }));
    ok(await chamar("PATCH", `/api/tasks/${t.tarefa_id}`, { name: "Mudado pela tela" }, { web: true }));
    const d = await desfazer(chamar, { turno_id: e.acao.turno_id });
    assert.deepEqual([d.status, d.json.codigo], [409, "ALTERADO_DEPOIS"]);
    const linha = await tarefa(pool, t.tarefa_id);
    assert.deepEqual([linha.status, linha.name], ["Em andamento", "Mudado pela tela"]);
    assert.ok(logs.some((l) => l.evento === "AGENTE_DESFAZER_RECUSA" && l.motivo === "ALTERADO_DEPOIS"));
  });
});

test("ALTERADO_DEPOIS na ÁRVORE: NovaFrente pelo MCP, tarefa criada nela pela tela → desfazer a frente é 409, e nada some", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const { p } = await arvoreBasica(chamar);
    const f = ok(await op(chamar, "NovaFrente", { projeto_id: p.projeto_id, nome: "Nova linha" }));
    const daTela = ok(await chamar("POST", `/api/frentes/${f.resultado.frente_id}/tasks`, { name: "Feita pela tela" }, { web: true }), 201).task;

    const d = await desfazer(chamar, { turno_id: f.acao.turno_id });
    assert.deepEqual([d.status, d.json.codigo], [409, "ALTERADO_DEPOIS"]);
    const { rows: [frente] } = await pool.query("SELECT deleted_at FROM frentes WHERE id = $1", [f.resultado.frente_id]);
    assert.equal(frente.deleted_at, null, "a frente continua de pé");
    assert.equal(ok(await op(chamar, "ConsultarTarefa", { tarefa_id: daTela.id })).resultado.tarefa.nome, "Feita pela tela");

    // O mesmo para o projeto (frente criada depois pela tela) e para o alvo de comentário.
    const np = ok(await op(chamar, "NovoProjeto", { nome: "Outro" }));
    ok(await chamar("POST", `/api/projects/${np.resultado.projeto_id}/frentes`, { name: "Da tela" }, { web: true }), 201);
    assert.equal((await desfazer(chamar, { turno_id: np.acao.turno_id })).json.codigo, "ALTERADO_DEPOIS");

    const nt = ok(await op(chamar, "NovaTarefa", { frente_id: f.resultado.frente_id, nome: "Do MCP" }));
    ok(await chamar("POST", "/api/comentarios", { alvo_tipo: "TAREFA", alvo_id: nt.resultado.tarefa_id, texto: "da tela" }, { web: true }), 201);
    assert.equal((await desfazer(chamar, { turno_id: nt.acao.turno_id })).json.codigo, "ALTERADO_DEPOIS");
    assert.equal((await tarefa(pool, nt.resultado.tarefa_id)).deleted_at, null);
  });
});

test("pilha entre turnos: concluir, excluir, desfazer a exclusão → a conclusão ainda se desfaz; com a tela no meio, não", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const { t } = await arvoreBasica(chamar);
    const ed = ok(await op(chamar, "EditarTarefa", { tarefa_id: t.tarefa_id, status: "Em andamento" }));
    const co = ok(await op(chamar, "ConcluirTarefa", { tarefa_id: t.tarefa_id }));
    const ex = ok(await op(chamar, "ExcluirTarefa", { tarefa_id: t.tarefa_id }));

    ok(await desfazer(chamar, { turno_id: ex.acao.turno_id }));
    // O par EXCLUIDO/RESTAURADO de outro turno se anula: o registro está como a conclusão o deixou.
    ok(await desfazer(chamar, { turno_id: co.acao.turno_id }));
    let linha = await tarefa(pool, t.tarefa_id);
    assert.deepEqual([linha.status, linha.kanban_status, linha.deleted_at], ["Em andamento", "Fazendo", null]);
    assert.equal((await desfazer(chamar, { turno_id: co.acao.turno_id })).json.codigo, "DESFAZER_JA_FEITO");

    // A tela mexeu depois: isso não se anula com nada.
    ok(await chamar("PATCH", `/api/tasks/${t.tarefa_id}`, { name: "Mudado pela tela" }, { web: true }));
    assert.equal((await desfazer(chamar, { turno_id: ed.acao.turno_id })).json.codigo, "ALTERADO_DEPOIS");
    linha = await tarefa(pool, t.tarefa_id);
    assert.deepEqual([linha.status, linha.name], ["Em andamento", "Mudado pela tela"]);
  });
});

test("ALTERADO_DEPOIS na árvore DENTRO do turno: desfazer só a NovaFrente com a NovaTarefa dela de pé recusa; o turno inteiro volta", { skip }, async () => {
  await cenario(async ({ chamar, pool, estado }) => {
    const { p } = await arvoreBasica(chamar);
    const turnoId = randomUUID();
    const ctxW = { db: pool, origem: "agente", comentariosMigrados: estado.comentariosMigrados, agora: new Date(), turnoId, canal: "web" };
    const f = await executeWrite("NovaFrente", { projeto_id: p.projeto_id, nome: "Linha" }, ctxW);
    const t = await executeWrite("NovaTarefa", { frente_id: f.resultado.frente_id, nome: "Dentro" }, ctxW);
    assert.deepEqual([f.acao.idx, t.acao.idx], [0, 1]);

    const ctxD = { origem: "web", comentariosMigrados: estado.comentariosMigrados, agora: new Date() };
    // Sem a guarda da árvore, isto escondia a tarefa — e desfazer o idx 1 depois dava NAO_ENCONTRADO.
    assert.equal((await desfazerTurno(pool, ctxD, { turnoId, idx: 0 })).motivo, "ALTERADO_DEPOIS");
    assert.equal((await tarefa(pool, t.resultado.tarefa_id)).deleted_at, null);

    const tudo = await desfazerTurno(pool, ctxD, { turnoId });
    assert.deepEqual(tudo.valor.desfeitas.map((x) => x.idx), [1, 0], "LIFO: a tarefa sai primeiro, depois a frente");
    assert.ok((await tarefa(pool, t.resultado.tarefa_id)).deleted_at instanceof Date);
  });
});

test("LIFO: duas edições no mesmo turno — desfazer só a primeira recusa; o turno inteiro volta à origem", { skip }, async () => {
  await cenario(async ({ chamar, pool, estado }) => {
    const { t } = await arvoreBasica(chamar);
    const turnoId = randomUUID();
    const ctxW = { db: pool, origem: "agente", comentariosMigrados: estado.comentariosMigrados, agora: new Date(), turnoId, canal: "web" };
    const a = await executeWrite("EditarTarefa", { tarefa_id: t.tarefa_id, nome: "B" }, ctxW);
    const b = await executeWrite("EditarTarefa", { tarefa_id: t.tarefa_id, nome: "C" }, ctxW);
    assert.deepEqual([a.acao.idx, b.acao.idx, a.acao.turno_id], [0, 1, turnoId]);

    const ctxD = { origem: "web", comentariosMigrados: estado.comentariosMigrados, agora: new Date() };
    assert.equal((await desfazerTurno(pool, ctxD, { turnoId, idx: 0 })).motivo, "ALTERADO_DEPOIS", "a de cima ainda está de pé");
    const tudo = await desfazerTurno(pool, ctxD, { turnoId });
    assert.deepEqual(tudo.valor.desfeitas.map((d) => d.idx), [1, 0]);
    assert.equal((await tarefa(pool, t.tarefa_id)).name, "Revisar deck");
    const eventos = await eventosDe(pool, "TAREFA", t.tarefa_id);
    const [desfazB, desfazA] = eventos.slice(-2);
    assert.equal(desfazB.desfaz_id, b.acao.historico_id);
    assert.equal(desfazA.desfaz_id, a.acao.historico_id);
  });
});

test("janela: turno mais velho que DESFAZER_JANELA_MIN → 409 DESFAZER_EXPIRADO; Lembrar → SEM_INVERSO", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    const { f } = await arvoreBasica(chamar);
    const r = ok(await op(chamar, "NovaTarefa", { frente_id: f.frente_id, nome: "Velha" }));
    await pool.query("UPDATE agente_turnos SET criado_em = NOW() - INTERVAL '2 hours' WHERE id = $1", [r.acao.turno_id]);
    const d = await desfazer(chamar, { turno_id: r.acao.turno_id });
    assert.deepEqual([d.status, d.json.codigo], [409, "DESFAZER_EXPIRADO"]);
    assert.equal((await tarefa(pool, r.resultado.tarefa_id)).deleted_at, null);

    const l = ok(await op(chamar, "Lembrar", { texto: "prefiro resumo curto" }));
    assert.equal(l.acao.desfazivel, false);
    const s = await desfazer(chamar, { turno_id: l.acao.turno_id, idx: 0 });
    assert.deepEqual([s.status, s.json.codigo], [409, "SEM_INVERSO"]);
  });
});

// ─── Memória ───

test("memória: teto de 20 ativas → MEMORIA_CHEIA; Esquecer ambíguo → AMBIGUO com candidatos; arquiva sem apagar", { skip }, async () => {
  await cenario(async ({ chamar, pool }) => {
    for (let i = 0; i < 20; i++) ok(await op(chamar, "Lembrar", { texto: `lembrete número ${i}` }));
    const cheia = await op(chamar, "Lembrar", { texto: "o vigésimo primeiro" });
    assert.deepEqual([cheia.status, cheia.json.codigo, cheia.json.limite], [409, "MEMORIA_CHEIA", 20]);

    const ambiguo = await op(chamar, "Esquecer", { trecho: "lembrete" });
    assert.deepEqual([ambiguo.status, ambiguo.json.codigo, ambiguo.json.candidatos.length], [409, "AMBIGUO", 20]);
    const nada = await op(chamar, "Esquecer", { trecho: "inexistente" });
    assert.deepEqual([nada.status, nada.json.codigo], [404, "NAO_ENCONTRADA"]);

    const esquecida = ok(await op(chamar, "Esquecer", { trecho: "NUMERO 7" })).resultado;
    assert.equal(esquecida.texto, "lembrete número 7", "sem caixa e sem acento");
    const { rows: [linha] } = await pool.query("SELECT status, arquivado_em FROM memorias WHERE id = $1", [esquecida.memoria_id]);
    assert.equal(linha.status, "ARQUIVADA");
    assert.ok(linha.arquivado_em instanceof Date);
    ok(await op(chamar, "Lembrar", { texto: "agora cabe" }), 200);
  });
});

// ─── Leituras ───

test("ResumoDoDia e GET /api/resumo-do-dia: o mesmo formato — reunião do dia, tarefa vencendo e atrasada, lembrete", { skip }, async () => {
  await cenario(async ({ chamar }) => {
    const hoje = hojeISO();
    const ontem = somarDias(hoje, -1);
    const { f } = await arvoreBasica(chamar);
    ok(await op(chamar, "NovaReuniao", { titulo: "Banca", data: hoje, inicio: "10:00" }));
    ok(await op(chamar, "NovaTarefa", { frente_id: f.frente_id, nome: "Vence hoje", prazo: hoje }));
    ok(await op(chamar, "NovaTarefa", { frente_id: f.frente_id, nome: "Atrasada", prazo: ontem }));
    const feita = ok(await op(chamar, "NovaTarefa", { frente_id: f.frente_id, nome: "Feita", prazo: ontem })).resultado;
    ok(await op(chamar, "ConcluirTarefa", { tarefa_id: feita.tarefa_id }));
    ok(await op(chamar, "NovaEntrada", { tipo: "reminder", titulo: "Pagar boleto", data: hoje, hora: "09:00" }));

    const rota = ok(await chamar("GET", `/api/resumo-do-dia?data=${hoje}`, undefined, { web: true })).resultado;
    assert.deepEqual(ok(await op(chamar, "ResumoDoDia", { data: hoje })).resultado, rota);
    assert.equal(rota.data, hoje);
    assert.deepEqual(rota.reunioes.map((r) => r.titulo), ["Banca"]);
    assert.deepEqual(rota.tarefas.map((t) => [t.nome, t.atrasada]).sort(), [["Atrasada", true], ["Vence hoje", false]]);
    assert.ok(rota.tarefas.every((t) => t.tarefa_id && t.frente === "Cobrança"), "ids e nomes juntos");
    assert.deepEqual(rota.lembretes.map((e) => e.titulo), ["Pagar boleto"]);
    assert.deepEqual(ok(await chamar("GET", "/api/resumo-do-dia")).resultado.data, hoje, "sem data → hoje");
    assert.equal((await chamar("GET", "/api/resumo-do-dia?data=03-10-2026")).status, 400);
  });
});

test("BuscarTarefas acha sem acento e sem caixa; NovoComentario aparece em ConsultarTarefa e se desfaz", { skip }, async () => {
  await cenario(async ({ chamar }) => {
    const { f } = await arvoreBasica(chamar);
    const t = ok(await op(chamar, "NovaTarefa", { frente_id: f.frente_id, nome: "Reunião com o Conselho" })).resultado;
    const achadas = ok(await op(chamar, "BuscarTarefas", { texto: "REUNIAO" })).resultado.tarefas;
    assert.deepEqual(achadas.map((x) => x.tarefa_id), [t.tarefa_id]);

    const c = ok(await op(chamar, "NovoComentario", { alvo_tipo: "TAREFA", alvo_id: t.tarefa_id, texto: "primeiro" }));
    assert.equal(c.acao.resumo, "Comentou na tarefa “Reunião com o Conselho”");
    assert.deepEqual(ok(await op(chamar, "ConsultarTarefa", { tarefa_id: t.tarefa_id })).resultado.comentarios.map((x) => x.texto), ["primeiro"]);
    ok(await desfazer(chamar, { turno_id: c.acao.turno_id }));
    assert.deepEqual(ok(await op(chamar, "ConsultarTarefa", { tarefa_id: t.tarefa_id })).resultado.comentarios, []);

    const hist = ok(await op(chamar, "HistoricoEntidade", { entidade_tipo: "COMENTARIO", entidade_id: c.resultado.comentario_id })).resultado;
    assert.deepEqual(hist.eventos.map((e) => [e.acao, e.desfez_outro]), [["EXCLUIDO", true], ["CRIADO", false]]);
  });
});
