// A2c · a Lixeira e os Restaurar* sem banco: o item na chave do Restaurar* do tipo, o pai a
// restaurar antes (o mais ALTO da árvore), uma consulta por entidade com carimbo e janela, a recusa
// PAI_EXCLUIDO que volta tudo atrás antes de escrever, o ESCONDIDO_PELO_PAI (sumido sem carimbo
// próprio) separado do NAO_ESTA_NA_LIXEIRA, o ExcluirComentario com
// o id que as leituras passaram a trazer, e o status HTTP de cada recusa nova. O comportamento contra
// Postgres real (a Lixeira não mostra o vivo; restaurar → desfazer → excluído de novo) está em
// agente_integracao.test.js.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { itemDaLinha, itemDaLixeira, listarLixeira, paiExcluido } from "../src/servicos/lixeira.js";
import { comentariosDoAgente } from "../src/servicos/serializadores.js";
import { executeRead, executeWrite, mensagemDaRecusa } from "../src/agente/ferramentas.js";
import { ENTIDADES } from "../src/dominio/enums.js";
import { criarApp } from "../src/app.js";
import { carregarConfig } from "../src/config.js";
import { gerarHashSenha } from "../src/auth/sessao.js";
import { definirSaida } from "../src/lib/log.js";

// O await fica ANTES de qualquer test(): com ele no meio, o runner encerra o primeiro lote (e roda o
// after, que solta a captura do log) antes de o resto do arquivo ser registrado.
const TOKEN = "token-do-mcp-de-teste-0123456789abcdef";
const config = carregarConfig({
  DATABASE_URL: "postgres://nao-usado",
  FIELDS_SENHA_HASH: await gerarHashSenha("senha de teste da lixeira"),
  FIELDS_SEGREDO_SESSAO: "segredo-de-sessao-de-teste-0123456789",
  FIELDS_API_TOKEN: TOKEN,
});

let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });
const eventos = (nome) => logs.filter((l) => l.evento === nome);

/** db falso: registra cada query (BEGIN/COMMIT/ROLLBACK incluídos) e responde com `responder`. */
function dbFalso(responder = () => undefined) {
  const chamadas = [];
  const query = async (sql, params) => {
    chamadas.push({ sql: sql.trim(), params });
    return (await responder(sql.trim(), params)) ?? { rows: [], rowCount: 0 };
  };
  return { chamadas, query, connect: async () => ({ query, release() {} }) };
}
const MIGRADO = { comentariosMigrados: true };
const LEGADO = { comentariosMigrados: false };
const ctx = (db, extra = {}) => ({ db, origem: "mcp", comentariosMigrados: true, agora: new Date("2026-10-10T15:00:00Z"), ...extra });

const ONTEM = new Date("2026-10-09T13:00:00Z");
const ANTEONTEM = new Date("2026-10-08T13:00:00Z");

// As linhas que as consultas da Lixeira devolvem, por tipo (as colunas são as do SELECT de cada uma).
const linhaTarefa = (extra = {}) => ({
  id: "t1", name: "Revisar deck", deleted_at: ONTEM,
  frente_id: "f1", frente_nome: "Cobrança", frente_excluida_em: null,
  projeto_id: "p1", projeto_nome: "McKinsey", projeto_excluido_em: null, ...extra,
});
const linhaComentario = (extra = {}) => ({
  id: "c1", texto: "ligar para a Ana", alvo_tipo: "TAREFA", alvo_id: "t1", deleted_at: ONTEM,
  alvo_nome: "Revisar deck", alvo_existe: true, alvo_excluido_em: null,
  frente_id: "f1", frente_nome: "Cobrança", frente_excluida_em: null,
  projeto_id: "p1", projeto_nome: "McKinsey", projeto_excluido_em: null, ...extra,
});

// ─── O item (puro) ───

