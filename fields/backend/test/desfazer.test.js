// O desfazer (agente/desfazer.js) sem banco: a escolha das ações (LIFO, janela, já feito, sem
// inverso), a guarda ALTERADO_DEPOIS, o payload de reversão derivado do MAPA do editor — e, com um
// db falso, que a inversão passa pelo SERVIÇO, grava o desfaz_id e volta atrás inteira quando
// recusa. O comportamento contra Postgres real está em agente_integracao.test.js.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DESFAZER_JANELA_MIN, EDITOR, INVERSOS, camposReversiveis, desfazerTurno, eventosAlheios,
  payloadDeReversao, selecionarAcoes,
} from "../src/agente/desfazer.js";
import { definirSaida } from "../src/lib/log.js";

let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });

const AGORA = new Date("2026-10-03T15:00:00Z");
const acao = (idx, extra = {}) => ({
  idx, tool: "EditarTarefa", acao: "EDITAR_TAREFA", entidade_tipo: "TAREFA", entidade_id: "t1",
  historico_id: 100 + idx, inverso: "REVERTER", resumo: `ação ${idx}`, desfazivel: true, desfeito_em: null, ...extra,
});
const turno = (acoes, criado = AGORA) => ({ id: "turno-1", acoes, criado_em: criado });

// ─── As tabelas ───

test("INVERSOS só usa os três verbos (ou null), e a janela padrão é 60 minutos", () => {
  for (const v of Object.values(INVERSOS)) assert.ok([null, "EXCLUIR", "RESTAURAR", "REVERTER"].includes(v));
  assert.equal(DESFAZER_JANELA_MIN, 60);
});

test("camposReversiveis: a lista explícita de cada editor (o desfazer só alcança o que o agente escreve)", () => {
  assert.deepEqual(new Set(camposReversiveis("EditarEntrada")), new Set(["tipo", "titulo", "conteudo", "tags", "data", "hora", "fixada"]));
  assert.deepEqual(new Set(camposReversiveis("EditarProjeto")), new Set(["nome", "status", "holder"]));
  assert.deepEqual(new Set(camposReversiveis("EditarFrente")), new Set(["nome"]));
  assert.deepEqual(new Set(camposReversiveis("EditarReuniao")), new Set(["titulo", "data", "inicio", "fim", "pauta", "must"]));
  assert.deepEqual(Object.keys(EDITOR).sort(), ["ENTRADA", "FRENTE", "PROJETO", "REUNIAO", "TAREFA"]);
});

test("payloadDeReversao: os valores `de`, só nas colunas que o editor alcança", () => {
  // ConcluirTarefa grava os dois eixos num evento: os dois voltam juntos.
  assert.deepEqual(payloadDeReversao("TAREFA", [
    { campo: "status", de: "Em andamento", para: "Concluído" },
    { campo: "kanban_status", de: "Fazendo", para: "Feito" },
  ]), { status: "Em andamento", kanban_status: "Fazendo" });
  // `sort_order` e `comments` são editáveis pela REST, não pelo agente: ficam onde estão.
  assert.deepEqual(payloadDeReversao("TAREFA", [
    { campo: "sort_order", de: 1, para: 2 }, { campo: "comments", de: [], para: [{}] }, { campo: "deadline", de: null, para: "2026-10-09" },
  ]), { deadline: null });
  assert.deepEqual(payloadDeReversao("ENTRADA", [{ campo: "threads", de: [], para: [] }, { campo: "tags", de: ["a"], para: ["a", "b"] }]), { tags: ["a"] });
  assert.deepEqual(payloadDeReversao("COMENTARIO", [{ campo: "texto", de: "a", para: "b" }]), {}, "comentário não tem editor");
  assert.deepEqual(payloadDeReversao("TAREFA", null), {});
});

// ─── A escolha ───

test("selecionarAcoes: turno inteiro em LIFO, pulando as sem inverso e as já desfeitas", () => {
  const r = selecionarAcoes(turno([
    acao(0), acao(1, { desfazivel: false, inverso: null }), acao(2), acao(3, { desfeito_em: "2026-10-03T15:00:00Z" }),
  ]), undefined, AGORA);
  assert.deepEqual(r.valor.map((a) => a.idx), [2, 0]);
});

