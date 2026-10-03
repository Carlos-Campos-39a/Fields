import pg from "pg";
import { log } from "../lib/log.js";
import { FUSO } from "../lib/datas.js";

const { Pool } = pg;

/**
 * Pool do Postgres. Toda conexão nova entra no fuso de Brasília, para que NOW()::date e afins
 * concordem com datas.hojeISO(). (O JSON não muda: TIMESTAMPTZ vira Date com offset do mesmo jeito.)
 *
 * O fuso vai como parâmetro da própria conexão (`-c TimeZone=`), não como um SET no evento
 * "connect": aquele SET disputava a vez com a primeira query do cliente, o pg 8.21 avisa que isso
 * está depreciado e o pg 9 deixa de enfileirar.
 */
export function criarPool(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    options: `-c TimeZone=${FUSO}`,
  });
  // Sem este handler, um erro num cliente ocioso (ex.: o Postgres reiniciou) derruba o processo.
  pool.on("error", (err) => log.erro("DB_POOL_ERRO", { erro: err.name, pg_codigo: err.code }));
  return pool;
}

/**
 * Executa fn(cliente) dentro de BEGIN/COMMIT num cliente dedicado; ROLLBACK se fn lançar.
 * Se `db` já é um cliente emprestado (tem release), fn roda na transação corrente — tx aninhada
 * não abre outra.
 */
export async function tx(db, fn) {
  if (typeof db.release === "function") return fn(db);
  const cliente = await db.connect();
  let quebrado; // cliente cujo ROLLBACK falhou não volta ao pool: release(err) o descarta
  try {
    await cliente.query("BEGIN");
    const resultado = await fn(cliente);
    await cliente.query("COMMIT");
    return resultado;
  } catch (err) {
    await cliente.query("ROLLBACK").catch((erroRollback) => {
      quebrado = erroRollback;
      log.erro("DB_ROLLBACK_FALHOU", { erro: erroRollback.name, pg_codigo: erroRollback.code });
    });
    throw err;
  } finally {
    cliente.release(quebrado);
  }
}