test("itemDaLinha: o id na chave do Restaurar* do tipo, excluido_em em ISO, e sem `pai` quando nada acima está excluído", () => {
  assert.deepEqual(itemDaLinha("ENTRADA", { id: "e1", title: "Ideia", type: "note", date: "", deleted_at: ONTEM }), {
    entidade_tipo: "ENTRADA", entrada_id: "e1", titulo: "Ideia", tipo: "note", data: null,
    excluido_em: ONTEM.toISOString(), pai_excluido: false,
  });
  assert.deepEqual(itemDaLinha("TAREFA", linhaTarefa()), {
    entidade_tipo: "TAREFA", tarefa_id: "t1", nome: "Revisar deck", frente_id: "f1", frente: "Cobrança",
    projeto_id: "p1", projeto: "McKinsey", excluido_em: ONTEM.toISOString(), pai_excluido: false,
  });
  assert.deepEqual(itemDaLinha("REUNIAO", { id: "r1", title: "Banca", date: "2026-10-12", start_time: "", deleted_at: ONTEM }), {
    entidade_tipo: "REUNIAO", reuniao_id: "r1", titulo: "Banca", data: "2026-10-12", inicio: null,
    excluido_em: ONTEM.toISOString(), pai_excluido: false,
  });
  const c = itemDaLinha("COMENTARIO", linhaComentario({ texto: "x".repeat(300) }));
  assert.equal(c.comentario_id, "c1");
  assert.equal(c.texto.length, 201, "um trecho, como nas outras listas do agente");
  assert.deepEqual([c.alvo_tipo, c.alvo_id, c.alvo_nome, c.pai_excluido, "pai" in c], ["TAREFA", "t1", "Revisar deck", false, false]);
});

test("paiExcluido aponta o ancestral mais ALTO (projeto antes da frente); no comentário, o que esconde o alvo", () => {
  const p = { entidade_tipo: "PROJETO", entidade_id: "p1", nome: "McKinsey" };
  const f = { entidade_tipo: "FRENTE", entidade_id: "f1", nome: "Cobrança" };
  // Com os dois excluídos, apontar a frente trocaria uma recusa pela seguinte.
  assert.deepEqual(paiExcluido("TAREFA", linhaTarefa({ frente_excluida_em: ONTEM, projeto_excluido_em: ANTEONTEM })), p);
  assert.deepEqual(paiExcluido("TAREFA", linhaTarefa({ frente_excluida_em: ONTEM })), f);
  assert.deepEqual(paiExcluido("FRENTE", { id: "f1", name: "Cobrança", deleted_at: ONTEM, projeto_id: "p1", projeto_nome: "McKinsey", projeto_excluido_em: ONTEM }), p);
  assert.equal(paiExcluido("PROJETO", { id: "p1", name: "McKinsey", deleted_at: ONTEM }), null);

  // Comentário: a tarefa-alvo viva, mas a frente dela excluída → a frente; o alvo excluído → o alvo.
  assert.deepEqual(paiExcluido("COMENTARIO", linhaComentario({ frente_excluida_em: ONTEM })), f);
  const naEntrada = linhaComentario({
    alvo_tipo: "ENTRADA", alvo_id: "e1", alvo_nome: "Ideia", alvo_excluido_em: ONTEM,
    frente_id: null, frente_nome: null, projeto_id: null, projeto_nome: null,
  });
  assert.deepEqual(paiExcluido("COMENTARIO", naEntrada), { entidade_tipo: "ENTRADA", entidade_id: "e1", nome: "Ideia" });
  const item = itemDaLinha("COMENTARIO", naEntrada);
  assert.equal(item.pai_excluido, true);
  assert.deepEqual(item.pai, { entidade_tipo: "ENTRADA", entidade_id: "e1", nome: "Ideia" });

  // Alvo que nem existe: pai_excluido, mas sem `pai` — não há o que restaurar antes.
  const orfao = itemDaLinha("COMENTARIO", linhaComentario({ alvo_existe: false, alvo_nome: null }));
  assert.deepEqual([orfao.pai_excluido, "pai" in orfao], [true, false]);
});

// ─── As consultas ───

function dbDaLixeira(porTabela = {}) {
  return dbFalso((sql) => {
    for (const [tabela, rows] of Object.entries(porTabela)) {
      if (sql.includes(`FROM ${tabela} x`)) return { rows };
    }
    return undefined;
  });
}

