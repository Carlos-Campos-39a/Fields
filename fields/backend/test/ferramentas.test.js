// O gargalo único das ferramentas (agente/ferramentas.js), sem banco: o portão (nome fora das
// operações LIGADAS é recusado mesmo com executor), a validação da leitura, a recusa que vira
// {erro, codigo} e nunca exceção, o log sem valores, a escrita que anota a ação no MESMO tx (e volta
// atrás inteira quando recusa), o resumo sem ids e a serialização que trunca sem quebrar o JSON.
// O comportamento contra Postgres real está em agente_integracao.test.js.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ALVO_DA_ESCRITA, RESULTADO_MAX, alvoDaEscrita, camposDoErro, erroDe, executeRead, executeWrite,
  mensagemDaRecusa, resumoAcao, serializarResultado, validarArgs,
} from "../src/agente/ferramentas.js";
import { OPERATIONS, operacoesPara, systemPrompt } from "../src/agente/ontologia.js";
import { SCHEMAS } from "../src/agente/schemas.js";
import { definirSaida } from "../src/lib/log.js";

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
const intocavel = () => ({
  query: async () => { throw new Error("o banco não podia ser tocado"); },
  connect: async () => { throw new Error("o banco não podia ser tocado"); },
});
const ctx = (db, extra = {}) => ({ db, origem: "mcp", comentariosMigrados: true, agora: new Date("2026-10-03T15:00:00Z"), ...extra });

// ─── O portão ───

test("nome fora da ontologia → OPERACAO_INDISPONIVEL, sem tocar o banco, logado com o nome saneado", async () => {
  for (const nome of ["ApagarTudo", "DROP TABLE", undefined]) {
    const r = await executeRead(nome, {}, ctx(intocavel()));
    assert.equal(r.codigo, "OPERACAO_INDISPONIVEL");
    assert.equal(r.erro, mensagemDaRecusa("OPERACAO_INDISPONIVEL"));
  }
  const nomesLogados = eventos("AGENTE_TOOL_ERRO").map((l) => l.tool);
  assert.deepEqual(nomesLogados, ["ApagarTudo", "(invalido)", "(invalido)"]);
});

test("o tipo tem de casar: READ não entra por executeWrite, nem WRITE por executeRead", async () => {
  assert.equal((await executeWrite("BuscarTarefas", {}, ctx(intocavel(), { turnoId: "t" }))).codigo, "OPERACAO_INDISPONIVEL");
  assert.equal((await executeRead("NovaTarefa", { frente_id: "f", nome: "x" }, ctx(intocavel()))).codigo, "OPERACAO_INDISPONIVEL");
});

test("operação DESLIGADA recusa mesmo tendo executor — a brecha do CRM fechada", async () => {
  const soLeitura = operacoesPara({ somenteLeitura: true });
  const r = await executeWrite("NovaTarefa", { frente_id: "f", nome: "x" }, ctx(intocavel(), { turnoId: "t" }), { operacoes: soLeitura });
  assert.equal(r.codigo, "OPERACAO_INDISPONIVEL");
});

// ─── Validação (a leitura também) ───

test("leitura com argumento inválido → ARGUMENTOS_INVALIDOS com os campos, sem tocar o banco", async () => {
  const r = await executeRead("BuscarTarefas", { status: "Quase pronto", prazo_ate: "2026-13-01", inventado: 1 }, ctx(intocavel()));
  assert.equal(r.codigo, "ARGUMENTOS_INVALIDOS");
  assert.deepEqual(Object.keys(r.campos).sort(), ["inventado", "prazo_ate", "status"]);
  assert.equal(r.campos.inventado, "campo desconhecido");
  const [linha] = eventos("AGENTE_TOOL_ERRO");
  assert.deepEqual(linha.campos, ["inventado", "prazo_ate", "status"], "o log leva os NOMES dos campos, não os valores");
  assert.ok(!JSON.stringify(linha).includes("Quase pronto"));

  const semId = await executeRead("ConsultarTarefa", {}, ctx(intocavel()));
  assert.deepEqual(Object.keys(semId.campos), ["tarefa_id"]);
  const raiz = await executeRead("ListarProjetos", [], ctx(intocavel()));
  assert.ok(raiz.campos["(raiz)"], "corpo que não é objeto");
});

