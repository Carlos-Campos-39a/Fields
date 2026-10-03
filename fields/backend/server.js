// Bootstrap do Fields' API: config → banco → app → porta. Tudo o mais mora em src/.
// O Railway roda `node server.js` com raiz em fields/backend.

import { carregarConfig } from "./src/config.js";
import { criarPool } from "./src/db/pool.js";
import { initDB } from "./src/db/schema.js";
import { criarApp } from "./src/app.js";
import { log } from "./src/lib/log.js";

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

initDB(pool)
  .then(() => {
    const app = criarApp({ config, db: pool });
    app.listen(config.porta, "0.0.0.0", () => {
      log.info("SERVIDOR_NO_AR", { porta: config.porta });
    });
  })
  .catch((err) => {
    // No boot não há dado de usuário em jogo: a mensagem (host recusou, senha do banco errada…)
    // é o que diagnostica, e vai para o log.
    log.erro("DB_FALHA_NO_BOOT", { erro: err.name, codigo: err.code, mensagem: err.message });
    process.exit(1);
  });