test("listarLixeira: uma consulta por ENTIDADE, toda com carimbo e janela; junta, ordena pela exclusão e corta no limite", async () => {
  const db = dbDaLixeira({
    entries: [{ id: "e1", title: "Ideia", type: "note", date: "2026-10-01", deleted_at: ANTEONTEM }],
    tasks: [linhaTarefa({ deleted_at: ONTEM }), linhaTarefa({ id: "t2", name: "Velha", deleted_at: new Date("2026-10-01T10:00:00Z") })],
  });
  const r = await listarLixeira(db, MIGRADO, { desdeDias: 30, limite: 2 });
  assert.ok(r.ok);
  assert.deepEqual(r.valor.itens.map((i) => i.entidade_tipo + ":" + (i.tarefa_id ?? i.entrada_id)), ["TAREFA:t1", "ENTRADA:e1"], "a mais recente primeiro; a terceira passou do limite");
  assert.equal(r.valor.comentariosIndisponiveis, false);

  // A guarda de cobertura: uma ENTIDADE nova sem consulta aqui quebraria a lista inteira.
  assert.equal(db.chamadas.length, ENTIDADES.length);
  for (const { sql, params } of db.chamadas) {
    assert.match(sql, /WHERE x\.deleted_at IS NOT NULL/, "só o que tem o PRÓPRIO carimbo (o escondido pela cascata não entra)");
    assert.match(sql, /x\.deleted_at >= NOW\(\) - make_interval\(days => \$1::int\)/);
    assert.match(sql, /ORDER BY x\.deleted_at DESC, x\.id\s+LIMIT \$2::int$/);
    assert.deepEqual(params, [30, 2]);
    assert.doesNotMatch(sql, /FOR SHARE/, "listar não trava nada");
  }
});

test("listarLixeira: `tipo` faz uma consulta só; no modo legado os comentários saem — e a ausência é dita; COMENTARIO pedido no legado recusa", async () => {
  const so = dbDaLixeira();
  assert.ok((await listarLixeira(so, MIGRADO, { tipo: "TAREFA" })).ok);
  assert.equal(so.chamadas.length, 1);
  assert.ok(so.chamadas[0].sql.includes("FROM tasks x"));

  const legado = dbDaLixeira();
  const r = await listarLixeira(legado, LEGADO, {});
  assert.equal(r.valor.comentariosIndisponiveis, true);
  assert.equal(legado.chamadas.length, ENTIDADES.length - 1);
  assert.ok(!legado.chamadas.some((c) => c.sql.includes("FROM comentarios x")));

  assert.equal((await listarLixeira(dbFalso(), LEGADO, { tipo: "COMENTARIO" })).motivo, "COMENTARIOS_INDISPONIVEIS");
  assert.equal((await listarLixeira(dbFalso(), MIGRADO, { tipo: "MEMORIA" })).motivo, "TIPO_INVALIDO");
});

test("itemDaLixeira: sem janela; fora da Lixeira → NAO_ESTA_NA_LIXEIRA; travar segura os pais da frente e da tarefa, nunca o comentário", async () => {
  const vazio = dbFalso();
  assert.equal((await itemDaLixeira(vazio, MIGRADO, "TAREFA", "t-vivo")).motivo, "NAO_ESTA_NA_LIXEIRA");
  assert.match(vazio.chamadas[0].sql, /WHERE x\.deleted_at IS NOT NULL\s+AND x\.id = \$1/, "primeiro, o próprio carimbo");
  assert.doesNotMatch(vazio.chamadas[0].sql, /make_interval/, "a exclusão de meses atrás também volta");
  assert.deepEqual(vazio.chamadas[0].params, ["t-vivo"]);

  const trava = async (tipo) => {
    const db = dbFalso();
    await itemDaLixeira(db, MIGRADO, tipo, "x1", { travar: true });
    return db.chamadas[0].sql;
  };
  assert.match(await trava("TAREFA"), /FOR SHARE OF f, p$/);
  assert.match(await trava("FRENTE"), /FOR SHARE OF p$/);
  // LEFT JOIN não aceita FOR SHARE do lado anulável: o comentário confere o alvo no serviço.
  assert.doesNotMatch(await trava("COMENTARIO"), /FOR SHARE/);
  assert.doesNotMatch(await trava("PROJETO"), /FOR SHARE/, "sem pai: a trava da linha é a do restaurarLogico");
  assert.equal((await itemDaLixeira(dbFalso(), LEGADO, "COMENTARIO", "c1")).motivo, "COMENTARIOS_INDISPONIVEIS");
});

