// O harness de paridade (scripts/paridade.mjs) precisa de dois servidores com Postgres para rodar
// de verdade; aqui se testa o que decide PASS/DIFF: a normalização e o julgamento.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DIVERGENCIAS_ESPERADAS, PASSOS, julgar, normalizar } from "../scripts/paridade.mjs";

const ctx = (hoje) => ({ ids: new Map(), hoje });

test("normalizar: ids viram <id#n> pela ordem de aparição, timestamps viram <ts>", () => {
  const c = ctx("2026-10-03");
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const n = normalizar({ entry: { id: a, createdAt: "2026-10-03T12:00:00.000Z", time: "14:00" }, related: [{ id: b }, { id: a }] }, c);
  assert.deepEqual(n, { entry: { id: "<id#1>", createdAt: "<ts>", time: "14:00" }, related: [{ id: "<id#2>" }, { id: "<id#1>" }] });
  assert.equal(normalizar({ time: "2026-10-03T12:00:00.000Z" }, c).time, "<ts>", "o time do health");
});

test("normalizar: data perto do hoje do servidor vira relativa; data distante fica literal", () => {
  // o antigo semeou com hoje UTC (04), o novo com hoje Brasília (03): relativos batem
  const antiga = normalizar([{ date: "2026-10-04" }, { date: "2026-10-05" }, { date: "2030-01-01" }], ctx("2026-10-04"));
  const nova = normalizar([{ date: "2026-10-03" }, { date: "2026-10-04" }, { date: "2030-01-01" }], ctx("2026-10-03"));
  assert.deepEqual(antiga, nova);
  assert.deepEqual(nova, [{ date: "hoje" }, { date: "hoje+1" }, { date: "2030-01-01" }]);
});

test("julgar: igual → PASS; divergência declarada no formato declarado → ESPERADO", () => {
  assert.equal(julgar("health", { status: 200, json: { a: 1 } }, { status: 200, json: { a: 1 } }).resultado, "PASS");
  const a = julgar("tarefa-comentarios",
    { status: 500, json: { error: "invalid input syntax for type json" } },
    { status: 200, json: { success: true } });
  assert.equal(a.resultado, "ESPERADO");
  const b = julgar("reuniao-criar-com-must",
    { status: 201, json: { meeting: { id: "<id#9>", must: "" } } },
    { status: 201, json: { meeting: { id: "<id#9>", must: "levar os números do trimestre" } } });
  assert.equal(b.resultado, "ESPERADO");
  const c = julgar("frente-em-projeto-inexistente",
    { status: 500, json: { error: "insert or update on table \"frentes\" violates foreign key constraint" } },
    { status: 500, json: { error: "erro_interno" } });
  assert.equal(c.resultado, "ESPERADO");
});

test("julgar: divergência fora do formato declarado, ou não declarada → DIFF com o caminho", () => {
  const fora = julgar("tarefa-comentarios", { status: 500, json: {} }, { status: 400, json: { error: "x" } });
  assert.equal(fora.resultado, "DIFF");
  const mustComOutraDiferenca = julgar("reuniao-criar-com-must",
    { status: 201, json: { meeting: { title: "A", must: "" } } },
    { status: 201, json: { meeting: { title: "B", must: "levar os números do trimestre" } } });
  assert.equal(mustComOutraDiferenca.resultado, "DIFF", "o must não pode esconder outra diferença");
  const nao = julgar("projetos-arvore", { status: 200, json: { projects: [{ name: "a" }] } }, { status: 200, json: { projects: [{ name: "b" }] } });
  assert.equal(nao.resultado, "DIFF");
  assert.match(nao.nota, /\$\.projects\.0\.name/);
});

test("a sequência cobre o pedido e toda divergência declarada é um passo que existe", () => {
  const nomes = PASSOS.map((p) => p.nome);
  assert.equal(new Set(nomes).size, nomes.length, "nomes de passo únicos");
  for (const nome of Object.keys(DIVERGENCIAS_ESPERADAS)) assert.ok(nomes.includes(nome), nome);
  assert.deepEqual(Object.keys(DIVERGENCIAS_ESPERADAS).sort(),
    ["frente-em-projeto-inexistente", "reuniao-criar-com-must", "tarefa-comentarios"]);
  // a árvore de projetos é lida antes do comentário, senão (a) contaminaria o passo seguinte
  assert.ok(nomes.indexOf("projetos-arvore") < nomes.indexOf("tarefa-comentarios"));
});