test("validarArgs: normaliza (default), aceita null onde o schema aceita, recusa null onde não aceita", () => {
  assert.deepEqual(validarArgs("ProximosCompromissos", undefined).valor, { dias: 7 });
  assert.ok(validarArgs("EditarTarefa", { tarefa_id: "t", prazo: null }).ok);
  assert.equal(validarArgs("EditarTarefa", { tarefa_id: "t", nome: null }).motivo, "ARGUMENTOS_INVALIDOS");
  assert.equal(validarArgs("NovaReuniao", { titulo: "R", data: "2026-10-05", inicio: "9h" }).motivo, "ARGUMENTOS_INVALIDOS");
  assert.ok(validarArgs("NovaReuniao", { titulo: "R", data: "2026-10-05", inicio: "09:00" }).ok);
  assert.equal(validarArgs("Lembrar", { texto: "x".repeat(301) }).motivo, "ARGUMENTOS_INVALIDOS");
  assert.equal(validarArgs("NaoExiste", {}).motivo, "OPERACAO_INDISPONIVEL");
});

test("camposDoErro e erroDe: o formato do contrato", () => {
  const r = SCHEMAS.ConsultarTarefa.safeParse({ x: 1 });
  assert.deepEqual(Object.keys(camposDoErro(r.error)).sort(), ["tarefa_id", "x"]);
  assert.deepEqual(erroDe({ ok: false, motivo: "AMBIGUO", candidatos: ["a", "b"] }),
    { erro: mensagemDaRecusa("AMBIGUO"), codigo: "AMBIGUO", candidatos: ["a", "b"] });
  assert.equal(mensagemDaRecusa("CODIGO_NOVO"), "Recusado: CODIGO_NOVO.", "sem texto: o código cru, feio e visível");
});

// ─── Recusa e exceção nunca vazam ───

test("recusa do serviço vira {erro, codigo} (NAO_ENCONTRADO) e AGENTE_TOOL_ERRO em warn", async () => {
  const r = await executeRead("ConsultarTarefa", { tarefa_id: "nao-existe" }, ctx(dbFalso()));
  assert.equal(r.codigo, "NAO_ENCONTRADO");
  assert.equal(r.resultado, undefined);
  const [linha] = eventos("AGENTE_TOOL_ERRO");
  assert.equal(linha.nivel, "warn");
  assert.equal(linha.codigo, "NAO_ENCONTRADO");
  assert.equal(typeof linha.duration_ms, "number");
});

test("exceção do banco vira ERRO_INTERNO — nunca lança, e o log não leva a mensagem", async () => {
  const db = dbFalso(() => { throw Object.assign(new Error("relation x: DADO-SENSIVEL"), { code: "42P01" }); });
  const r = await executeRead("ListarProjetos", {}, ctx(db));
  assert.deepEqual(r, { erro: mensagemDaRecusa("ERRO_INTERNO"), codigo: "ERRO_INTERNO" });
  const [linha] = eventos("AGENTE_TOOL_ERRO");
  assert.equal(linha.nivel, "erro");
  assert.equal(linha.pg_codigo, "42P01");
  assert.ok(!JSON.stringify(logs).includes("DADO-SENSIVEL"));
});

test("leitura que dá certo: {resultado}, e AGENTE_TOOL com os NOMES dos argumentos, ordenados", async () => {
  const db = dbFalso((sql) => {
    if (sql.includes("FROM tarefas_visiveis t")) {
      return { rows: [{ id: "t1", name: "Revisar deck", acao: "", status: "Pendente", kanban_status: "A fazer", deadline: "2026-10-01", start_date: null, holder: "Nós", stakeholder: "", frente_id: "f1", frente_nome: "Cobrança", projeto_id: "p1", projeto_nome: "McKinsey", created_at: new Date() }] };
    }
    return undefined;
  });
  const r = await executeRead("BuscarTarefas", { texto: "Deck secreto", atrasadas: true }, ctx(db));
  assert.deepEqual(r.resultado.tarefas[0], {
    tarefa_id: "t1", nome: "Revisar deck", acao: null, status: "Pendente", coluna: "A fazer",
    prazo: "2026-10-01", inicio: null, holder: "Nós", stakeholder: null,
    frente_id: "f1", frente: "Cobrança", projeto_id: "p1", projeto: "McKinsey",
  });
  const busca = db.chamadas.find((c) => c.sql.includes("FROM tarefas_visiveis t"));
  assert.ok(busca.params.includes("%deck secreto%"), "termo normalizado (caixa) no LIKE");
  assert.ok(busca.params.includes("2026-10-03"), "atrasadas = antes de HOJE, no fuso de Brasília");
  const [linha] = eventos("AGENTE_TOOL");
  assert.deepEqual(linha.argumentos, ["atrasadas", "texto"]);
  assert.ok(!JSON.stringify(linha).includes("secreto"), "valor de argumento não vai ao log");
});

