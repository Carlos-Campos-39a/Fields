// O formato legado dos comentários e o adaptador do PATCH de array inteiro, sem banco.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAVE_DATA_LEGADA, MAX_CANDIDATOS, candidatosDeId, itensDaColunaLegada, lerItemLegado,
  paraFormatoLegado, planejarArrayLegado,
} from "../src/dominio/comentarios_legado.js";
import { ALVOS_COMENTARIO } from "../src/dominio/enums.js";

const PAI = new Date("2026-09-01T08:00:00Z");
const AGORA = new Date("2026-10-03T12:00:00Z");
let seq = 0;
const gerarId = () => `gerado-${++seq}`;

// ─── Formato ───
test("cada alvo tem a sua chave de data, e o item sai com as chaves na ordem do jsonb", () => {
  assert.deepEqual(Object.keys(CHAVE_DATA_LEGADA).sort(), [...ALVOS_COMENTARIO].sort());
  const linha = { id: "c1", texto: "oi", criado_em: new Date("2026-10-01T10:00:00Z") };
  const e = paraFormatoLegado("ENTRADA", linha);
  assert.deepEqual(e, { id: "c1", text: "oi", createdAt: "2026-10-01T10:00:00.000Z" });
  assert.deepEqual(Object.keys(e), ["id", "text", "createdAt"]);
  assert.deepEqual(Object.keys(paraFormatoLegado("TAREFA", linha)), ["id", "text", "created_at"]);
  assert.deepEqual(Object.keys(paraFormatoLegado("REUNIAO", linha)), ["id", "text", "created_at"]);
  assert.throws(() => paraFormatoLegado("PROJETO", linha), TypeError);
});

test("coluna legada: array passa; JSON null é vazio (o GET mostrava []); outra coisa é recusa", () => {
  assert.deepEqual(itensDaColunaLegada([{ id: 1 }]), { ok: true, itens: [{ id: 1 }] });
  assert.deepEqual(itensDaColunaLegada(null), { ok: true, itens: [] });
  assert.deepEqual(itensDaColunaLegada({ a: 1 }), { ok: false, motivo: "COLUNA_NAO_ARRAY" });
  assert.deepEqual(itensDaColunaLegada("x"), { ok: false, motivo: "COLUNA_NAO_ARRAY" });
});

// ─── Leitura de item (migração e adaptador) ───
test("item canônico passa intacto, sem reparo", () => {
  const r = lerItemLegado("ENTRADA", { id: "1696334400000", text: "nota", createdAt: "2026-10-03T12:00:00.000Z" }, { dataPadrao: PAI, gerarId });
  assert.deepEqual(r, { ok: true, id: "1696334400000", texto: "nota", criadoEm: "2026-10-03T12:00:00.000Z", reparos: [], extras: [] });
});

test("item reparado é NOMEADO, nunca descartado", () => {
  const semId = lerItemLegado("TAREFA", { text: "a", created_at: "2026-10-03T12:00:00.000Z" }, { dataPadrao: PAI, gerarId });
  assert.equal(semId.ok, true);
  assert.match(semId.id, /^gerado-/);
  assert.deepEqual(semId.reparos, ["ID_GERADO"]);

  const idNumero = lerItemLegado("REUNIAO", { id: 1696334400000, text: "a", created_at: "2026-10-03T12:00:00.000Z" }, { dataPadrao: PAI });
  assert.deepEqual([idNumero.id, idNumero.reparos], ["1696334400000", ["ID_NUMERICO"]]);

  for (const data of [undefined, null, "", "não é data", "99999-01-01T00:00:00Z", {}]) {
    const r = lerItemLegado("ENTRADA", { id: "x", text: "a", createdAt: data }, { dataPadrao: PAI });
    assert.deepEqual([r.criadoEm, r.reparos], ["2026-09-01T08:00:00.000Z", ["DATA_PADRAO"]], String(data));
  }

  const outraChave = lerItemLegado("TAREFA", { id: "x", text: "a", createdAt: "2026-10-03T12:00:00.000Z" }, { dataPadrao: PAI });
  assert.deepEqual([outraChave.criadoEm, outraChave.reparos], ["2026-10-03T12:00:00.000Z", ["DATA_OUTRA_CHAVE"]]);

  const reformatada = lerItemLegado("ENTRADA", { id: "x", text: "a", createdAt: "2026-10-03T09:00:00-03:00" }, { dataPadrao: PAI });
  assert.deepEqual([reformatada.criadoEm, reformatada.reparos], ["2026-10-03T12:00:00.000Z", ["DATA_REFORMATADA"]], "o instante se preserva");

  const extras = lerItemLegado("ENTRADA", { id: "x", text: "a", createdAt: "2026-10-03T12:00:00.000Z", autor: "?" }, { dataPadrao: PAI });
  assert.deepEqual(extras.extras, ["autor"]);
});