// db em que nada tem o próprio carimbo e a leitura SEM carimbo acha `linha`.
const semCarimbo = (linha) => dbFalso((sql) => (/WHERE x\.deleted_at IS NULL\s/.test(sql) ? { rows: [linha] } : undefined));

test("itemDaLixeira: sem carimbo próprio e escondido por um pai excluído → ESCONDIDO_PELO_PAI com o `pai`; à vista → NAO_ESTA_NA_LIXEIRA; tipo sem pai lê uma vez só", async () => {
  // O caso que motivou a recusa: a tarefa nunca foi excluída, o projeto dela foi (pela tela), e o
  // modelo ainda tem o tarefa_id de uma busca anterior. "Nunca foi excluído" seria a resposta errada.
  const escondida = semCarimbo(linhaTarefa({ deleted_at: null, projeto_excluido_em: ONTEM }));
  assert.deepEqual(await itemDaLixeira(escondida, MIGRADO, "TAREFA", "t1", { travar: true }), {
    ok: false, motivo: "ESCONDIDO_PELO_PAI", pai: { entidade_tipo: "PROJETO", entidade_id: "p1", nome: "McKinsey" },
  });
  // A mesma consulta, só com o predicado trocado: mesmos JOINs, mesmo id, mesma trava.
  const [comCarimboSql, semCarimboSql] = escondida.chamadas.map((c) => c.sql);
  assert.equal(escondida.chamadas.length, 2);
  assert.equal(semCarimboSql, comCarimboSql.replace("x.deleted_at IS NOT NULL", "x.deleted_at IS NULL"));
  assert.deepEqual(escondida.chamadas[1].params, ["t1"]);
  assert.match(semCarimboSql, /FOR SHARE OF f, p$/);

  // O mais ALTO, como no PAI_EXCLUIDO: com a frente e o projeto excluídos, o projeto.
  const duasCamadas = semCarimbo(linhaTarefa({ deleted_at: null, frente_excluida_em: ONTEM, projeto_excluido_em: ANTEONTEM }));
  assert.equal((await itemDaLixeira(duasCamadas, MIGRADO, "TAREFA", "t1")).pai.entidade_tipo, "PROJETO");

  // Frente escondida pelo projeto; comentário vivo de uma tarefa excluída → a tarefa.
  const frente = semCarimbo({ id: "f1", name: "Cobrança", deleted_at: null, projeto_id: "p1", projeto_nome: "McKinsey", projeto_excluido_em: ONTEM });
  assert.deepEqual((await itemDaLixeira(frente, MIGRADO, "FRENTE", "f1")).pai, { entidade_tipo: "PROJETO", entidade_id: "p1", nome: "McKinsey" });
  const comentario = await itemDaLixeira(semCarimbo(linhaComentario({ deleted_at: null, alvo_excluido_em: ONTEM })), MIGRADO, "COMENTARIO", "c1");
  assert.deepEqual([comentario.motivo, comentario.pai], ["ESCONDIDO_PELO_PAI", { entidade_tipo: "TAREFA", entidade_id: "t1", nome: "Revisar deck" }]);

  // Sem carimbo e nada excluído acima: está à vista — NAO_ESTA_NA_LIXEIRA, sem `pai`.
  assert.deepEqual(await itemDaLixeira(semCarimbo(linhaTarefa({ deleted_at: null })), MIGRADO, "TAREFA", "t1"), { ok: false, motivo: "NAO_ESTA_NA_LIXEIRA" });
  assert.deepEqual(await itemDaLixeira(semCarimbo(linhaComentario({ deleted_at: null })), MIGRADO, "COMENTARIO", "c1"), { ok: false, motivo: "NAO_ESTA_NA_LIXEIRA" });

  // Entrada, projeto e reunião não têm pai que os esconda: uma leitura só.
  for (const tipo of ["ENTRADA", "PROJETO", "REUNIAO"]) {
    const db = semCarimbo({ id: "x1", deleted_at: null });
    assert.equal((await itemDaLixeira(db, MIGRADO, tipo, "x1")).motivo, "NAO_ESTA_NA_LIXEIRA", tipo);
    assert.equal(db.chamadas.length, 1, tipo);
  }
});

// ─── A ferramenta Lixeira ───