// ─── Escrita: a ação no mesmo tx ───

function dbDeEscrita({ projetoExiste = true } = {}) {
  return dbFalso((sql, params) => {
    if (sql.startsWith("SELECT COUNT(*) FROM projects")) return { rows: [{ count: "2" }] };
    if (sql.startsWith("INSERT INTO projects")) {
      return { rows: [{ id: params[0], name: params[1], status: params[2], holder: params[3], sort_order: params[4], created_at: new Date() }] };
    }
    if (sql.startsWith("INSERT INTO historico")) return { rows: [{ id: "41" }] };
    if (sql.startsWith("SELECT jsonb_array_length(acoes)")) return { rows: [{ n: 0 }] };
    if (sql.startsWith("SELECT * FROM projects WHERE id = $1")) return { rows: projetoExiste ? [{ id: params[0], name: "P", status: "Em andamento", holder: "Nós" }] : [] };
    return undefined;
  });
}

test("escrita que dá certo: turno garantido, ação anotada no MESMO tx, antes do COMMIT", async () => {
  const db = dbDeEscrita();
  const r = await executeWrite("NovoProjeto", { nome: "Tese" }, ctx(db, { turnoId: "turno-1" }));

  assert.deepEqual(r.resultado, { projeto_id: r.resultado.projeto_id, nome: "Tese", status: "Em andamento", holder: "Nós" });
  assert.deepEqual(r.acao, {
    turno_id: "turno-1", tool: "NovoProjeto", acao: "NOVO_PROJETO", entidade_tipo: "PROJETO",
    entidade_id: r.resultado.projeto_id, historico_id: 41, inverso: "EXCLUIR",
    resumo: "Criou o projeto “Tese”", desfazivel: true, desfeito_em: null, idx: 0,
  });

  const sqls = db.chamadas.map((c) => c.sql.split(/\s+/).slice(0, 3).join(" "));
  assert.equal(sqls[0], "BEGIN");
  assert.equal(sqls.at(-1), "COMMIT");
  assert.ok(!sqls.includes("ROLLBACK"));
  const turno = db.chamadas.find((c) => c.sql.startsWith("INSERT INTO agente_turnos"));
  assert.deepEqual(turno.params, ["turno-1", "mcp", null], "canal derivado da origem mcp");
  const anota = db.chamadas.findIndex((c) => c.sql.startsWith("UPDATE agente_turnos SET acoes = acoes ||"));
  assert.ok(anota > 0 && anota < db.chamadas.length - 1, "a ação é anotada antes do COMMIT");
  assert.deepEqual(JSON.parse(db.chamadas[anota].params[1]), [{ ...r.acao, turno_id: undefined }].map(({ turno_id: _t, ...a }) => a));
  const hist = db.chamadas.find((c) => c.sql.startsWith("INSERT INTO historico"));
  assert.equal(hist.params[4], "mcp", "a origem do histórico é a de quem chamou");
  assert.equal(hist.params[5], "turno-1", "o evento leva o turno");
  assert.equal(hist.params[6], null, "não é um desfazer");
  assert.deepEqual(eventos("AGENTE_TOOL").map((l) => [l.tool, l.tipo]), [["NovoProjeto", "WRITE"]]);
});

