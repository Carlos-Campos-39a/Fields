// A loja do webhook sobre o Postgres (servicos/whatsapp.js) com um db falso: o que cada função manda ao
// banco e como lê a volta. O mesmo SQL contra o Postgres de verdade está em whatsapp_integracao.test.js.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  RETENCAO_EVENTOS_DIAS, absorverEventos, agendarLimpezaDeEventos, concluirEvento, gravarCanal, limparEventosAntigos,
  lojaEventosSql, obterEvento, reservarEvento,
} from "../src/servicos/whatsapp.js";
import { definirSaida } from "../src/lib/log.js";

let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });

function dbFalso(responder = () => undefined) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return (await responder(sql, params)) ?? { rows: [], rowCount: 0 };
    },
  };
}

test("reservarEvento: o INSERT ... ON CONFLICT DO NOTHING é a trava; quem ganha a linha recebe {nova:true} e nada mais roda", async () => {
  const db = dbFalso((sql) => (sql.includes("INSERT") ? { rows: [{ event_id: "w1" }], rowCount: 1 } : undefined));
  assert.deepEqual(await reservarEvento(db, "w1"), { nova: true });
  assert.equal(db.chamadas.length, 1);
  assert.match(db.chamadas[0].sql, /^INSERT INTO eventos_recebidos \(event_id, status\) VALUES \(\$1, \$2\) ON CONFLICT \(event_id\) DO NOTHING RETURNING event_id$/);
  assert.deepEqual(db.chamadas[0].params, ["w1", "EM_VOO"]);
});

test("reservarEvento: wamid repetido → conta a tentativa e devolve o status e a resposta guardados; linha sumida → status nulo", async () => {
  const resposta = { text: "Vencem 3." };
  const db = dbFalso((sql) => (sql.startsWith("UPDATE") ? { rows: [{ status: "CONCLUIDO", resposta, turno_id: "t1" }], rowCount: 1 } : undefined));
  assert.deepEqual(await reservarEvento(db, "w1"), { nova: false, status: "CONCLUIDO", resposta, turnoId: "t1" });
  assert.match(db.chamadas[1].sql, /^UPDATE eventos_recebidos SET tentativas = tentativas \+ 1 WHERE event_id = \$1 RETURNING status, resposta, turno_id$/);
  assert.deepEqual(await reservarEvento(dbFalso(), "w2"), { nova: false, status: null, resposta: null });
});

test("obterEvento, concluirEvento e gravarCanal: o SQL e os parâmetros (a resposta vai como JSON para o jsonb)", async () => {
  const db = dbFalso((sql) => (sql.startsWith("SELECT") ? { rows: [{ status: "EM_VOO", resposta: null, turno_id: null }], rowCount: 1 } : undefined));
  assert.deepEqual(await obterEvento(db, "w1"), { status: "EM_VOO", resposta: null, turnoId: null });
  assert.equal(await obterEvento(dbFalso(), "w1"), null);

  await concluirEvento(db, "w1", { resposta: { handoff: { reason: "BOT_FAILURE" } }, turnoId: "t9" });
  const concluir = db.chamadas.at(-1);
  assert.match(concluir.sql, /^UPDATE eventos_recebidos SET status = \$2, resposta = \$3::jsonb, turno_id = \$4, concluido_em = NOW\(\) WHERE event_id = \$1$/);
  assert.deepEqual(concluir.params, ["w1", "CONCLUIDO", '{"handoff":{"reason":"BOT_FAILURE"}}', "t9"]);
  await concluirEvento(db, "w2", { resposta: undefined });
  assert.deepEqual(db.chamadas.at(-1).params, ["w2", "CONCLUIDO", "{}", null], "sem corpo, {} — nunca NULL num evento concluído");

  await gravarCanal(db, { waId: "5511999998888", conversationId: 42, botId: 3 });
  const canal = db.chamadas.at(-1);
  assert.match(canal.sql, /ON CONFLICT \(wa_id\) DO UPDATE SET conversation_id = EXCLUDED\.conversation_id, bot_id = EXCLUDED\.bot_id, atualizado_em = NOW\(\)$/);
  assert.deepEqual(canal.params, ["5511999998888", 42, 3]);

  const loja = lojaEventosSql(db);
  assert.deepEqual(Object.keys(loja).sort(), ["absorver", "concluir", "gravarCanal", "obter", "reservar"]);
});