test("Lixeira (executeRead): desde_dias padrão 30, total, e o aviso de comentários indisponíveis só no legado", async () => {
  const db = dbDaLixeira({ projects: [{ id: "p1", name: "McKinsey", deleted_at: ONTEM }] });
  const r = await executeRead("Lixeira", {}, ctx(db));
  assert.deepEqual(r.resultado, {
    desde_dias: 30, total: 1,
    itens: [{ entidade_tipo: "PROJETO", projeto_id: "p1", nome: "McKinsey", excluido_em: ONTEM.toISOString(), pai_excluido: false }],
  });
  assert.deepEqual(db.chamadas[0].params, [30, 30]);

  const legado = await executeRead("Lixeira", { tipo: "PROJETO", desde_dias: 7, limite: 5 }, ctx(dbDaLixeira(), { comentariosMigrados: false }));
  assert.deepEqual(legado.resultado, { desde_dias: 7, itens: [], total: 0 }, "com tipo explícito, nada a avisar");
  const todos = await executeRead("Lixeira", {}, ctx(dbDaLixeira(), { comentariosMigrados: false }));
  assert.equal(todos.resultado.comentarios_indisponiveis, true);

  assert.equal((await executeRead("Lixeira", { desde_dias: 0 }, ctx(dbFalso()))).codigo, "ARGUMENTOS_INVALIDOS");
  assert.equal((await executeRead("Lixeira", { tipo: "MEMORIA" }, ctx(dbFalso()))).codigo, "ARGUMENTOS_INVALIDOS");
});

// ─── Restaurar* ───

const historicoOk = (sql) => (sql.startsWith("INSERT INTO historico") ? { rows: [{ id: "77" }] } : undefined);
const turnoOk = (sql) => (sql.startsWith("SELECT jsonb_array_length(acoes)") ? { rows: [{ n: 0 }] } : undefined);

test("RestaurarFrente com o projeto excluído → PAI_EXCLUIDO com o pai; ROLLBACK sem nenhuma escrita; o log leva o código, não o nome", async () => {
  const db = dbFalso((sql) => {
    if (sql.includes("FROM frentes x")) {
      return { rows: [{ id: "f1", name: "Cobrança", deleted_at: ONTEM, projeto_id: "p1", projeto_nome: "McKinsey", projeto_excluido_em: ANTEONTEM }] };
    }
    return undefined;
  });
  const r = await executeWrite("RestaurarFrente", { frente_id: "f1" }, ctx(db, { turnoId: "turno-1" }));
  assert.deepEqual(r, {
    erro: mensagemDaRecusa("PAI_EXCLUIDO"), codigo: "PAI_EXCLUIDO",
    pai: { entidade_tipo: "PROJETO", entidade_id: "p1", nome: "McKinsey" },
  });
  const sqls = db.chamadas.map((c) => c.sql);
  assert.equal(sqls.at(-1), "ROLLBACK");
  assert.ok(!sqls.some((s) => /^UPDATE (frentes|agente_turnos)|^INSERT INTO historico/.test(s)), "nada escrito: nem o carimbo, nem a ação");
  assert.match(sqls.find((s) => s.includes("FROM frentes x")), /FOR SHARE OF p$/, "o pai travado entre a conferência e a escrita");

  const [linha] = eventos("AGENTE_TOOL_ERRO");
  assert.deepEqual([linha.tool, linha.codigo, linha.nivel], ["RestaurarFrente", "PAI_EXCLUIDO", "warn"]);
  assert.ok(!JSON.stringify(logs).includes("McKinsey"), "nome é dado do Carlos: vai ao modelo, nunca ao log");
});