test("escrita recusada volta atrás INTEIRA — inclusive a linha do turno — e não anota ação", async () => {
  const db = dbDeEscrita({ projetoExiste: false });
  const r = await executeWrite("NovaFrente", { projeto_id: "p-sumido", nome: "F" }, ctx(db, { turnoId: "turno-2" }));
  assert.equal(r.codigo, "NAO_ENCONTRADO");
  const sqls = db.chamadas.map((c) => c.sql);
  assert.equal(sqls[0], "BEGIN");
  assert.equal(sqls.at(-1), "ROLLBACK");
  assert.ok(!sqls.includes("COMMIT"));
  assert.ok(sqls.some((s) => s.startsWith("INSERT INTO agente_turnos")), "o turno foi criado no tx…");
  assert.ok(!sqls.some((s) => s.startsWith("UPDATE agente_turnos")), "…e nenhuma ação anotada");
  assert.ok(!sqls.some((s) => s.startsWith("INSERT INTO frentes")));
});

test("operação marcada `humana` EXECUTA pelo gargalo (o POST /api/ops do MCP) — e por isso o prompt do mcp não promete confirmação", async () => {
  // Quem interrompe uma `humana` é o motor da TELA, antes de chamar o executor; o executor não olha
  // `confirmacao`. O MCP e o WhatsApp chegam direto aqui: a escrita é gravada na hora, como o
  // WhatsApp do CRM. Se um dia o MCP tiver de barrar uma `humana`, é aqui que este teste quebra.
  const comHumana = operacoesPara({ somenteLeitura: false })
    .map((op) => (op.name === "NovoProjeto" ? { ...op, confirmacao: "humana" } : op));
  const db = dbDeEscrita();
  const r = await executeWrite("NovoProjeto", { nome: "Tese" }, ctx(db, { turnoId: "turno-h" }), { operacoes: comHumana });
  assert.equal(r.acao.acao, "NOVO_PROJETO");
  assert.equal(r.acao.desfazivel, true);
  assert.equal(db.chamadas.at(-1).sql, "COMMIT", "gravou — não ficou pendente");
  const prompt = systemPrompt({ canal: "mcp", operacoes: comHumana, confirmacaoHumana: ["NovoProjeto"] });
  assert.ok(!prompt.includes("CONFIRMAÇÃO"), "o prompt do mcp não pode dizer que espera um clique que não existe");
});

test("edição sem nenhum campo → NADA_A_ATUALIZAR, sem escrever", async () => {
  const db = dbDeEscrita();
  const r = await executeWrite("EditarProjeto", { projeto_id: "p1" }, ctx(db, { turnoId: "t" }));
  assert.equal(r.codigo, "NADA_A_ATUALIZAR");
  assert.equal(db.chamadas.at(-1).sql, "ROLLBACK");
});

test("escrita sem turnoId é erro de programação: ERRO_INTERNO, log de erro, nada escrito", async () => {
  const r = await executeWrite("NovoProjeto", { nome: "x" }, ctx(intocavel()));
  assert.equal(r.codigo, "ERRO_INTERNO");
  assert.equal(eventos("AGENTE_TOOL_ERRO")[0].erro, "TypeError");
});

// ─── O alvo e o resumo ───

test("alvoDaEscrita: tipo + id da saída; null para escrita sem alvo ou saída sem id", () => {
  assert.deepEqual(alvoDaEscrita("NovaTarefa", { tarefa_id: "t1", nome: "x" }), { entidade_tipo: "TAREFA", entidade_id: "t1" });
  assert.equal(alvoDaEscrita("Lembrar", { memoria_id: "m1" }), null);
  assert.equal(alvoDaEscrita("NovaTarefa", {}), null);
  assert.equal(alvoDaEscrita("NovaTarefa", null), null);
  assert.equal(ALVO_DA_ESCRITA.ConcluirTarefa[0], "TAREFA");
});

