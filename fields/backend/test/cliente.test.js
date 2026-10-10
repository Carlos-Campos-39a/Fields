// O cliente do modelo (agente/cliente.js): a forma da requisição, o POST que o SDK de fato monta
// (com um fetch falso — nada sai da máquina), a classificação dos erros pelas classes do SDK e o
// modelo de roteiro do dev.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APIConnectionError, APIConnectionTimeoutError, APIUserAbortError, BadRequestError, InternalServerError,
} from "@anthropic-ai/sdk";
import { BETAS, MAX_TOKENS, MODELO_FALSO, classificarErro, criarCliente, modeloFalsoDev, montarRequisicao } from "../src/agente/cliente.js";
import { ferramentasClaude } from "../src/agente/catalogo.js";
import { systemPrompt } from "../src/agente/ontologia.js";
import { carregarConfig } from "../src/config.js";

const AGENTE = { habilitado: true, modeloFalso: false, apiKey: "sk-ant-teste-nao-e-chave", modelo: "claude-opus-5-5" };
const MENSAGENS = [{ role: "user", content: [{ type: "text", text: "<contexto/>" }, { type: "text", text: "oi" }] }];

test("montarRequisicao: system e tools congelados (mesmos bytes a cada chamada), messages é o que veio", () => {
  const a = montarRequisicao({ canal: "web", modelo: "claude-opus-5-5", effort: "medium", messages: MENSAGENS });
  const b = montarRequisicao({ canal: "web", modelo: "claude-opus-5-5", effort: "medium", messages: [] });
  assert.equal(JSON.stringify(a.system), JSON.stringify(b.system));
  assert.equal(JSON.stringify(a.tools), JSON.stringify(b.tools));
  assert.equal(a.messages, MENSAGENS, "o array do motor vai como está");
  assert.equal(a.system[0].text, systemPrompt({ canal: "web" }));
  assert.deepEqual(a.tools, ferramentasClaude());
  assert.ok(a.tools.every((t) => !("strict" in t)), "sem strict (orçamento do strict: catalogo.js)");
  // Nenhum dos 400 conhecidos do Opus 5.5: thinking desligado, budget, tool_choice forçado, sampling.
  assert.equal(a.thinking.type, "adaptive");
  assert.ok(!("budget_tokens" in a.thinking));
  assert.equal(a.tool_choice.type, "auto");
  for (const k of ["temperature", "top_p", "top_k"]) assert.ok(!(k in a), k);
  // Dois breakpoints de cache, ambos de 5 minutos (TTL diferente no último bloco é 400).
  assert.deepEqual(a.cache_control, { type: "ephemeral" });
  assert.deepEqual(a.system[0].cache_control, { type: "ephemeral" });
  assert.equal(montarRequisicao({ canal: "whatsapp", modelo: "m", effort: "low", messages: [] }).system[0].text, systemPrompt({ canal: "whatsapp" }));
});

test("o POST que o SDK monta: /v1/messages?beta=true, os dois betas no cabeçalho, o corpo sem `betas`, a chave só no x-api-key", async () => {
  const pedidos = [];
  const fetch = async (url, init) => {
    pedidos.push({ url: String(url), init });
    return new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "thinking", thinking: "", signature: "abc" }, { type: "text", text: "Oi." }],
      stop_reason: "end_turn", stop_sequence: null, stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      input_transformations: [],
    }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
  };
  const cliente = criarCliente(AGENTE, { fetch });
  assert.equal(cliente.modelo, "claude-opus-5-5");
  const corpo = montarRequisicao({ canal: "web", modelo: cliente.modelo, effort: "medium", messages: MENSAGENS });
  const resposta = await cliente.criar(corpo, { timeoutMs: 30_000 });
  assert.equal(resposta.stop_reason, "end_turn");
  assert.deepEqual(resposta.content[0], { type: "thinking", thinking: "", signature: "abc" }, "a resposta vem como a API mandou");

  assert.equal(pedidos.length, 1);
  const { url, init } = pedidos[0];
  assert.ok(url.endsWith("/v1/messages?beta=true"), url);
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("anthropic-beta"), BETAS.join(","));
  assert.equal(headers.get("x-api-key"), AGENTE.apiKey);
  assert.ok(init.signal, "o AbortSignal do prazo vai junto");
  const enviado = JSON.parse(init.body);
  const { betas: _b, ...esperado } = corpo;
  assert.deepEqual(enviado, JSON.parse(JSON.stringify(esperado)));
  assert.deepEqual(Object.keys(enviado).sort(), [
    "cache_control", "fallbacks", "max_tokens", "messages", "model", "output_config", "system", "thinking", "tool_choice", "tools",
  ]);
  assert.equal(enviado.max_tokens, MAX_TOKENS);
});