test("selecionarAcoes: os motivos, cada um no seu caso", () => {
  const motivo = (t, idx, agora = AGORA) => selecionarAcoes(t, idx, agora).motivo;
  assert.equal(motivo(turno([]), undefined), "NADA_A_DESFAZER");
  assert.equal(motivo(turno([acao(0, { desfazivel: false })]), undefined), "SEM_INVERSO");
  assert.equal(motivo(turno([acao(0, { desfeito_em: "x" })]), undefined), "DESFAZER_JA_FEITO");
  assert.equal(motivo(turno([acao(0)]), 5), "NAO_ENCONTRADO");
  assert.equal(motivo(turno([acao(0, { desfazivel: false })]), 0), "SEM_INVERSO");
  assert.equal(motivo(turno([acao(0, { desfeito_em: "x" })]), 0), "DESFAZER_JA_FEITO");
  const depoisDaJanela = new Date(AGORA.getTime() + (DESFAZER_JANELA_MIN + 1) * 60_000);
  assert.equal(motivo(turno([acao(0)]), undefined, depoisDaJanela), "DESFAZER_EXPIRADO");
  assert.equal(motivo(turno([acao(0)]), 0, depoisDaJanela), "DESFAZER_EXPIRADO");
  const noLimite = new Date(AGORA.getTime() + DESFAZER_JANELA_MIN * 60_000);
  assert.ok(selecionarAcoes(turno([acao(0)]), 0, noLimite).ok, "exatamente na janela ainda vale");
});

test("eventosAlheios: só o desfazer e as ações já desfeitas DESTE turno são aceitáveis depois", () => {
  const desfeitos = new Set([102]);
  const posteriores = [
    { id: 102, turno_id: "turno-1", desfaz_id: null },  // ação 2 deste turno, já desfeita
    { id: 103, turno_id: "turno-1", desfaz_id: 102 },   // o desfazer dela
    { id: 104, turno_id: "turno-1", desfaz_id: null },  // ação deste turno AINDA de pé → LIFO
    { id: 105, turno_id: null, desfaz_id: null },       // a tela mexeu
    { id: 106, turno_id: "outro", desfaz_id: 90 },      // outro turno desfazendo algo
  ];
  assert.deepEqual(eventosAlheios(posteriores, "turno-1", desfeitos).map((e) => e.id), [104, 105, 106]);
});

test("eventosAlheios: o par escrita → desfazer de OUTRO turno, inteiro depois da ação, se anula", () => {
  const posteriores = [
    { id: 201, turno_id: "turno-2", desfaz_id: null },  // turno 2 excluiu a tarefa
    { id: 202, turno_id: "turno-2", desfaz_id: 201 },   // e foi desfeito: o par some
    { id: 203, turno_id: "turno-3", desfaz_id: null },  // turno 3 mexeu e NÃO foi desfeito
    { id: 204, turno_id: "turno-4", desfaz_id: 150 },   // desfaz algo de ANTES da ação: alheio
    { id: 205, turno_id: "turno-5", desfaz_id: 203 },   // "par" de turnos diferentes: não é par
  ];
  assert.deepEqual(eventosAlheios(posteriores, "turno-1", new Set()).map((e) => e.id), [203, 204, 205]);
});

// ─── O fluxo, com db falso ───

function dbFalso(responder = () => undefined) {
  const chamadas = [];
  const query = async (sql, params) => {
    chamadas.push({ sql: sql.trim(), params });
    return (await responder(sql.trim(), params)) ?? { rows: [], rowCount: 0 };
  };
  return { chamadas, query, connect: async () => ({ query, release() {} }) };
}

const CTX = { origem: "web", comentariosMigrados: true, agora: AGORA };

function dbDoTurno(acoes, { posteriores = [], naArvore = [] } = {}) {
  return dbFalso((sql, params) => {
    if (sql.startsWith("SELECT id, canal, acoes")) return { rows: [{ id: params[0], canal: "mcp", acoes, criado_em: AGORA, desfeito_em: null }] };
    if (sql.includes("FROM historico WHERE entidade_tipo = $1 AND entidade_id = $2 AND id > $3")) return { rows: posteriores };
    if (sql.includes("frentes_da_arvore")) return { rows: naArvore };
    if (sql.startsWith("UPDATE tasks SET deleted_at = NOW()")) return { rows: [{ id: params[0], deleted_at: new Date() }] };
    if (sql.startsWith("INSERT INTO historico")) return { rows: [{ id: "900" }] };
    return undefined;
  });
}

test("desfazer uma criação: exclui PELO SERVIÇO, grava desfaz_id e o turno, marca a ação, COMMIT", async () => {
  const criada = acao(0, { tool: "NovaTarefa", acao: "NOVA_TAREFA", inverso: "EXCLUIR", historico_id: 41, resumo: "Criou a tarefa “Deck”" });
  const db = dbDoTurno([criada]);
  const r = await desfazerTurno(db, CTX, { turnoId: "turno-1" });
  assert.deepEqual(r.valor, { desfeitas: [{ idx: 0, resumo: "Criou a tarefa “Deck”" }] });

  const sqls = db.chamadas.map((c) => c.sql);
  assert.equal(sqls[0], "BEGIN");
  assert.equal(sqls.at(-1), "COMMIT");
  assert.ok(sqls.some((s) => s.startsWith("UPDATE tasks SET deleted_at = NOW()") && s.includes("tarefas_visiveis")), "a exclusão lógica do serviço");
  const hist = db.chamadas.find((c) => c.sql.startsWith("INSERT INTO historico"));
  assert.deepEqual([hist.params[0], hist.params[2], hist.params[4], hist.params[5], hist.params[6]], ["TAREFA", "EXCLUIDO", "web", "turno-1", 41]);
  const marca = db.chamadas.find((c) => c.sql.includes("jsonb_set(acoes"));
  assert.deepEqual(marca.params, ["turno-1", "0", AGORA.toISOString()]);
  assert.ok(sqls.some((s) => s.startsWith("UPDATE agente_turnos SET desfeito_em = NOW()")));
  const [linha] = logs.filter((l) => l.evento === "AGENTE_DESFAZER");
  assert.deepEqual([linha.tool, linha.inverso, linha.entidade_tipo, linha.idx], ["NovaTarefa", "EXCLUIR", "TAREFA", 0]);
});