test("RestaurarTarefa: confere na Lixeira, restaura pelo serviço, relê pela view e anota a ação com inverso EXCLUIR", async () => {
  const db = dbFalso((sql) => {
    if (sql.includes("FROM tasks x")) return { rows: [linhaTarefa()] };
    if (sql.startsWith("SELECT id, deleted_at FROM tasks")) return { rows: [{ id: "t1", deleted_at: ONTEM }] };
    if (sql.startsWith("UPDATE tasks SET deleted_at = NULL")) return { rows: [{ id: "t1", deleted_at: null }] };
    if (sql.includes("FROM tarefas_visiveis t")) {
      return { rows: [{ id: "t1", name: "Revisar deck", acao: "", status: "Pendente", kanban_status: "A fazer", deadline: null, start_date: null, holder: "Nós", stakeholder: "", frente_id: "f1", frente_nome: "Cobrança", projeto_id: "p1", projeto_nome: "McKinsey" }] };
    }
    return historicoOk(sql) ?? turnoOk(sql);
  });
  const r = await executeWrite("RestaurarTarefa", { tarefa_id: "t1" }, ctx(db, { turnoId: "turno-2" }));
  assert.equal(r.resultado.tarefa_id, "t1");
  assert.equal(r.resultado.restaurada, true);
  assert.equal(r.resultado.comentarios, undefined, "a saída da escrita não carrega o fio de comentários");
  assert.deepEqual(
    [r.acao.acao, r.acao.entidade_tipo, r.acao.entidade_id, r.acao.inverso, r.acao.historico_id, r.acao.desfazivel, r.acao.resumo],
    ["RESTAURAR_TAREFA", "TAREFA", "t1", "EXCLUIR", 77, true, "Restaurou a tarefa “Revisar deck”"]
  );
  const sqls = db.chamadas.map((c) => c.sql);
  const ordem = ["FROM tasks x", "SELECT id, deleted_at FROM tasks", "UPDATE tasks SET deleted_at = NULL", "FROM tarefas_visiveis t"]
    .map((trecho) => sqls.findIndex((s) => s.includes(trecho)));
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, "Lixeira → carimbo → releitura, nessa ordem");
  assert.ok(ordem.every((i) => i > 0));
  assert.match(sqls[ordem[0]], /FOR SHARE OF f, p$/);
  const hist = db.chamadas.find((c) => c.sql.startsWith("INSERT INTO historico"));
  assert.deepEqual([hist.params[0], hist.params[2], hist.params[4]], ["TAREFA", "RESTAURADO", "mcp"]);
  assert.equal(sqls.at(-1), "COMMIT");
});

test("Restaurar* de algo fora da Lixeira (vivo, já restaurado, inexistente) → NAO_ESTA_NA_LIXEIRA, sem escrever", async () => {
  for (const [nome, args] of [["RestaurarEntrada", { entrada_id: "e1" }], ["RestaurarProjeto", { projeto_id: "p1" }], ["RestaurarReuniao", { reuniao_id: "r1" }], ["RestaurarComentario", { comentario_id: "c1" }]]) {
    const db = dbFalso();
    const r = await executeWrite(nome, args, ctx(db, { turnoId: "t" }));
    assert.equal(r.codigo, "NAO_ESTA_NA_LIXEIRA", nome);
    assert.equal(r.erro, mensagemDaRecusa("NAO_ESTA_NA_LIXEIRA"));
    assert.equal(db.chamadas.at(-1).sql, "ROLLBACK", nome);
    assert.ok(!db.chamadas.some((c) => /^UPDATE /.test(c.sql)), nome);
  }
});

test("RestaurarTarefa / RestaurarComentario de algo escondido pelo pai (sem carimbo próprio) → ESCONDIDO_PELO_PAI com o pai; ROLLBACK; o log leva o código, não o nome", async () => {
  const tarefa = semCarimbo(linhaTarefa({ deleted_at: null, projeto_excluido_em: ONTEM }));
  const r = await executeWrite("RestaurarTarefa", { tarefa_id: "t1" }, ctx(tarefa, { turnoId: "t" }));
  assert.deepEqual(r, {
    erro: mensagemDaRecusa("ESCONDIDO_PELO_PAI"), codigo: "ESCONDIDO_PELO_PAI",
    pai: { entidade_tipo: "PROJETO", entidade_id: "p1", nome: "McKinsey" },
  });
  assert.notEqual(r.erro, mensagemDaRecusa("PAI_EXCLUIDO"), "o texto não manda restaurar isto depois do pai: recusaria de novo");
  assert.equal(tarefa.chamadas.at(-1).sql, "ROLLBACK");
  assert.ok(!tarefa.chamadas.some((c) => /^UPDATE |^INSERT INTO historico/.test(c.sql)), "nada escrito");
  const [linha] = eventos("AGENTE_TOOL_ERRO");
  assert.deepEqual([linha.tool, linha.codigo, linha.nivel], ["RestaurarTarefa", "ESCONDIDO_PELO_PAI", "warn"]);
  assert.ok(!JSON.stringify(logs).includes("McKinsey"), "nome é dado do Carlos: vai ao modelo, nunca ao log");

  const comentario = semCarimbo(linhaComentario({ deleted_at: null, alvo_excluido_em: ONTEM }));
  const c = await executeWrite("RestaurarComentario", { comentario_id: "c1" }, ctx(comentario, { turnoId: "t" }));
  assert.deepEqual([c.codigo, c.pai], ["ESCONDIDO_PELO_PAI", { entidade_tipo: "TAREFA", entidade_id: "t1", nome: "Revisar deck" }]);
  assert.ok(!comentario.chamadas.some((x) => x.sql.startsWith("UPDATE comentarios")));
});