test("erros do SDK: 400 vira BadRequestError (REQUISICAO_400); 500 é refeito UMA vez e vira API", async () => {
  let n = 0;
  const fetch = async () => {
    n++;
    return new Response(JSON.stringify({ type: "error", error: { type: n === 1 ? "api_error" : "api_error", message: "x" } }),
      { status: 500, headers: { "content-type": "application/json", "retry-after-ms": "1", "request-id": "req_500" } });
  };
  const cliente = criarCliente(AGENTE, { fetch });
  const corpo = montarRequisicao({ canal: "web", modelo: "claude-opus-5-5", effort: "medium", messages: MENSAGENS });
  const err = await cliente.criar(corpo, { timeoutMs: 30_000 }).then(() => null, (e) => e);
  assert.ok(err instanceof InternalServerError);
  assert.equal(n, 2, "maxRetries 1: uma tentativa e uma retentativa");
  assert.deepEqual(classificarErro(err), { tipo: "API", status: 500, tipo_api: "api_error", request_id: "req_500" });

  const fetch400 = async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.1: bound to a different conversation" } }),
    { status: 400, headers: { "content-type": "application/json" } });
  const err400 = await criarCliente(AGENTE, { fetch: fetch400 }).criar(corpo, { timeoutMs: 30_000 }).then(() => null, (e) => e);
  assert.ok(err400 instanceof BadRequestError);
  assert.equal(classificarErro(err400).tipo, "REQUISICAO_400");
});

test("o prazo da chamada corta a espera (e a retentativa): PRAZO", async () => {
  const fetch = (_url, init) => new Promise((_ok, falha) => {
    init.signal?.addEventListener("abort", () => falha(Object.assign(new Error("abortado"), { name: "AbortError" })));
  });
  const corpo = montarRequisicao({ canal: "web", modelo: "claude-opus-5-5", effort: "medium", messages: MENSAGENS });
  const inicio = Date.now();
  const err = await criarCliente(AGENTE, { fetch }).criar(corpo, { timeoutMs: 150 }).then(() => null, (e) => e);
  assert.ok(err, "falhou");
  assert.equal(classificarErro(err).tipo, "PRAZO", err?.constructor?.name);
  assert.ok(Date.now() - inicio < 5_000, "não esperou além do prazo (nem a retentativa)");
});

test("classificarErro: pelas classes do SDK, nunca pelo texto", () => {
  assert.deepEqual(classificarErro(new APIUserAbortError()), { tipo: "PRAZO" });
  assert.deepEqual(classificarErro(new APIConnectionTimeoutError()), { tipo: "PRAZO" });
  assert.deepEqual(classificarErro(new APIConnectionError({ message: "ECONNRESET" })), { tipo: "REDE" });
  assert.equal(classificarErro(new BadRequestError(400, { error: { type: "invalid_request_error" } }, "m", new Headers())).tipo, "REQUISICAO_400");
  assert.deepEqual(classificarErro(new Error("400 Bad Request")), { tipo: "INTERNO" }, "texto parecido não engana");
});

test("modelo de roteiro do dev: /op chama a operação e responde curto; o resto é eco; JSON ruim é dito", async () => {
  const dev = modeloFalsoDev();
  assert.equal(dev.modelo, MODELO_FALSO);
  const usuario = (t) => ({ role: "user", content: [{ type: "text", text: "<contexto/>" }, { type: "text", text: t }] });

  const eco = await dev.criar({ model: dev.modelo, messages: [usuario("bom dia")] });
  assert.deepEqual([eco.stop_reason, eco.content], ["end_turn", [{ type: "text", text: "eco: bom dia" }]]);

  const op = await dev.criar({ model: dev.modelo, messages: [usuario('/op NovaTarefa {"frente_id":"f1","nome":"X"}')] });
  assert.equal(op.stop_reason, "tool_use");
  assert.deepEqual(op.content, [{ type: "tool_use", id: "toolu_falso_1", name: "NovaTarefa", input: { frente_id: "f1", nome: "X" } }]);
  const semArgs = await dev.criar({ model: dev.modelo, messages: [usuario("/op ResumoDoDia")] });
  assert.deepEqual(semArgs.content[0].input, {});

  const volta = await dev.criar({ model: dev.modelo, messages: [
    usuario("/op NovaTarefa {}"), { role: "assistant", content: op.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_falso_1", is_error: true, content: '{"erro":"x","codigo":"ARGUMENTOS_INVALIDOS"}' }] },
  ] });
  assert.deepEqual(volta.content, [{ type: "text", text: "NovaTarefa recusou (ARGUMENTOS_INVALIDOS)." }]);
  const ok = await dev.criar({ model: dev.modelo, messages: [
    usuario("/op ResumoDoDia"), { role: "assistant", content: semArgs.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: semArgs.content[0].id, content: "{}" }] },
  ] });
  assert.equal(ok.content[0].text, "ResumoDoDia: feito.");

  const ruim = await dev.criar({ model: dev.modelo, messages: [usuario("/op NovaTarefa {nao é json")] });
  assert.match(ruim.content[0].text, /objeto JSON/);
  assert.deepEqual(ruim.input_transformations, []);
});

test("criarCliente: AGENTE_MODELO_FALSO dá o de roteiro (sem chave); a config o recusa em produção", () => {
  assert.equal(criarCliente({ ...AGENTE, modeloFalso: true, apiKey: null }).modelo, MODELO_FALSO);
  assert.equal(criarCliente(AGENTE).modelo, "claude-opus-5-5");
  // A recusa é da config (config.test.js tem o resto): aqui só a ponta que importa.
  const base = { DATABASE_URL: "postgres://x", FIELDS_SENHA_HASH: "x", FIELDS_SEGREDO_SESSAO: "s".repeat(32), FIELDS_API_TOKEN: "t".repeat(32) };
  assert.throws(() => carregarConfig({ ...base, AGENTE_MODELO_FALSO: "1", NODE_ENV: "production" }),
    (err) => err.problemas.invalidas.some((p) => p.startsWith("AGENTE_MODELO_FALSO")));
});
