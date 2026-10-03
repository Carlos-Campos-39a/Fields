import { test } from "node:test";
import assert from "node:assert/strict";
import { criarPool, tx } from "../src/db/pool.js";
import { definirSaida } from "../src/lib/log.js";

function poolFalso({ falharRollback = false } = {}) {
  const queries = [];
  const liberados = [];
  const cliente = {
    async query(sql) {
      queries.push(sql);
      if (sql === "ROLLBACK" && falharRollback) throw Object.assign(new Error("conexão caiu"), { code: "57P01" });
      return { rows: [] };
    },
    release(err) { liberados.push(err); },
  };
  return { queries, liberados, cliente, connect: async () => cliente };
}

test("tx: BEGIN → fn → COMMIT, e o cliente volta ao pool", async () => {
  const p = poolFalso();
  const r = await tx(p, async (c) => { await c.query("INSERT 1"); return 42; });
  assert.equal(r, 42);
  assert.deepEqual(p.queries, ["BEGIN", "INSERT 1", "COMMIT"]);
  assert.deepEqual(p.liberados, [undefined]);
});

test("tx: erro em fn → ROLLBACK, relança, e libera o cliente", async () => {
  const p = poolFalso();
  await assert.rejects(tx(p, async () => { throw new Error("regra"); }), /regra/);
  assert.deepEqual(p.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(p.liberados, [undefined]);
});

test("tx: ROLLBACK que falha descarta o cliente (release com erro) e loga", async () => {
  const p = poolFalso({ falharRollback: true });
  const logs = [];
  definirSaida((_n, linha) => logs.push(JSON.parse(linha)));
  try {
    await assert.rejects(tx(p, async () => { throw new Error("regra"); }), /regra/);
  } finally { definirSaida(null); }
  assert.ok(p.liberados[0] instanceof Error);
  assert.deepEqual([logs[0].evento, logs[0].pg_codigo], ["DB_ROLLBACK_FALHOU", "57P01"]);
});

test("tx aninhada roda na transação corrente, sem novo BEGIN", async () => {
  const p = poolFalso();
  await tx(p, async (c) => tx(c, async (c2) => { assert.equal(c2, c); await c2.query("UPDATE"); }));
  assert.deepEqual(p.queries, ["BEGIN", "UPDATE", "COMMIT"]);
});

test("criarPool: toda conexão nova entra no fuso de Brasília, pelo parâmetro da conexão", async () => {
  const pool = criarPool({ databaseUrl: "postgres://u:p@127.0.0.1:1/x", databaseSsl: false });
  assert.equal(pool.options.options, "-c TimeZone=America/Sao_Paulo");
  assert.equal(pool.listenerCount("connect"), 0, "sem SET no evento connect (depreciado no pg 8.21)");
  await pool.end();
});