test("RestaurarComentario com o alvo excluído → PAI_EXCLUIDO apontando o alvo", async () => {
  const db = dbFalso((sql) => (sql.includes("FROM comentarios x")
    ? { rows: [linhaComentario({ alvo_tipo: "ENTRADA", alvo_id: "e1", alvo_nome: "Ideia", alvo_excluido_em: ONTEM, frente_id: null, frente_nome: null, projeto_id: null, projeto_nome: null })] }
    : undefined));
  const r = await executeWrite("RestaurarComentario", { comentario_id: "c1" }, ctx(db, { turnoId: "t" }));
  assert.equal(r.codigo, "PAI_EXCLUIDO");
  assert.deepEqual(r.pai, { entidade_tipo: "ENTRADA", entidade_id: "e1", nome: "Ideia" });
  assert.ok(!db.chamadas.some((c) => c.sql.startsWith("UPDATE comentarios")));
});

// ─── ExcluirComentario e o id nas leituras ───

test("ExcluirComentario: lê o comentário vivo e o alvo, exclui pelo serviço, e a ação tem inverso RESTAURAR e resumo sem id", async () => {
  const db = dbFalso((sql) => {
    if (sql.startsWith("SELECT * FROM comentarios WHERE id = $1 AND deleted_at IS NULL")) {
      return { rows: [{ id: "c1", alvo_tipo: "TAREFA", alvo_id: "t1", texto: "ligar para a Ana", criado_em: ONTEM, origem: "web" }] };
    }
    if (sql.startsWith("SELECT alvo_tipo, alvo_id FROM comentarios")) return { rows: [{ alvo_tipo: "TAREFA", alvo_id: "t1" }] };
    if (sql.startsWith("SELECT 1 FROM tarefas_visiveis")) return { rows: [{ "?column?": 1 }] };
    if (sql.includes("FROM tarefas_visiveis t")) {
      return { rows: [{ id: "t1", name: "Revisar deck", acao: "", status: "Pendente", kanban_status: "A fazer", holder: "", stakeholder: "", frente_id: "f1", frente_nome: "Cobrança", projeto_id: "p1", projeto_nome: "McKinsey" }] };
    }
    if (sql.startsWith("UPDATE comentarios SET deleted_at = NOW()")) return { rows: [{ id: "c1", deleted_at: new Date() }] };
    return historicoOk(sql) ?? turnoOk(sql);
  });
  const r = await executeWrite("ExcluirComentario", { comentario_id: "c1" }, ctx(db, { turnoId: "turno-3" }));
  assert.deepEqual(r.resultado, {
    comentario_id: "c1", alvo_tipo: "TAREFA", alvo_id: "t1", alvo_nome: "Revisar deck", texto: "ligar para a Ana", excluido: true,
  });
  assert.deepEqual([r.acao.acao, r.acao.entidade_tipo, r.acao.inverso, r.acao.desfazivel], ["EXCLUIR_COMENTARIO", "COMENTARIO", "RESTAURAR", true]);
  assert.equal(r.acao.resumo, "Excluiu um comentário da tarefa “Revisar deck”");
  const hist = db.chamadas.find((c) => c.sql.startsWith("INSERT INTO historico"));
  assert.deepEqual([hist.params[0], hist.params[1], hist.params[2]], ["COMENTARIO", "c1", "EXCLUIDO"]);

  // Já excluído (ou de alvo escondido): NAO_ENCONTRADO, o mesmo critério do DELETE.
  const sumido = await executeWrite("ExcluirComentario", { comentario_id: "c9" }, ctx(dbFalso(), { turnoId: "t" }));
  assert.equal(sumido.codigo, "NAO_ENCONTRADO");
  const legado = await executeWrite("ExcluirComentario", { comentario_id: "c1" }, ctx(dbFalso(), { turnoId: "t", comentariosMigrados: false }));
  assert.equal(legado.codigo, "COMENTARIOS_INDISPONIVEIS");
});