test("item ilegível é recusa: não é objeto, ou text não é string", () => {
  for (const item of [null, 42, "texto", [], { id: "x" }, { id: "x", text: 7 }, { id: "x", text: null }]) {
    assert.deepEqual(lerItemLegado("ENTRADA", item, { dataPadrao: PAI }), { ok: false, motivo: "ITEM_INVALIDO" }, JSON.stringify(item));
  }
  assert.equal(lerItemLegado("ENTRADA", { id: "x", text: "" }, { dataPadrao: PAI }).ok, true, "texto vazio é texto");
});

// ─── Colisão de id ───
test("candidatos de id: original, alias por alvo, alias:2… — e o tamanho é o teto", () => {
  const c = candidatosDeId("TAREFA", "t1", "c1");
  assert.deepEqual(c.slice(0, 4), ["c1", "TAREFA:t1:c1", "TAREFA:t1:c1:2", "TAREFA:t1:c1:3"]);
  assert.equal(c.length, MAX_CANDIDATOS);
  assert.equal(new Set(c).size, c.length);
});

// ─── Adaptador do array inteiro ───
const linha = (id, texto, deleted_at = null) => ({ id, texto, deleted_at });
const item = (id, text, created_at = "2026-10-03T10:00:00.000Z") => ({ id, text, created_at });

