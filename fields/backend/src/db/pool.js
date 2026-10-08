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

// Carrega a recusa para fora do tx: lançar é o que faz o tx() dar ROLLBACK.
class RecusaNaTransacao extends Error {
  constructor(resultado) {
    super("recusa dentro da transação");
    this.name = "RecusaNaTransacao";
    this.resultado = resultado;
  }
}

/**
 * Como tx(), mas uma RECUSA (fn devolve {ok:false, ...}) também volta atrás — e é devolvida, não
 * lançada. É o que o agente precisa: uma operação composta (ler o alvo, escrever, anotar a ação no
 * turno) em que a segunda etapa recusa não pode deixar a primeira gravada. Os serviços da A1
 * recusam ANTES de escrever, então hoje isso só muda alguma coisa quando há composição — e é
 * justamente aí que um "deu meio certo" seria impossível de explicar.
 *
 * Com `db` já sendo um cliente emprestado (tx aninhada), a unidade é um SAVEPOINT: a recusa desfaz
 * só o que esta chamada escreveu, e a transação de fora segue.
 */
export async function txOuRecusa(db, fn) {
  if (typeof db.release === "function") {
    await db.query("SAVEPOINT tx_ou_recusa");
    let resultado;
    try {
      resultado = await fn(db);
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT tx_ou_recusa").catch(() => {});
      throw err;
    }
    await db.query(resultado?.ok === false ? "ROLLBACK TO SAVEPOINT tx_ou_recusa" : "RELEASE SAVEPOINT tx_ou_recusa");
    return resultado;
  }
  try {
    return await tx(db, async (cliente) => {
      const resultado = await fn(cliente);
      if (resultado?.ok === false) throw new RecusaNaTransacao(resultado);
      return resultado;
    });
  } catch (err) {
    if (err instanceof RecusaNaTransacao) return err.resultado;
    throw err;
  }
}