test("ALTERADO_DEPOIS: alguém mexeu depois → recusa, ROLLBACK, nada invertido, e o motivo no log", async () => {
  const db = dbDoTurno([acao(0)], { posteriores: [{ id: 150, entidade_tipo: "TAREFA", entidade_id: "t1", acao: "ATUALIZADO", mudancas: [], origem: "web", turno_id: null, desfaz_id: null, criado_em: AGORA }] });
  const r = await desfazerTurno(db, CTX, { turnoId: "turno-1" });
  assert.equal(r.motivo, "ALTERADO_DEPOIS");
  assert.equal(r.idx, 0);
  const sqls = db.chamadas.map((c) => c.sql);
  assert.equal(sqls.at(-1), "ROLLBACK");
  assert.ok(!sqls.some((s) => s.startsWith("UPDATE tasks") || s.startsWith("INSERT INTO historico")));
  const [linha] = logs.filter((l) => l.evento === "AGENTE_DESFAZER_RECUSA");
  assert.deepEqual([linha.motivo, linha.idx, linha.eventos_depois, linha.inteiro], ["ALTERADO_DEPOIS", 0, 1, true]);
});

test("EXCLUIR olha a ÁRVORE: tarefa criada pela tela dentro da frente do agente → ALTERADO_DEPOIS, nada excluído", async () => {
  // O inverso de NovaFrente esconde as tarefas dela (a view da cascata). Um evento de OUTRA
  // entidade — a tarefa nova — tem de barrar o desfazer como se fosse da própria frente.
  const criada = acao(0, { tool: "NovaFrente", acao: "NOVA_FRENTE", entidade_tipo: "FRENTE", entidade_id: "f1", inverso: "EXCLUIR", historico_id: 41 });
  const tarefaDaTela = { id: 60, entidade_tipo: "TAREFA", entidade_id: "t-tela", acao: "CRIADO", mudancas: [], origem: "web", turno_id: null, desfaz_id: null, criado_em: AGORA };
  const db = dbDoTurno([criada], { naArvore: [tarefaDaTela] });
  const r = await desfazerTurno(db, CTX, { turnoId: "turno-1" });
  assert.equal(r.motivo, "ALTERADO_DEPOIS");
  const arvore = db.chamadas.find((c) => c.sql.includes("frentes_da_arvore"));
  assert.deepEqual(arvore.params, ["FRENTE", "f1", 41], "a consulta da árvore, a partir do evento da criação");
  assert.ok(!db.chamadas.some((c) => c.sql.includes("FROM historico WHERE entidade_tipo = $1 AND entidade_id = $2 AND id > $3")),
    "EXCLUIR não usa a consulta só da entidade");
  assert.ok(!db.chamadas.some((c) => c.sql.startsWith("UPDATE frentes")), "nada foi escondido");
  assert.equal(db.chamadas.at(-1).sql, "ROLLBACK");
});

test("REVERTER olha só a própria entidade (editar não esconde nada)", async () => {
  const db = dbDoTurno([acao(0)]);
  await desfazerTurno(db, CTX, { turnoId: "turno-1" });
  assert.ok(db.chamadas.some((c) => c.sql.includes("FROM historico WHERE entidade_tipo = $1 AND entidade_id = $2 AND id > $3")));
  assert.ok(!db.chamadas.some((c) => c.sql.includes("frentes_da_arvore")));
});

test("turno inexistente → NAO_ENCONTRADO; expirado → DESFAZER_EXPIRADO, sem escrita", async () => {
  const vazio = dbFalso();
  assert.equal((await desfazerTurno(vazio, CTX, { turnoId: "nao-existe" })).motivo, "NAO_ENCONTRADO");
  const db = dbDoTurno([acao(0)]);
  const tarde = { ...CTX, agora: new Date(AGORA.getTime() + 2 * 3_600_000) };
  assert.equal((await desfazerTurno(db, tarde, { turnoId: "turno-1" })).motivo, "DESFAZER_EXPIRADO");
  assert.equal(db.chamadas.at(-1).sql, "ROLLBACK");
});
