import { test } from "node:test";
import assert from "node:assert/strict";
import { carregarConfig, ErroConfig } from "../src/config.js";
import { gerarHashSenha } from "../src/auth/sessao.js";
import { definirSaida, log } from "../src/lib/log.js";

const HASH = await gerarHashSenha("senha-de-teste");
const VALIDO = {
  DATABASE_URL: "postgres://u:p@localhost:5432/fields",
  FIELDS_SENHA_HASH: HASH,
  FIELDS_SEGREDO_SESSAO: "s".repeat(32),
  FIELDS_API_TOKEN: "t".repeat(32),
};

test("config válida carrega, com o SSL de sempre e a porta padrão", () => {
  const c = carregarConfig(VALIDO);
  assert.equal(c.porta, 3001);
  assert.deepEqual(c.databaseSsl, { rejectUnauthorized: false });
  assert.ok(Object.isFrozen(c));
});

test("DATABASE_SSL=false desliga o SSL; PORT é respeitada", () => {
  const c = carregarConfig({ ...VALIDO, DATABASE_SSL: "false", PORT: "8080" });
  assert.equal(c.databaseSsl, false);
  assert.equal(c.porta, 8080);
});

test("sem nada, lista as QUATRO obrigatórias pelo nome", () => {
  assert.throws(() => carregarConfig({}), (err) => {
    assert.ok(err instanceof ErroConfig);
    for (const nome of ["DATABASE_URL", "FIELDS_SENHA_HASH", "FIELDS_SEGREDO_SESSAO", "FIELDS_API_TOKEN"]) {
      assert.ok(err.message.includes(nome), nome);
    }
    return true;
  });
});

test("segredo curto é recusado sem imprimir o valor", () => {
  const curto = "curto-demais-123";
  assert.throws(() => carregarConfig({ ...VALIDO, FIELDS_API_TOKEN: curto, FIELDS_SEGREDO_SESSAO: curto }), (err) => {
    assert.deepEqual(err.problemas.curtas, ["FIELDS_SEGREDO_SESSAO", "FIELDS_API_TOKEN"]);
    assert.ok(!err.message.includes(curto), "o valor não pode aparecer na mensagem");
    return true;
  });
});

test("hash de senha fora do formato é recusado sem imprimir o valor", () => {
  const ruim = "senha-em-texto-puro";
  assert.throws(() => carregarConfig({ ...VALIDO, FIELDS_SENHA_HASH: ruim }), (err) => {
    assert.equal(err.problemas.invalidas.length, 1);
    assert.ok(!err.message.includes(ruim));
    return true;
  });
});

test("log: uma linha JSON, evento UPPER_SNAKE, chave com cara de segredo sai redigida", () => {
  const linhas = [];
  definirSaida((nivel, linha) => linhas.push({ nivel, registro: JSON.parse(linha) }));
  try {
    log.info("TESTE_OK", { rota: "/api/x", senha: "abc", api_token: "def", input_tokens: 10, ts: "forjado" });
    log.warn("nome ruim", {});
  } finally { definirSaida(null); }
  const [ok, ruim] = linhas;
  assert.equal(ok.registro.evento, "TESTE_OK");
  assert.equal(ok.registro.nivel, "info");
  assert.equal(ok.registro.senha, "[redigido]");
  assert.equal(ok.registro.api_token, "[redigido]");
  assert.equal(ok.registro.input_tokens, 10, "contador de tokens não é segredo");
  assert.notEqual(ok.registro.ts, "forjado", "campo não sobrescreve ts/nivel/evento");
  assert.equal(ruim.registro.evento, "LOG_EVENTO_INVALIDO");
});
