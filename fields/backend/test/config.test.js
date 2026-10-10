import { test } from "node:test";
import assert from "node:assert/strict";
import { carregarConfig, ErroConfig, ORCAMENTO_MAX_S } from "../src/config.js";
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

// ─── A2b · o agente ───

test("agente: desligado por padrão, com os padrões do plano (effort por canal, orçamentos, teto de chamadas)", () => {
  const { agente } = carregarConfig(VALIDO);
  assert.deepEqual(agente, {
    habilitado: false, modeloFalso: false, apiKey: null, modelo: "claude-opus-5-5",
    effort: { web: "medium", whatsapp: "low" },
    orcamentoMs: { web: 60_000, whatsapp: 100_000 },
    maxChamadas: 6, sessaoOciosaHoras: 6,
  });
  assert.ok(Object.isFrozen(agente) && Object.isFrozen(agente.effort) && Object.isFrozen(agente.orcamentoMs));
});

test("agente: AGENTE_HABILITADO exige ANTHROPIC_API_KEY (pelo nome), e o modelo falso dispensa a chave", () => {
  assert.throws(() => carregarConfig({ ...VALIDO, AGENTE_HABILITADO: "true" }), (err) => {
    assert.deepEqual(err.problemas.faltando, ["ANTHROPIC_API_KEY"]);
    return true;
  });
  const chave = "sk-ant-valor-que-nao-pode-vazar";
  const comChave = carregarConfig({ ...VALIDO, AGENTE_HABILITADO: "1", ANTHROPIC_API_KEY: chave });
  assert.deepEqual([comChave.agente.habilitado, comChave.agente.apiKey], [true, chave]);
  const falso = carregarConfig({ ...VALIDO, AGENTE_HABILITADO: "sim", AGENTE_MODELO_FALSO: "on" });
  assert.deepEqual([falso.agente.habilitado, falso.agente.modeloFalso, falso.agente.apiKey], [true, true, null]);
  // "false", "0" e vazio continuam desligados.
  for (const valor of ["false", "0", "", "não"]) assert.equal(carregarConfig({ ...VALIDO, AGENTE_HABILITADO: valor }).agente.habilitado, false, valor);
});

test("agente: AGENTE_MODELO_FALSO é recusado com NODE_ENV=production (fora dela, aceito)", () => {
  assert.throws(() => carregarConfig({ ...VALIDO, AGENTE_MODELO_FALSO: "1", NODE_ENV: "production" }), (err) => {
    assert.deepEqual(err.problemas.invalidas, ["AGENTE_MODELO_FALSO (proibido com NODE_ENV=production)"]);
    return true;
  });
  assert.equal(carregarConfig({ ...VALIDO, AGENTE_MODELO_FALSO: "1", NODE_ENV: "development" }).agente.modeloFalso, true);
  assert.equal(carregarConfig({ ...VALIDO, NODE_ENV: "production" }).agente.modeloFalso, false);
});

test("agente: orçamento acima de ORCAMENTO_MAX_S é recusado — a varredura de órfãos fecharia o turno ainda vivo", () => {
  assert.equal(ORCAMENTO_MAX_S, 240);
  const c = carregarConfig({ ...VALIDO, AGENTE_ORCAMENTO_WEB_S: "240", AGENTE_ORCAMENTO_WHATSAPP_S: "240" });
  assert.deepEqual([c.agente.orcamentoMs.web, c.agente.orcamentoMs.whatsapp], [240_000, 240_000]);
  assert.throws(() => carregarConfig({ ...VALIDO, AGENTE_ORCAMENTO_WHATSAPP_S: "300" }), (err) => {
    assert.deepEqual(err.problemas.invalidas.map((p) => p.split(" ")[0]), ["AGENTE_ORCAMENTO_WHATSAPP_S"]);
    assert.match(err.problemas.invalidas[0], /no máximo 240/);
    return true;
  });
});

test("agente: valores lidos do env, e os inválidos listados pelo NOME, sem o valor", () => {
  const c = carregarConfig({
    ...VALIDO, AGENTE_MODELO: "claude-opus-5", AGENTE_EFFORT_WEB: "high", AGENTE_EFFORT_WHATSAPP: "medium",
    AGENTE_ORCAMENTO_WEB_S: "45", AGENTE_ORCAMENTO_WHATSAPP_S: "90.5", AGENTE_MAX_CHAMADAS: "4", SESSAO_OCIOSA_HORAS: "1.5",
  });
  assert.deepEqual(
    [c.agente.modelo, c.agente.effort.web, c.agente.effort.whatsapp, c.agente.orcamentoMs.web, c.agente.orcamentoMs.whatsapp, c.agente.maxChamadas, c.agente.sessaoOciosaHoras],
    ["claude-opus-5", "high", "medium", 45_000, 90_500, 4, 1.5]);

  assert.throws(() => carregarConfig({
    ...VALIDO, AGENTE_EFFORT_WEB: "turbo-123", AGENTE_ORCAMENTO_WEB_S: "-1", AGENTE_MAX_CHAMADAS: "2.5", SESSAO_OCIOSA_HORAS: "abc",
  }), (err) => {
    assert.deepEqual(err.problemas.invalidas.map((p) => p.split(" ")[0]),
      ["AGENTE_EFFORT_WEB", "AGENTE_ORCAMENTO_WEB_S", "AGENTE_MAX_CHAMADAS", "SESSAO_OCIOSA_HORAS"]);
    assert.ok(!err.message.includes("turbo-123"), "o valor não aparece na mensagem");
    return true;
  });
});