test("resumoAcao: uma frase no passado, com nomes e rótulos — nunca id nem enum cru", () => {
  const casos = [
    ["NovaTarefa", {}, { tarefa_id: "a1b2c3", nome: "Revisar deck", frente: "Cobrança", prazo: "2026-10-09" }, "Criou a tarefa “Revisar deck” na frente “Cobrança”, para 09/10"],
    ["NovaEntrada", {}, { entrada_id: "e1", tipo: "reminder", titulo: "Pagar boleto", data: "2026-10-04", hora: "09:00" }, "Criou o lembrete “Pagar boleto” para 04/10 às 09:00"],
    ["NovaEntrada", {}, { entrada_id: "e2", tipo: "note", titulo: "Ideia", data: "2026-10-03" }, "Criou a nota “Ideia”"],
    ["NovaEntrada", {}, { entrada_id: "e3", tipo: "lang_fr", titulo: "Subjonctif", data: "2026-10-03" }, "Criou a nota de francês “Subjonctif”"],
    ["EditarTarefa", { tarefa_id: "t9", status: "Em andamento", prazo: null, holder: "Eles", coluna: "Fazendo" }, { tarefa_id: "t9", nome: "Deck" },
      "Editou a tarefa “Deck”: status → Em andamento; coluna → Fazendo; prazo → sem valor; responsável → com terceiros"],
    ["EditarEntrada", { entrada_id: "e1", tipo: "event", conteudo: "texto longo", fixada: true }, { entrada_id: "e1", tipo: "event", titulo: "Defesa" },
      "Editou o evento “Defesa”: tipo → evento; novo conteúdo; fixada → sim"],
    ["ConcluirTarefa", { tarefa_id: "t9" }, { tarefa_id: "t9", nome: "Deck" }, "Concluiu a tarefa “Deck”"],
    ["ExcluirProjeto", { projeto_id: "p1" }, { projeto_id: "p1", nome: "TCC" }, "Excluiu o projeto “TCC”, com as frentes e tarefas dele"],
    ["NovaReuniao", {}, { reuniao_id: "r1", titulo: "Banca", data: "2026-10-10", inicio: "10:00" }, "Marcou a reunião “Banca” para 10/10 às 10:00"],
    ["NovoComentario", {}, { comentario_id: "c1", alvo_tipo: "REUNIAO", alvo_nome: "Banca" }, "Comentou na reunião “Banca”"],
    ["Lembrar", {}, { memoria_id: "m1", texto: "a Ana só atende de manhã", lembrar_em: null }, "Guardou na memória: “a Ana só atende de manhã”"],
    ["Esquecer", {}, { memoria_id: "m1", texto: "a Ana só atende de manhã" }, "Tirou da memória: “a Ana só atende de manhã”"],
  ];
  for (const [nome, args, saida, esperado] of casos) {
    const frase = resumoAcao(nome, args, saida);
    assert.equal(frase, esperado, nome);
    for (const id of ["a1b2c3", "e1", "t9", "p1", "r1", "c1", "m1"]) assert.ok(!frase.includes(id), `${nome}: id ${id}`);
  }
  // Toda escrita da ontologia tem frase própria (não cai no genérico).
  for (const op of OPERATIONS.filter((o) => o.tipo === "WRITE")) {
    assert.notEqual(resumoAcao(op.name, {}, {}), "Executou uma ação", op.name);
  }
});

// ─── Serialização para o modelo ───

test("serializarResultado: pequeno passa intacto", () => {
  assert.equal(serializarResultado({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
  assert.equal(serializarResultado(null), "null");
  assert.equal(serializarResultado({ n: 10n }), '{"n":"10"}');
});

test("serializarResultado: grande continua JSON válido, cabe no teto, e marca truncado", () => {
  const grande = { tarefas: Array.from({ length: 500 }, (_, i) => ({ nome: `Tarefa ${i} `.repeat(10) })), total: 500 };
  const s = serializarResultado(grande);
  assert.ok(s.length <= RESULTADO_MAX);
  const volta = JSON.parse(s);
  assert.equal(volta.truncado, true);
  assert.equal(volta.total, 500, "o resto do objeto continua lá");
  assert.ok(volta.tarefas.length > 1 && volta.tarefas.length < 500);
});

test("serializarResultado: corta várias listas acumulando, depois textos longos; último recurso é erro válido", () => {
  const duas = { a: Array.from({ length: 300 }, () => "x".repeat(40)), b: Array.from({ length: 300 }, () => "y".repeat(40)) };
  const s = JSON.parse(serializarResultado(duas, 4000));
  assert.equal(s.truncado, true);
  assert.ok(s.a.length < 300 && s.b.length < 300);

  const nota = { entrada: { conteudo: "z".repeat(20_000) }, comentarios: [] };
  const n = JSON.parse(serializarResultado(nota, 2000));
  assert.equal(n.truncado, true);
  assert.ok(n.entrada.conteudo.length <= 1001);

  const impossivel = JSON.parse(serializarResultado("w".repeat(20_000), 100));
  assert.deepEqual(impossivel, { erro: "resultado grande demais para exibir", truncado: true });
});