test("adaptador: insere o novo, edita o texto mudado, mantém o igual — e adicionar não remove o que falta", () => {
  const r = planejarArrayLegado({
    alvoTipo: "TAREFA", alvoId: "t1", agora: AGORA, gerarId,
    linhas: [linha("a", "A"), linha("b", "B"), linha("c", "C")],
    novos: [item("a", "A"), item("b", "B editado"), item("d", "D")],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plano.inserir, [{ id: "d", texto: "D", criadoEm: "2026-10-03T10:00:00.000Z" }]);
  assert.deepEqual(r.plano.editar, [{ id: "b", de: "B", para: "B editado" }]);
  assert.deepEqual(r.plano.remover, [], "o array que insere é o gesto 'adicionar': o c que falta é retrato velho");
  assert.equal(r.plano.remocoesIgnoradas, 1);
});

test("adaptador: remover um — a ÚNICA linha viva que falta no array é removida (soft)", () => {
  const r = planejarArrayLegado({
    alvoTipo: "TAREFA", alvoId: "t1", agora: AGORA,
    linhas: [linha("a", "A"), linha("b", "B"), linha("x", "X", new Date())],
    novos: [item("a", "A")],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plano.remover, [{ id: "b", texto: "B" }]);
  assert.deepEqual([r.plano.inserir, r.plano.editar, r.plano.remocoesIgnoradas], [[], [], 0]);
});

test("adaptador: array igual ao que existe → plano vazio", () => {
  const r = planejarArrayLegado({
    alvoTipo: "REUNIAO", alvoId: "r1", agora: AGORA,
    linhas: [linha("a", "A"), linha("x", "X", new Date())],
    novos: [item("a", "A")],
  });
  assert.deepEqual(r.plano, {
    inserir: [], editar: [], remover: [], duplicados: 0, camposExtras: 0, remocoesIgnoradas: 0, restaurosIgnorados: 0,
  }, "a linha já excluída que não veio no array continua excluída, sem evento");
});

test("adaptador: id de comentário excluído que volta no array NÃO é restaurado — ignorado e contado", () => {
  const r = planejarArrayLegado({
    alvoTipo: "ENTRADA", alvoId: "e1", agora: AGORA,
    linhas: [linha("a", "A", new Date("2026-10-02T00:00:00Z"))],
    novos: [{ id: "a", text: "A de volta", createdAt: "2026-10-01T00:00:00.000Z" }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.plano.inserir, r.plano.editar, r.plano.remover], [[], [], []],
    "nem restaura, nem nasce uma cópia: quem restaura é POST /comentarios/:id/restaurar");
  assert.equal(r.plano.restaurosIgnorados, 1);
});

test("adaptador: adicionar sobre retrato velho não exclui o comentário mais novo", () => {
  // O retrato tem só "a"; depois dele nasceu "novo" (POST /api/comentarios, o MCP, outra aba). O
  // cliente antigo acrescenta "b" sobre o retrato: "novo" falta no array, e continua vivo.
  const r = planejarArrayLegado({
    alvoTipo: "TAREFA", alvoId: "t1", agora: AGORA,
    linhas: [linha("a", "A"), linha("novo", "Feito depois do retrato")],
    novos: [item("a", "A"), item("b", "B")],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plano.inserir.map((i) => i.id), ["b"]);
  assert.deepEqual(r.plano.remover, []);
  assert.equal(r.plano.remocoesIgnoradas, 1);
});

test("adaptador: adicionar com um item já excluído no array não o restaura", () => {
  // O retrato é de antes do DELETE /api/comentarios/x; o cliente acrescenta "b" sobre ele.
  const r = planejarArrayLegado({
    alvoTipo: "REUNIAO", alvoId: "r1", agora: AGORA,
    linhas: [linha("a", "A"), linha("x", "X", new Date("2026-10-02T00:00:00Z"))],
    novos: [item("a", "A"), item("x", "X"), item("b", "B")],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plano.inserir.map((i) => i.id), ["b"], "o x não volta, nem como cópia");
  assert.deepEqual([r.plano.editar, r.plano.remover], [[], []]);
  assert.deepEqual([r.plano.restaurosIgnorados, r.plano.remocoesIgnoradas], [1, 0]);
});

test("adaptador: remover sobre retrato velho (faltam DUAS vivas) → recusa COMENTARIOS_DESATUALIZADOS, nenhuma removida", () => {
  // O retrato tem a e b; depois dele nasceu "novo". O cliente tira o b: faltam b e "novo", e não
  // há como saber qual dos dois o usuário apagou.
  const r = planejarArrayLegado({
    alvoTipo: "ENTRADA", alvoId: "e1", agora: AGORA,
    linhas: [linha("a", "A"), linha("b", "B"), linha("novo", "Feito depois do retrato")],
    novos: [{ id: "a", text: "A", createdAt: "2026-10-01T00:00:00.000Z" }],
  });
  assert.deepEqual(r, { ok: false, motivo: "COMENTARIOS_DESATUALIZADOS", remocoes: 2 });
});

test("adaptador: comentário remapeado na migração casa pelo id antigo (o cliente ainda o manda assim)", () => {
  const r = planejarArrayLegado({
    alvoTipo: "TAREFA", alvoId: "t1", agora: AGORA,
    linhas: [linha("TAREFA:t1:c1", "remapeado")],
    novos: [item("c1", "remapeado")],
  });
  assert.deepEqual([r.plano.inserir, r.plano.remover, r.plano.editar], [[], [], []],
    "sem casar o alias, cada PATCH apagaria o remapeado e criaria outro");
});

test("adaptador: id repetido no array vale uma vez; o resto conta como duplicado", () => {
  const r = planejarArrayLegado({
    alvoTipo: "TAREFA", alvoId: "t1", agora: AGORA,
    linhas: [linha("a", "A")],
    novos: [item("a", "A"), item("a", "A outra vez"), item("n", "N"), item("n", "N outra vez")],
  });
  assert.equal(r.plano.duplicados, 2);
  assert.deepEqual(r.plano.inserir.map((i) => i.id), ["n"]);
  assert.deepEqual(r.plano.editar, []);
});

test("adaptador: item sem data ganha o agora; sem id ganha um id novo", () => {
  const r = planejarArrayLegado({
    alvoTipo: "ENTRADA", alvoId: "e1", agora: AGORA, gerarId,
    linhas: [],
    novos: [{ text: "sem nada" }],
  });
  assert.equal(r.plano.inserir.length, 1);
  assert.match(r.plano.inserir[0].id, /^gerado-/);
  assert.equal(r.plano.inserir[0].criadoEm, "2026-10-03T12:00:00.000Z");
});

test("adaptador: array ilegível ou item ilegível → recusa COMENTARIOS_INVALIDOS (antes de qualquer escrita)", () => {
  for (const novos of [null, "x", { id: "a" }, [{ id: "a" }], [42], [item("a", "A"), null]]) {
    assert.deepEqual(
      planejarArrayLegado({ alvoTipo: "TAREFA", alvoId: "t1", linhas: [linha("a", "A")], novos }),
      { ok: false, motivo: "COMENTARIOS_INVALIDOS" }, JSON.stringify(novos));
  }
});

test("adaptador: array vazio apaga o último (é o que o front manda); com mais de um vivo, recusa sem remover nenhum", () => {
  const ultimo = planejarArrayLegado({ alvoTipo: "REUNIAO", alvoId: "r1", linhas: [linha("a", "A"), linha("x", "X", new Date())], novos: [] });
  assert.equal(ultimo.ok, true);
  assert.deepEqual(ultimo.plano.remover.map((x) => x.id), ["a"]);

  const dois = planejarArrayLegado({ alvoTipo: "REUNIAO", alvoId: "r1", linhas: [linha("a", "A"), linha("b", "B")], novos: [] });
  assert.deepEqual(dois, { ok: false, motivo: "COMENTARIOS_DESATUALIZADOS", remocoes: 2 },
    "nenhum cliente apaga dois de uma vez: o array vazio sobre dois vivos é retrato velho");
});