test("comentariosDoAgente traz o comentario_id — sem ele o modelo não acha o que excluir", () => {
  assert.deepEqual(comentariosDoAgente([
    { id: "c1", text: "primeiro", createdAt: "2026-10-01T10:00:00.000Z" },
    { id: 7, text: "legado com id número", created_at: "2026-10-02T10:00:00.000Z" },
    { text: "sem id" },
  ]), [
    { comentario_id: "c1", texto: "primeiro", criado_em: "2026-10-01T10:00:00.000Z" },
    { comentario_id: "7", texto: "legado com id número", criado_em: "2026-10-02T10:00:00.000Z" },
    { comentario_id: null, texto: "sem id", criado_em: null },
  ]);
  assert.deepEqual(comentariosDoAgente(undefined), []);
});

test("ConsultarTarefa (modo migrado) devolve cada comentário com o comentario_id da tabela", async () => {
  const db = dbFalso((sql) => {
    if (sql.includes("FROM tarefas_visiveis t")) {
      return { rows: [{ id: "t1", name: "Revisar deck", acao: "", status: "Pendente", kanban_status: "A fazer", holder: "", stakeholder: "", frente_id: "f1", frente_nome: "Cobrança", projeto_id: "p1", projeto_nome: "McKinsey" }] };
    }
    if (sql.startsWith("SELECT id, alvo_id, texto, criado_em FROM comentarios")) {
      return { rows: [{ id: "c1", alvo_id: "t1", texto: "ligar para a Ana", criado_em: ONTEM }] };
    }
    return undefined;
  });
  const r = await executeRead("ConsultarTarefa", { tarefa_id: "t1" }, ctx(db));
  assert.deepEqual(r.resultado.comentarios, [{ comentario_id: "c1", texto: "ligar para a Ana", criado_em: ONTEM.toISOString() }]);
});

// ─── O contrato HTTP das recusas novas (POST /api/ops, a porta do MCP) ───

test("POST /api/ops: PAI_EXCLUIDO → 409 com o pai; ESCONDIDO_PELO_PAI → 409 com o pai; NAO_ESTA_NA_LIXEIRA → 404; Lixeira → 200", async () => {
  const db = dbFalso((sql, params) => {
    if (!sql.includes("FROM tasks x") || !sql.includes("x.id = $1")) return undefined;
    if (params[0] === "t-escondida") {
      return /WHERE x\.deleted_at IS NULL\s/.test(sql)
        ? { rows: [linhaTarefa({ id: "t-escondida", deleted_at: null, projeto_excluido_em: ONTEM })] }
        : undefined;
    }
    return { rows: [linhaTarefa({ frente_excluida_em: ONTEM })] };
  });
  const app = criarApp({ config, db, estado: MIGRADO });
  const servidor = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const post = async (nome, corpo) => {
    const res = await fetch(`${base}/api/ops/${nome}`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(corpo),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    const pai = await post("RestaurarTarefa", { tarefa_id: "t1" });
    assert.equal(pai.status, 409);
    assert.equal(pai.json.codigo, "PAI_EXCLUIDO");
    assert.deepEqual(pai.json.pai, { entidade_tipo: "FRENTE", entidade_id: "f1", nome: "Cobrança" });

    const escondida = await post("RestaurarTarefa", { tarefa_id: "t-escondida" });
    assert.deepEqual([escondida.status, escondida.json.codigo], [409, "ESCONDIDO_PELO_PAI"]);
    assert.deepEqual(escondida.json.pai, { entidade_tipo: "PROJETO", entidade_id: "p1", nome: "McKinsey" });

    const fora = await post("RestaurarProjeto", { projeto_id: "p-vivo" });
    assert.deepEqual([fora.status, fora.json.codigo], [404, "NAO_ESTA_NA_LIXEIRA"]);

    const lista = await post("Lixeira", {});
    assert.equal(lista.status, 200);
    assert.deepEqual(Object.keys(lista.json), ["resultado"], "leitura não tem ação");
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
});