test("absorverEventos (a rajada): um INSERT ... ON CONFLICT DO NOTHING como CONCLUIDO {} — devolve só os wamids que eram novos", async () => {
  const db = dbFalso((sql) => (sql.includes("INSERT") ? { rows: [{ event_id: "w3" }, { event_id: "w1" }], rowCount: 2 } : undefined));
  assert.deepEqual(await absorverEventos(db, ["w1", "w2", "w1", "w3"]), ["w3", "w1"]);
  assert.equal(db.chamadas.length, 1);
  assert.match(db.chamadas[0].sql,
    /^INSERT INTO eventos_recebidos \(event_id, status, resposta, concluido_em\) SELECT id, \$2, '\{\}'::jsonb, NOW\(\) FROM unnest\(\$1::text\[\]\) AS id ON CONFLICT \(event_id\) DO NOTHING RETURNING event_id$/);
  assert.deepEqual(db.chamadas[0].params, [["w1", "w2", "w3"], "CONCLUIDO"], "sem repetidos, e já concluídos (com {})");

  const vazio = dbFalso();
  assert.deepEqual(await absorverEventos(vazio, []), []);
  assert.equal(vazio.chamadas.length, 0, "sem rajada, nem vai ao banco");
});

test("limparEventosAntigos: apaga o que passou de 7 dias, loga quantos; falha só loga (com o SQLSTATE), nunca lança", async () => {
  const db = dbFalso(() => ({ rows: [], rowCount: 3 }));
  assert.equal(await limparEventosAntigos(db), 3);
  assert.match(db.chamadas[0].sql, /^DELETE FROM eventos_recebidos WHERE criado_em < NOW\(\) - make_interval\(days => \$1::int\)$/);
  assert.deepEqual(db.chamadas[0].params, [RETENCAO_EVENTOS_DIAS]);
  assert.equal(RETENCAO_EVENTOS_DIAS, 7);
  assert.deepEqual(logs.map((l) => [l.evento, l.eventos, l.momento]), [["LESCHATS_EVENTOS_LIMPOS", 3, "periodica"]]);

  logs = [];
  assert.equal(await limparEventosAntigos(dbFalso(() => ({ rows: [], rowCount: 0 }))), 0);
  assert.equal(logs.length, 0, "nada apagado, nada logado");

  const quebrado = { query: async () => { throw Object.assign(new Error("senha do banco: xyz"), { code: "28P01" }); } };
  assert.equal(await limparEventosAntigos(quebrado, { momento: "boot" }), 0);
  assert.deepEqual([logs[0].evento, logs[0].pg_codigo, logs[0].momento], ["LESCHATS_LIMPEZA_FALHOU", "28P01", "boot"]);
  assert.ok(!JSON.stringify(logs).includes("xyz"), "a mensagem do pg não vai ao log");
});

test("agendarLimpezaDeEventos: uma passada no boot e as seguintes no intervalo; o timer não segura o processo", async () => {
  const db = dbFalso(() => ({ rows: [], rowCount: 0 }));
  const timer = agendarLimpezaDeEventos(db, { intervaloMs: 5 });
  try {
    for (let i = 0; i < 100 && db.chamadas.length < 3; i++) await new Promise((ok) => setTimeout(ok, 5));
    assert.ok(db.chamadas.length >= 3, "boot + ao menos duas periódicas");
    assert.ok(db.chamadas.every((c) => c.sql.startsWith("DELETE FROM eventos_recebidos")));
    assert.equal(timer.hasRef(), false);
  } finally { clearInterval(timer); }
});
