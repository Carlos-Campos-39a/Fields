// O diff do histórico, sem banco: só o que mudou, comparando por valor JSON.

import { test } from "node:test";
import assert from "node:assert/strict";
import { calcularMudancas, mesmoValor, valorDeHistorico } from "../src/dominio/mudancas.js";
import { registrar } from "../src/servicos/historico.js";

const CAMPOS = ["name", "status", "tags", "meta", "deadline"];

test("ATUALIZADO: só os campos que mudaram, com de e para", () => {
  const antes = { name: "A", status: "Pendente", tags: ["x"], meta: null, deadline: null, updated_at: new Date(1) };
  const depois = { name: "A", status: "Concluído", tags: ["x"], meta: null, deadline: "2026-10-10", updated_at: new Date(2) };
  assert.deepEqual(calcularMudancas("ATUALIZADO", antes, depois, CAMPOS), [
    { campo: "status", de: "Pendente", para: "Concluído" },
    { campo: "deadline", de: null, para: "2026-10-10" },
  ], "updated_at não é campo auditado e não entra");
});

test("ATUALIZADO sem mudança nenhuma → [] (e o registrar não grava evento)", async () => {
  const linha = { name: "A", status: "Pendente", tags: ["x", "y"], meta: { a: 1, b: [1, 2] }, deadline: null };
  const copia = JSON.parse(JSON.stringify(linha)); // outras referências, mesmo valor
  assert.deepEqual(calcularMudancas("ATUALIZADO", linha, copia, CAMPOS), []);

  const queries = [];
  const db = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ id: "1" }] }; } };
  const r = await registrar(db, { origem: "web", turnoId: null }, {
    entidade_tipo: "TAREFA", entidade_id: "t1", acao: "ATUALIZADO", antes: linha, depois: copia, campos: CAMPOS,
  });
  assert.deepEqual(r, { registrado: false, motivo: "SEM_MUDANCA" });
  assert.equal(queries.length, 0);
});

test("arrays e objetos comparados como JSON: ordem de array conta, ordem de chave não", () => {
  assert.equal(mesmoValor(["a", "b"], ["a", "b"]), true);
  assert.equal(mesmoValor(["a", "b"], ["b", "a"]), false, "ordem de tags é dado");
  assert.equal(mesmoValor({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true, "o jsonb não guarda ordem de chave");
  assert.equal(mesmoValor([{ id: 1, text: "x" }], [{ text: "x", id: 1 }]), true);
  assert.equal(mesmoValor([{ id: 1, text: "x" }], [{ id: 1, text: "y" }]), false);
  assert.equal(mesmoValor(undefined, null), true);
  assert.equal(mesmoValor(2, "2"), false, "tipo conta: por isso o diff é linha × linha, nunca payload × linha");
  assert.equal(mesmoValor(new Date("2026-10-03T12:00:00Z"), new Date("2026-10-03T12:00:00.000Z")), true);
  assert.equal(mesmoValor(new Date("2026-10-03T12:00:00Z"), new Date("2026-10-03T12:00:01Z")), false);
});

test("CRIADO guarda só o para, um item por campo auditado", () => {
  const depois = { name: "N", status: "Pendente", tags: [], meta: { a: 1 }, deadline: null, created_at: new Date() };
  assert.deepEqual(calcularMudancas("CRIADO", null, depois, CAMPOS), [
    { campo: "name", para: "N" }, { campo: "status", para: "Pendente" }, { campo: "tags", para: [] },
    { campo: "meta", para: { a: 1 } }, { campo: "deadline", para: null },
  ]);
});

test("EXCLUIDO e RESTAURADO guardam a mudança de deleted_at (ISO)", () => {
  const quando = new Date("2026-10-03T15:00:00Z");
  assert.deepEqual(calcularMudancas("EXCLUIDO", { deleted_at: null }, { deleted_at: quando }),
    [{ campo: "deleted_at", de: null, para: "2026-10-03T15:00:00.000Z" }]);
  assert.deepEqual(calcularMudancas("RESTAURADO", { deleted_at: quando }, { deleted_at: null }),
    [{ campo: "deleted_at", de: "2026-10-03T15:00:00.000Z", para: null }]);
  assert.deepEqual(calcularMudancas("EXCLUIDO", null, null), []);
});

test("ação desconhecida é erro de programação", () => {
  assert.throws(() => calcularMudancas("APAGADO", {}, {}, []), TypeError);
});

test("valorDeHistorico: Date vira ISO, undefined vira null, Date inválida vira null", () => {
  assert.equal(valorDeHistorico(new Date("2026-10-03T12:00:00Z")), "2026-10-03T12:00:00.000Z");
  assert.equal(valorDeHistorico(undefined), null);
  assert.equal(valorDeHistorico(new Date("lixo")), null);
  assert.deepEqual(valorDeHistorico(["a"]), ["a"]);
});

test("registrar grava origem e turno do ctx, e recusa (lança) valor fora dos enums", async () => {
  const queries = [];
  const db = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ id: "42" }] }; } };
  const r = await registrar(db, { origem: "mcp", turnoId: "turno-1" }, {
    entidade_tipo: "PROJETO", entidade_id: "p1", acao: "ATUALIZADO",
    antes: { name: "a" }, depois: { name: "b" }, campos: ["name"],
  });
  assert.deepEqual(r, { registrado: true, id: 42 });
  const [, , acao, mudancas, origem, turno] = queries[0].params;
  assert.deepEqual([acao, JSON.parse(mudancas), origem, turno],
    ["ATUALIZADO", [{ campo: "name", de: "a", para: "b" }], "mcp", "turno-1"]);

  const base = { entidade_tipo: "PROJETO", entidade_id: "p1", acao: "CRIADO", depois: {}, campos: [] };
  await assert.rejects(registrar(db, { origem: "telefone" }, base), /ORIGENS/);
  await assert.rejects(registrar(db, { origem: "web" }, { ...base, entidade_tipo: "MEMORIA" }), /ENTIDADES/);
  await assert.rejects(registrar(db, { origem: "web" }, { ...base, acao: "APAGADO" }), /ACOES_HISTORICO/);
  await assert.rejects(registrar(db, { origem: "web" }, { ...base, entidade_id: "" }), /entidade_id/);
});
