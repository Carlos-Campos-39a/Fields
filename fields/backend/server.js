// Bootstrap do Fields' API: config → banco → app → porta. Tudo o mais mora em src/.
// O Railway roda `node server.js` com raiz em fields/backend.

import { carregarConfig } from "./src/config.js";
import { criarPool } from "./src/db/pool.js";
import { initDB } from "./src/db/schema.js";
import { criarApp } from "./src/app.js";
import { log } from "./src/lib/log.js";
import { REPARO_POS_DEPLOY_MS, repararDivergencia } from "./src/db/migracoes.js";

let config;
try {
  config = carregarConfig(process.env);
} catch (err) {
  if (err.name !== "ErroConfig") throw err;
  log.erro("CONFIG_INVALIDA", err.problemas); // só NOMES de variável, nunca valores
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
}

const pool = criarPool(config);

// initDB devolve o `estado` lido do banco: hoje, se a migração de comentários rodou. Uma migração de
// DADO que falha não derruba o boot (o app sobe no modo legado); falha de SCHEMA derruba, e o
// healthcheck do Railway mantém o deploy anterior no ar.
initDB(pool)
  .then((estado) => {
    const app = criarApp({ config, db: pool, estado });
    app.listen(config.porta, "0.0.0.0", () => {
      log.info("SERVIDOR_NO_AR", { porta: config.porta });
      // A instância anterior (A0 na primeira subida, ou depois de um rollback) segue escrevendo no
      // jsonb até o healthcheck desta passar — e o reparo do boot já rodou. Uma segunda passada,
      // depois da sobreposição, recupera essas escritas. Nunca lança; unref() não segura o processo.
      if (estado.comentariosMigrados) {
        setTimeout(() => repararDivergencia(pool, { momento: "pos_deploy" }), REPARO_POS_DEPLOY_MS).unref();
      }
    });
  })
  .catch((err) => {
    // No boot não há dado de usuário em jogo: a mensagem (host recusou, senha do banco errada…)
    // é o que diagnostica, e vai para o log.
    log.erro("DB_FALHA_NO_BOOT", { erro: err.name, codigo: err.code, mensagem: err.message });
    process.exit(1);
  });
