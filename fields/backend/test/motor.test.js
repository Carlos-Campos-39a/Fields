// O motor do agente (agente/motor.js) sem banco e sem API: o modelo é um roteiro que grava cada
// requisição (fakes/modeloFalso.js), a persistência é a loja em memória (fakes/lojaEmMemoria.js,
// com a mesma ida e volta de TEXTO da coluna `content`) e as ferramentas são um executor de roteiro.
// O que só o Postgres prova está em motor_integracao.test.js.
//
// O teste central é o INVARIANTE DE PREFIXO: em toda chamada da mesma sessão, `system` e `tools` são
// os mesmos bytes, e o `messages` de cada chamada é prefixo exato do da seguinte. É ele que garante
// que o pensamento preservado do Opus 5.5 nunca é invalidado por algo que nós mesmos editamos.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ehComandoDesfazer, iniciarTurno, naFila, novaConversa, rodarTurno, PRAZO_MINIMO_MS, TEXTO_FALHA, TEXTO_RECUSA } from "../src/agente/motor.js";
import { BETAS, MAX_TOKENS, modeloFalsoDev } from "../src/agente/cliente.js";
import { ferramentasClaude } from "../src/agente/catalogo.js";
import { systemPrompt } from "../src/agente/ontologia.js";
import { promptVersao } from "../src/agente/sessoes.js";
import { STATUS_TURNO } from "../src/dominio/enums.js";
import { definirSaida } from "../src/lib/log.js";
import { erro400, erroTimeout, ferramenta, modeloFalso, pensamento, texto } from "./fakes/modeloFalso.js";
import { executorFalso, lojaEmMemoria, relogioFalso } from "./fakes/lojaEmMemoria.js";

let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });

const AGENTE = Object.freeze({
  habilitado: true, modelo: "claude-opus-5-5", modeloFalso: false,
  effort: { web: "medium", whatsapp: "low" }, orcamentoMs: { web: 60_000, whatsapp: 100_000 },
  maxChamadas: 6, sessaoOciosaHoras: 6,
});

/** Monta o motor de teste. `desfazer` padrão: nada a desfazer (o teste do comando troca). */
function montar({ roteiro = [], respostas = {}, agente = {}, memorias = [], desfazer } = {}) {
  const relogio = relogioFalso();
  const loja = lojaEmMemoria({ relogio: relogio.agora, memorias });
  const cliente = modeloFalso(roteiro);
  const ex = executorFalso(loja, respostas);
  const chamadasDesfazer = [];
  const deps = {
    db: null, comentariosMigrados: true, agente: { ...AGENTE, ...agente }, cliente, loja, executar: ex.executar,
    relogio: relogio.agora,
    desfazer: async (ctx, alvo) => {
      chamadasDesfazer.push({ ctx, alvo });
      return desfazer ? desfazer(ctx, alvo) : { ok: false, motivo: "NADA_A_DESFAZER" };
    },
  };
  const falar = (textoDoCarlos, extra = {}) => rodarTurno(deps, { canal: "web", entrada: { texto: textoDoCarlos }, ...extra });
  return { deps, loja, cliente, ex, relogio, chamadasDesfazer, falar };
}

const ESCRITA = (resumo = "Criou a tarefa “Revisar deck” na frente “Cobrança”") => ({
  resultado: { tarefa_id: "t1", nome: "Revisar deck" },
  acao: { tool: "NovaTarefa", acao: "NOVA_TAREFA", resumo, desfazivel: true, inverso: "EXCLUIR" },
});

const json = (v) => JSON.stringify(v);

/** O invariante: system e tools idênticos, e cada messages prefixo do seguinte. */
function conferirPrefixo(chamadas) {
  for (let k = 1; k < chamadas.length; k++) {
    const antes = chamadas[k - 1].corpo;
    const depois = chamadas[k].corpo;
    assert.equal(json(depois.system), json(antes.system), `system mudou na chamada ${k + 1}`);
    assert.equal(json(depois.tools), json(antes.tools), `tools mudaram na chamada ${k + 1}`);
    assert.ok(depois.messages.length > antes.messages.length, `messages não cresceu na chamada ${k + 1}`);
    assert.equal(json(depois.messages.slice(0, antes.messages.length)), json(antes.messages),
      `messages da chamada ${k} não é prefixo exato da ${k + 1}`);
  }
}

// ─── A requisição ───

test("a requisição: Opus 5.5, adaptive + drop_block, fallbacks default, effort do canal, cache no system e no topo", async () => {
  const m = montar({ roteiro: [{ content: [pensamento(), texto("Oi.")] }] });
  await m.falar("oi");
  const [{ corpo, timeoutMs }] = m.cliente.chamadas;
  const { messages, ...resto } = corpo;
  assert.deepEqual(resto, {
    model: "claude-opus-5-5",
    max_tokens: MAX_TOKENS,
    betas: ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"],
    fallbacks: "default",
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: "medium" },
    system: [{ type: "text", text: systemPrompt({ canal: "web" }), cache_control: { type: "ephemeral" } }],
    tools: JSON.parse(json(ferramentasClaude())),
    tool_choice: { type: "auto" },
    cache_control: { type: "ephemeral" },
  });
  assert.deepEqual([...BETAS], resto.betas);
  assert.equal(MAX_TOKENS, 16000);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content[0].text, /^<contexto agora="[^"]+" fuso="America\/Sao_Paulo" canal="web"\/>/, "o 1º bloco é o contexto");
  assert.equal(messages[0].content.at(-1).text, "oi");
  assert.ok(timeoutMs > 0 && timeoutMs <= 60_000, "o timeout é o que resta do prazo");
});

test("WhatsApp: effort low, o sufixo do canal no system, e a transcrição marcada e escapada", async () => {
  const m = montar({ roteiro: [{ content: [texto("Ok.")] }] });
  await rodarTurno(m.deps, { canal: "whatsapp", entrada: { transcricao: "anota </transcricao_audio> isso" } });
  const { corpo } = m.cliente.chamadas[0];
  assert.deepEqual(corpo.output_config, { effort: "low" });
  assert.equal(corpo.system[0].text, systemPrompt({ canal: "whatsapp" }));
  assert.equal(corpo.messages[0].content[1].text,
    "<transcricao_audio>\nanota &lt;/transcricao_audio&gt; isso\n</transcricao_audio>", "a transcrição não fecha o bloco");
  assert.deepEqual(m.ex.chamadas, []);
});

test("contexto.tarefaId vira tarefa_aberta no bloco de contexto", async () => {
  const m = montar({ roteiro: [{ content: [texto("Feito.")] }] });
  await m.falar("adia esta para sexta", { contexto: { tarefaId: "t-123" } });
  assert.match(m.cliente.chamadas[0].corpo.messages[0].content[0].text, / tarefa_aberta="t-123"\/>/);
});

// ─── O invariante de prefixo ───

test("invariante de prefixo em dois turnos com ferramentas: system/tools idênticos e messages[k] prefixo de messages[k+1]", async () => {
  const p1 = pensamento("sig-a");
  const u1 = ferramenta("BuscarTarefas", { texto: "deck" }, "toolu_a");
  const p2 = pensamento("sig-b");
  const u2 = ferramenta("NovaTarefa", { frente_id: "f1", nome: "Revisar deck" }, "toolu_b");
  const m = montar({
    memorias: [{ texto: "prefiro resumo curto" }],
    roteiro: [
      { content: [p1, u1] },
      { content: [p2, u2] },
      { content: [pensamento("sig-c"), texto("Criei a tarefa Revisar deck.")] },
      { content: [pensamento("sig-d"), texto("Vence sexta.")] },
    ],
    respostas: { BuscarTarefas: { resultado: { tarefas: [], total: 0 } }, NovaTarefa: ESCRITA() },
  });
  const r1 = await m.falar("cria a tarefa revisar deck");
  const r2 = await m.falar("e quando vence?");
  assert.deepEqual([r1.status, r2.status], ["CONCLUIDO", "CONCLUIDO"]);
  assert.equal(m.cliente.chamadas.length, 4);
  assert.equal(m.cliente.restantes, 0);
  conferirPrefixo(m.cliente.chamadas);

  // Os blocos de pensamento voltam como vieram, inclusive a assinatura, e cada tool_use tem o seu
  // tool_result logo depois.
  const ultima = m.cliente.chamadas[3].corpo.messages;
  assert.deepEqual(ultima[1].content, [p1, u1]);
  assert.deepEqual(ultima[3].content, [p2, u2]);
  assert.deepEqual(ultima[2].content.map((b) => [b.type, b.tool_use_id, b.is_error ?? false]), [["tool_result", "toolu_a", false]]);
  assert.deepEqual(ultima[4].content.map((b) => [b.type, b.tool_use_id]), [["tool_result", "toolu_b"]]);
  assert.deepEqual(JSON.parse(ultima[4].content[0].content), ESCRITA().resultado);
  // Memória só no 1º turno da sessão; o 2º turno traz só o contexto e o texto.
  assert.match(ultima[0].content[0].text, /<memoria>\n.*prefiro resumo curto/s);
  assert.doesNotMatch(ultima[6].content[0].text, /<memoria>|<resumo_conversa_anterior>/);
  assert.deepEqual(ultima.map((x) => x.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  // O histórico gravado é exatamente o que foi mandado.
  const sessao = m.loja.sessoes[0];
  assert.equal(json(m.loja.historicoDe(sessao.id)), json([...ultima, { role: "assistant", content: [pensamento("sig-d"), texto("Vence sexta.")] }]));
});

test("as ferramentas rodam em sequência, pelo executor, com o ctx do canal (origem agente na tela, whatsapp no WhatsApp)", async () => {
  const m = montar({
    roteiro: [
      { content: [ferramenta("ListarProjetos"), ferramenta("BuscarTarefas", { texto: "x" })] },
      { content: [texto("Nada.")] },
      { content: [ferramenta("ResumoDoDia")] },
      { content: [texto("Hoje está livre.")] },
    ],
  });
  const r = await m.falar("o que tenho?");
  await rodarTurno(m.deps, { canal: "whatsapp", entrada: { texto: "e hoje?" } });
  assert.deepEqual(m.ex.chamadas.map((c) => [c.nome, c.ctx.origem, c.ctx.canal]), [
    ["ListarProjetos", "agente", "web"], ["BuscarTarefas", "agente", "web"], ["ResumoDoDia", "whatsapp", "whatsapp"],
  ]);
  assert.ok(m.ex.chamadas.every((c) => typeof c.ctx.turnoId === "string" && c.ctx.comentariosMigrados === true));
  assert.equal(m.ex.chamadas[0].ctx.turnoId, r.turno_id);
  assert.deepEqual(r.progresso, { n_tools: 2 });
  // Uma sessão por canal.
  assert.deepEqual(m.loja.sessoes.map((s) => s.canal), ["web", "whatsapp"]);
});

// ─── O turno e as ações ───

test("ações registradas: o turno devolve as ações da escrita, o texto do modelo e as métricas", async () => {
  const m = montar({
    roteiro: [
      { content: [ferramenta("NovaTarefa", { frente_id: "f1", nome: "Revisar deck" })], usage: { input_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 } },
      { content: [texto("Criei a tarefa Revisar deck na frente Cobrança.")], usage: { input_tokens: 80, cache_read_input_tokens: 4300 } },
    ],
    respostas: { NovaTarefa: ESCRITA() },
  });
  const r = await m.falar("cria revisar deck na cobrança");
  assert.deepEqual(Object.keys(r).sort(), ["acoes", "concluido_em", "criado_em", "entrada", "motivo", "progresso", "sessao_id", "status", "texto", "turno_id"]);
  assert.equal(r.status, "CONCLUIDO");
  assert.equal(r.motivo, null);
  assert.equal(r.texto, "Criei a tarefa Revisar deck na frente Cobrança.");
  assert.equal(r.entrada, "cria revisar deck na cobrança");
  assert.deepEqual(r.acoes, [{ idx: 0, acao: "NOVA_TAREFA", resumo: "Criou a tarefa “Revisar deck” na frente “Cobrança”", desfazivel: true, desfeito_em: null }]);
  const metricas = m.loja.turnos.get(r.turno_id).metricas;
  assert.deepEqual(
    [metricas.chamadas, metricas.n_tools, metricas.input_tokens, metricas.cache_read_input_tokens, metricas.cache_creation_input_tokens, metricas.output_tokens],
    [2, 1, 130, 8300, 300, 40]);
  assert.equal(m.loja.sessoes[0].ultimo_input_tokens, 80 + 4300, "o tamanho do prompt da última chamada");

  const turno = logs.find((l) => l.evento === "AGENTE_TURNO");
  assert.deepEqual([turno.nivel, turno.status, turno.chamadas, turno.n_tools, turno.n_acoes, turno.sessao_nova], ["info", "CONCLUIDO", 2, 1, 1, true]);
  const saidas = logs.filter((l) => l.evento === "LLM_OUT");
  assert.equal(saidas.length, 2);
  assert.deepEqual(
    [saidas[0].modelo_pedido, saidas[0].modelo_servido, saidas[0].stop_reason, saidas[0].cache_read_input_tokens, saidas[0].cache_creation_input_tokens, saidas[0].n_tool_use],
    ["claude-opus-5-5", "claude-opus-5-5", "tool_use", 4000, 300, 1]);
  assert.equal(typeof saidas[0].duration_ms, "number");
  assert.ok(!json(logs).includes("Revisar deck"), "nem o pedido, nem a resposta, nem o resumo vão ao log");
  assert.equal(logs.find((l) => l.evento === "AGENTE_SESSAO_NOVA").motivo, "PRIMEIRA");
});

test("recusa de ferramenta volta ao modelo como is_error com o código, e o turno segue", async () => {
  const m = montar({
    roteiro: [{ content: [ferramenta("EditarTarefa", { tarefa_id: "x", status: "Quase" })] }, { content: [texto("Esse status não existe.")] }],
    respostas: { EditarTarefa: { erro: "Argumentos inválidos — veja `campos`.", codigo: "ARGUMENTOS_INVALIDOS", campos: { status: "inválido" } } },
  });
  const r = await m.falar("muda o status para quase");
  assert.equal(r.status, "CONCLUIDO");
  const resultado = m.cliente.chamadas[1].corpo.messages[2].content[0];
  assert.equal(resultado.is_error, true);
  assert.equal(JSON.parse(resultado.content).codigo, "ARGUMENTOS_INVALIDOS");
});

// ─── Os finais ───

test("prazo: a chamada demora e o prazo acaba → ESGOTADO/PRAZO, resposta parcial honesta, sem nova chamada", async () => {
  let m;
  m = montar({
    roteiro: [
      () => { m.relogio.avancar(57_000); return { content: [ferramenta("NovaTarefa", { frente_id: "f1", nome: "A" })] }; },
    ],
    respostas: { NovaTarefa: ESCRITA("Criou a tarefa “A”") },
  });
  const r = await m.falar("cria A, B e C");
  assert.deepEqual([r.status, r.motivo], ["ESGOTADO", "PRAZO"]);
  assert.equal(r.texto, "Não deu tempo de terminar. O que já fiz: Criou a tarefa “A”. Peça de novo para eu continuar.");
  assert.equal(m.cliente.chamadas.length, 1, "com menos de PRAZO_MINIMO_MS não começa outra chamada");
  assert.ok(PRAZO_MINIMO_MS >= 1000);
  // O texto mostrado entra no histórico como resposta do assistente, depois dos tool_result.
  const hist = m.loja.historicoDe(m.loja.sessoes[0].id);
  assert.deepEqual(hist.map((x) => x.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(hist[3].content, [{ type: "text", text: r.texto }]);
  assert.equal(logs.find((l) => l.evento === "AGENTE_TURNO").nivel, "warn");
});

test("prazo antes de CADA ferramenta: a que não cabe recebe is_error e não roda", async () => {
  let m;
  m = montar({
    roteiro: [{ content: [ferramenta("NovaTarefa", { nome: "A" }, "toolu_1"), ferramenta("NovaTarefa", { nome: "B" }, "toolu_2")] }],
    respostas: { NovaTarefa: () => { m.relogio.avancar(61_000); return ESCRITA("Criou a tarefa “A”"); } },
  });
  const r = await m.falar("cria A e B");
  assert.deepEqual([r.status, r.motivo], ["ESGOTADO", "PRAZO"]);
  assert.equal(m.ex.chamadas.length, 1, "só a primeira rodou");
  const resultados = m.loja.historicoDe(m.loja.sessoes[0].id)[2].content;
  assert.deepEqual(resultados.map((b) => [b.tool_use_id, b.is_error ?? false]), [["toolu_1", false], ["toolu_2", true]]);
  assert.match(resultados[1].content, /tempo deste turno acabou/);
});

test("o prazo que vence na FILA: o turno nem chama o modelo", async () => {
  const m = montar({ roteiro: [] });
  m.relogio.avancar(0);
  const r = await m.falar("oi", { prazoMs: 1_000 });
  assert.deepEqual([r.status, r.motivo, m.cliente.chamadas.length], ["ESGOTADO", "PRAZO", 0]);
  assert.equal(r.texto, "Não deu tempo de terminar. Nada foi alterado. Peça de novo, de preferência em partes menores.");
  assert.deepEqual(m.loja.mensagens, [], "nada deste turno entra no histórico");
});

test("timeout do SDK → ESGOTADO/PRAZO, e LLM_ERRO em warn", async () => {
  const m = montar({ roteiro: [erroTimeout()] });
  const r = await m.falar("oi");
  assert.deepEqual([r.status, r.motivo], ["ESGOTADO", "PRAZO"]);
  const erro = logs.find((l) => l.evento === "LLM_ERRO");
  assert.deepEqual([erro.nivel, erro.tipo], ["warn", "PRAZO"]);
});

test("limite de chamadas: com AGENTE_MAX_CHAMADAS=2 o terceiro pedido de ferramenta não acontece → ESGOTADO/LIMITE_CHAMADAS", async () => {
  const m = montar({
    agente: { maxChamadas: 2 },
    roteiro: [{ content: [ferramenta("BuscarTarefas", {})] }, { content: [ferramenta("BuscarTarefas", { texto: "y" })] }],
  });
  const r = await m.falar("procura tudo");
  assert.deepEqual([r.status, r.motivo, m.cliente.chamadas.length, m.ex.chamadas.length], ["ESGOTADO", "LIMITE_CHAMADAS", 2, 2]);
  assert.match(r.texto, /^Parei no limite de passos deste pedido\. Nada foi alterado\./);
  const hist = m.loja.historicoDe(m.loja.sessoes[0].id);
  assert.equal(hist.at(-1).role, "assistant", "o histórico fecha com o texto mostrado");
});

test("refusal → RECUSADO com texto fixo, LLM_RECUSA com a categoria, e a sessão encerra (a próxima mensagem abre outra)", async () => {
  const m = montar({
    roteiro: [
      { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } },
      { content: [texto("Oi de novo.")] },
    ],
  });
  const r = await m.falar("pedido-que-o-classificador-barrou");
  assert.deepEqual([r.status, r.motivo, r.texto], ["RECUSADO", "RECUSA", TEXTO_RECUSA]);
  const recusa = logs.find((l) => l.evento === "LLM_RECUSA");
  assert.deepEqual([recusa.nivel, recusa.categoria], ["warn", "cyber"]);
  assert.ok(!json(recusa).includes("explanation"));
  assert.deepEqual([m.loja.sessoes[0].status, m.loja.sessoes[0].motivo], ["ENCERRADA", "RECUSA"]);
  assert.deepEqual(m.loja.mensagens, [], "o conteúdo recusado não entra no histórico");
  assert.equal(m.loja.turnos.get(r.turno_id).metricas.categoria_recusa, "cyber");

  logs = [];
  const r2 = await m.falar("oi");
  assert.equal(r2.status, "CONCLUIDO");
  assert.equal(m.loja.sessoes.length, 2);
  assert.equal(logs.find((l) => l.evento === "AGENTE_SESSAO_NOVA").motivo, "RECUSA");
  // A sessão nova começa com o recap, que conta a recusa — SEM o texto recusado: os classificadores
  // avaliam a requisição inteira, e o pedido de volta derrubaria o turno seguinte também.
  assert.match(m.cliente.chamadas[1].corpo.messages[0].content[0].text, /<resumo_conversa_anterior>[\s\S]*pedido recusado pelo modelo/);
  assert.ok(!json(m.cliente.chamadas[1].corpo).includes("pedido-que-o-classificador-barrou"), "o pedido recusado não volta pelo recap");
});

test("recusa depois de uma escrita: o texto diz o que já foi feito, e o recap da sessão nova leva o 'feito' sem o pedido", async () => {
  const m = montar({
    roteiro: [
      { content: [ferramenta("NovaTarefa", { frente_id: "f1", nome: "Revisar deck" })] },
      { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "bio" } },
      { content: [texto("Oi.")] },
    ],
    respostas: { NovaTarefa: ESCRITA() },
  });
  const r = await m.falar("cria-revisar-deck-e-o-resto");
  assert.deepEqual([r.status, r.motivo, r.acoes.length], ["RECUSADO", "RECUSA", 1]);
  assert.equal(r.texto, "O modelo recusou continuar este pedido. O que já fiz antes disso: Criou a tarefa “Revisar deck” na frente “Cobrança”. Não repita o pedido inteiro; diga o que falta.");
  await m.falar("oi");
  const corpo = m.cliente.chamadas[2].corpo;
  assert.match(corpo.messages[0].content[0].text, /pedido recusado pelo modelo[^\n]*\n {2}feito: Criou a tarefa “Revisar deck”/);
  assert.ok(!json(corpo).includes("cria-revisar-deck-e-o-resto"));
});

test("max_tokens com tool_use → nada roda, cada tool_use recebe is_error, FALHOU/MAX_TOKENS e o histórico fica válido", async () => {
  const m = montar({
    roteiro: [{ content: [pensamento(), ferramenta("NovaTarefa", { frente_id: "f1" }, "toolu_cortado")], stop_reason: "max_tokens" }],
  });
  const r = await m.falar("cria uma tarefa enorme");
  assert.deepEqual([r.status, r.motivo, r.texto], ["FALHOU", "MAX_TOKENS", TEXTO_FALHA]);
  assert.deepEqual(m.ex.chamadas, [], "o tool_use cortado não roda");
  const hist = m.loja.historicoDe(m.loja.sessoes[0].id);
  assert.deepEqual(hist.map((x) => x.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(hist[2].content.map((b) => [b.tool_use_id, b.is_error]), [["toolu_cortado", true]]);
  assert.equal(logs.find((l) => l.evento === "AGENTE_TURNO").nivel, "erro");
});

test("max_tokens só com texto → CONCLUIDO/MAX_TOKENS com o texto cortado", async () => {
  const m = montar({ roteiro: [{ content: [texto("Uma resposta que")], stop_reason: "max_tokens" }] });
  const r = await m.falar("explica tudo");
  assert.deepEqual([r.status, r.motivo, r.texto], ["CONCLUIDO", "MAX_TOKENS", "Uma resposta que…"]);
});

test("end_turn com content vazio: grava o texto mostrado ('Pronto.') e o 2º turno segue na mesma sessão, sem 400", async () => {
  // O modeloFalso recusa com 400, como a API, mensagem vazia que não seja a última do assistente:
  // gravado vazio, o 2º turno cairia no ramo de histórico estragado e abriria sessão nova.
  const m = montar({
    roteiro: [{ content: [ferramenta("BuscarTarefas", {})] }, { content: [] }, { content: [texto("Dois.")] }],
  });
  const r1 = await m.falar("procura");
  assert.deepEqual([r1.status, r1.texto], ["CONCLUIDO", "Pronto."]);
  const r2 = await m.falar("e agora?");
  assert.deepEqual([r2.status, r2.texto], ["CONCLUIDO", "Dois."]);
  assert.equal(m.loja.sessoes.length, 1, "sem sessão nova");
  assert.equal(logs.find((l) => l.evento === "LLM_ERRO"), undefined);
  assert.deepEqual(m.loja.historicoDe(m.loja.sessoes[0].id)[3], { role: "assistant", content: [{ type: "text", text: "Pronto." }] });
  conferirPrefixo(m.cliente.chamadas);

  // max_tokens sem nada: o mesmo cuidado, com o texto de falha.
  const m2 = montar({ roteiro: [{ content: [], stop_reason: "max_tokens" }] });
  const r3 = await m2.falar("explica");
  assert.deepEqual([r3.status, r3.motivo, r3.texto], ["FALHOU", "MAX_TOKENS", TEXTO_FALHA]);
  assert.deepEqual(m2.loja.historicoDe(m2.loja.sessoes[0].id).at(-1), { role: "assistant", content: [{ type: "text", text: TEXTO_FALHA }] });
});

test("falha depois de uma escrita: o texto diz o que já foi feito (ERRO_LLM, ERRO_HISTORICO e MAX_TOKENS)", async () => {
  // No WhatsApp não há chip de ação: "não consegui processar" faria o Carlos repetir — e duplicar a tarefa.
  const esperado = "Desculpe, não consegui terminar. O que já fiz: Criou a tarefa “Revisar deck” na frente “Cobrança”. Não repita o pedido inteiro; diga o que falta.";
  for (const [segunda, motivo] of [
    [new Error("rede caiu"), "ERRO_LLM"],
    [erro400(), "ERRO_HISTORICO"],
    [{ content: [ferramenta("NovaTarefa", {}, "toolu_cortado")], stop_reason: "max_tokens" }, "MAX_TOKENS"],
  ]) {
    const m = montar({ roteiro: [{ content: [ferramenta("NovaTarefa", {})] }, segunda], respostas: { NovaTarefa: ESCRITA() } });
    const r = await m.falar("cria revisar deck e mais");
    assert.deepEqual([r.status, r.motivo, r.texto, r.acoes.length], ["FALHOU", motivo, esperado, 1], motivo);
    // O texto entra no histórico como resposta do assistente: o modelo sabe o que o Carlos leu.
    assert.deepEqual(m.loja.historicoDe(m.loja.sessoes[0].id).at(-1), { role: "assistant", content: [{ type: "text", text: esperado }] }, motivo);
  }
});

test("exceção depois de uma escrita: ERRO_INTERNO diz o que foi feito, encerra a sessão, e a seguinte sabe pelo recap", async () => {
  const m = montar({
    roteiro: [{ content: [ferramenta("NovaTarefa", {})] }, { content: [texto("Oi.")] }],
    respostas: { NovaTarefa: ESCRITA() },
  });
  const progresso = m.loja.registrarProgresso;
  m.loja.registrarProgresso = async () => { throw Object.assign(new Error("db"), { code: "57P01" }); };
  const r = await m.falar("cria revisar deck");
  assert.deepEqual([r.status, r.motivo, r.acoes.length], ["FALHOU", "ERRO_INTERNO", 1]);
  assert.match(r.texto, /^Desculpe, não consegui terminar\. O que já fiz: Criou a tarefa “Revisar deck” na frente “Cobrança”\. Não repita/);
  assert.deepEqual([m.loja.sessoes[0].status, m.loja.sessoes[0].motivo], ["ENCERRADA", "ERRO_INTERNO"]);
  assert.deepEqual(m.loja.mensagens, [], "a rodada da escrita não chegou ao histórico");

  m.loja.registrarProgresso = progresso;
  logs = [];
  await m.falar("e aí?");
  assert.equal(logs.find((l) => l.evento === "AGENTE_SESSAO_NOVA").motivo, "ERRO_INTERNO");
  assert.match(m.cliente.chamadas[1].corpo.messages[0].content[0].text, /<resumo_conversa_anterior>[\s\S]*feito: Criou a tarefa “Revisar deck”/);
});

test("pause_turn: o assistente volta como veio e o laço chama de novo", async () => {
  const m = montar({ roteiro: [{ content: [pensamento("sig-p")], stop_reason: "pause_turn" }, { content: [texto("Pronto.")] }] });
  const r = await m.falar("pensa bastante");
  assert.equal(r.status, "CONCLUIDO");
  assert.deepEqual(m.cliente.chamadas[1].corpo.messages.at(-1), { role: "assistant", content: [pensamento("sig-p")] });
  conferirPrefixo(m.cliente.chamadas);
});

test("400 de histórico → a sessão encerra (ERRO_HISTORICO) e o turno tenta UMA vez numa sessão nova, com recap", async () => {
  const m = montar({ roteiro: [{ content: [texto("Oi.")] }, erro400(), { content: [texto("Retomei.")] }] });
  await m.falar("oi");
  logs = [];
  const r = await m.falar("e agora?");
  assert.deepEqual([r.status, r.texto], ["CONCLUIDO", "Retomei."]);
  assert.deepEqual(m.loja.sessoes.map((s) => [s.status, s.motivo]), [["ENCERRADA", "ERRO_HISTORICO"], ["ATIVA", null]]);
  const [, ruim, retentativa] = m.cliente.chamadas;
  assert.equal(ruim.corpo.messages.length, 3, "a chamada que falhou levava o histórico");
  assert.equal(retentativa.corpo.messages.length, 1, "a retentativa vai sem ele");
  assert.match(retentativa.corpo.messages[0].content[0].text, /<resumo_conversa_anterior>[\s\S]*"oi" → você: "Oi\."/);
  assert.equal(retentativa.corpo.messages[0].content.at(-1).text, "e agora?");
  const erro = logs.find((l) => l.evento === "LLM_ERRO");
  assert.deepEqual([erro.nivel, erro.tipo, erro.status, erro.historico], ["erro", "REQUISICAO_400", 400, 2]);
  assert.equal(logs.find((l) => l.evento === "AGENTE_SESSAO_NOVA").motivo, "ERRO_HISTORICO");
});

test("400 com ferramenta já rodada no turno: não refaz (repetiria escrita) — FALHOU/ERRO_HISTORICO", async () => {
  const m = montar({
    roteiro: [{ content: [ferramenta("NovaTarefa", {})] }, erro400()],
    respostas: { NovaTarefa: ESCRITA() },
  });
  const r = await m.falar("cria");
  assert.deepEqual([r.status, r.motivo, m.cliente.chamadas.length, m.ex.chamadas.length], ["FALHOU", "ERRO_HISTORICO", 2, 1]);
  assert.equal(r.acoes.length, 1, "a ação feita continua desfazível");
  assert.match(r.texto, /O que já fiz: Criou a tarefa/);
});

test("400 numa sessão sem histórico não é de histórico: FALHOU/ERRO_LLM, sem retentativa", async () => {
  const m = montar({ roteiro: [erro400("tools.0: invalid")] });
  const r = await m.falar("oi");
  assert.deepEqual([r.status, r.motivo, r.texto, m.cliente.chamadas.length], ["FALHOU", "ERRO_LLM", TEXTO_FALHA, 1]);
  assert.equal(m.loja.sessoes[0].status, "ATIVA");
});

test("exceção → FALHOU com 'Desculpe, não consegui processar agora.'; nada pendurado no histórico", async () => {
  const m = montar({ roteiro: [new Error("rede caiu")] });
  const r = await m.falar("oi");
  assert.deepEqual([r.status, r.motivo, r.texto], ["FALHOU", "ERRO_LLM", "Desculpe, não consegui processar agora."]);
  assert.deepEqual(m.loja.mensagens, []);

  const quebrada = montar({ roteiro: [{ content: [texto("x")] }] });
  quebrada.loja.memoriasAtivas = async () => { throw Object.assign(new Error("db"), { code: "57P01" }); };
  const r2 = await quebrada.falar("oi");
  assert.deepEqual([r2.status, r2.motivo], ["FALHOU", "ERRO_INTERNO"]);
  const turno = logs.findLast((l) => l.evento === "AGENTE_TURNO");
  assert.deepEqual([turno.nivel, turno.erro, turno.pg_codigo], ["erro", "Error", "57P01"]);
});

test("LLM_THINKING_DESCARTADO quando input_transformations não vem vazio; modelo servido diferente do pedido (fallback)", async () => {
  const m = montar({
    roteiro: [{
      content: [{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } }, texto("Oi.")],
      model: "claude-opus-5",
      usage: { iterations: [{ type: "message" }, { type: "fallback_message" }] },
      input_transformations: [
        { type: "thinking_dropped", path: "messages.1.content.0", reason: "model_binding_mismatch" },
        { type: "thinking_dropped", path: "messages.3.content.0", reason: "model_binding_mismatch" },
      ],
    }],
  });
  await m.falar("oi");
  const saida = logs.find((l) => l.evento === "LLM_OUT");
  assert.deepEqual([saida.modelo_pedido, saida.modelo_servido, saida.fallback, saida.n_transformacoes], ["claude-opus-5-5", "claude-opus-5", true, 2]);
  const descartado = logs.find((l) => l.evento === "LLM_THINKING_DESCARTADO");
  assert.deepEqual([descartado.nivel, descartado.n, descartado.motivos], ["warn", 2, { model_binding_mismatch: 2 }]);
  // O bloco de fallback fica no histórico como veio (a API o ignora na volta).
  assert.equal(m.loja.historicoDe(m.loja.sessoes[0].id)[1].content[0].type, "fallback");
});

test("sem transformação nenhuma, nenhum LLM_THINKING_DESCARTADO", async () => {
  const m = montar({ roteiro: [{ content: [texto("Oi.")] }] });
  await m.falar("oi");
  assert.equal(logs.find((l) => l.evento === "LLM_THINKING_DESCARTADO"), undefined);
});

// ─── A sessão ───

test("renovação por prompt_versao: a sessão ativa com outra versão encerra (PROMPT_VERSAO) e o histórico velho não vai", async () => {
  const m = montar({ roteiro: [{ content: [texto("Um.")] }, { content: [texto("Dois.")] }] });
  await m.falar("um");
  m.loja.sessoes[0].prompt_versao = "versao-de-antes-do-deploy";
  logs = [];
  await m.falar("dois");
  assert.deepEqual(m.loja.sessoes.map((s) => [s.status, s.motivo, s.prompt_versao === promptVersao("web")]),
    [["ENCERRADA", "PROMPT_VERSAO", false], ["ATIVA", null, true]]);
  assert.equal(m.cliente.chamadas[1].corpo.messages.length, 1);
  assert.equal(logs.find((l) => l.evento === "AGENTE_SESSAO_NOVA").motivo, "PROMPT_VERSAO");
});

test("renovação por PARADA: horas sem conversa abrem sessão nova", async () => {
  const m = montar({ roteiro: [{ content: [texto("Um.")] }, { content: [texto("Dois.")] }] });
  await m.falar("um");
  m.relogio.avancar(6 * 3_600_000 + 1);
  await m.falar("dois");
  assert.deepEqual(m.loja.sessoes.map((s) => s.motivo), ["PARADA", null]);
});

test("nova conversa: encerra a ativa (PEDIDO); a próxima mensagem abre outra com o recap", async () => {
  const m = montar({ roteiro: [{ content: [texto("Um.")] }, { content: [texto("Dois.")] }] });
  await m.falar("um");
  assert.deepEqual(await novaConversa(m.loja, "web"), { encerrada: true });
  assert.deepEqual(await novaConversa(m.loja, "web"), { encerrada: false });
  logs = [];
  await m.falar("dois");
  assert.equal(logs.find((l) => l.evento === "AGENTE_SESSAO_NOVA").motivo, "PEDIDO");
  assert.match(m.cliente.chamadas[1].corpo.messages[0].content[0].text, /<resumo_conversa_anterior>/);
});

// ─── O "desfazer" ───

test("ehComandoDesfazer: a palavra sozinha, sem acento e sem pontuação; frase com alvo é pedido para o modelo", () => {
  for (const s of ["desfazer", "Desfazer", " desfaz ", "DESFAÇA", "desfaca!", "desfazer.", "Desfaz?"]) assert.ok(ehComandoDesfazer(s), s);
  for (const s of ["desfaz a tarefa X", "não desfazer", "desfazendo", "", null, undefined]) assert.ok(!ehComandoDesfazer(s), String(s));
});

test("'desfazer': ZERO chamadas ao modelo; desfaz o último turno com ação, e o par entra no histórico por acréscimo", async () => {
  const m = montar({
    roteiro: [{ content: [ferramenta("NovaTarefa", {})] }, { content: [texto("Criei.")] }],
    respostas: { NovaTarefa: ESCRITA() },
    desfazer: async () => ({ ok: true, valor: { desfeitas: [{ idx: 0, resumo: "Criou a tarefa “Revisar deck” na frente “Cobrança”" }] } }),
  });
  const criou = await m.falar("cria revisar deck");
  const chamadasAntes = m.cliente.chamadas.length;
  const r = await m.falar("desfazer");
  assert.equal(m.cliente.chamadas.length, chamadasAntes, "nenhuma chamada ao modelo");
  assert.deepEqual([r.status, r.motivo, r.texto], ["CONCLUIDO", null, "Desfeito: Criou a tarefa “Revisar deck” na frente “Cobrança”."]);
  assert.deepEqual(r.desfazer, { turno_id: criou.turno_id, desfeitas: [{ idx: 0, resumo: "Criou a tarefa “Revisar deck” na frente “Cobrança”" }] });
  assert.deepEqual(m.chamadasDesfazer.map((c) => [c.alvo.turnoId, c.ctx.origem, c.ctx.comentariosMigrados]), [[criou.turno_id, "agente", true]]);
  const hist = m.loja.historicoDe(m.loja.sessoes[0].id);
  assert.deepEqual(hist.slice(-2).map((x) => x.role), ["user", "assistant"]);
  assert.equal(hist.at(-2).content.at(-1).text, "desfazer");
  assert.deepEqual(hist.at(-1).content, [{ type: "text", text: r.texto }]);
  assert.equal(logs.findLast((l) => l.evento === "AGENTE_TURNO").comando, "DESFAZER");
});

test("'desfazer' sem nada recente: NADA_A_DESFAZER, sem chamar o desfazer nem o modelo; recusa do desfazer vira o texto dela", async () => {
  const m = montar({});
  const r = await m.falar("Desfaz");
  assert.deepEqual([r.status, r.motivo, r.desfazer, m.cliente.chamadas.length, m.chamadasDesfazer.length], ["CONCLUIDO", "NADA_A_DESFAZER", null, 0, 0]);
  assert.match(r.texto, /^Não achei nada recente para desfazer/);

  const m2 = montar({
    roteiro: [{ content: [ferramenta("NovaTarefa", {})] }, { content: [texto("Criei.")] }],
    respostas: { NovaTarefa: ESCRITA() },
    desfazer: async () => ({ ok: false, motivo: "ALTERADO_DEPOIS" }),
  });
  const criou = await m2.falar("cria");
  const r2 = await m2.falar("desfazer");
  assert.deepEqual([r2.motivo, r2.desfazer], ["ALTERADO_DEPOIS", { turno_id: criou.turno_id, desfeitas: [], codigo: "ALTERADO_DEPOIS" }]);
  assert.match(r2.texto, /mudou depois dessa ação/);
});

test("'desfazer' do chat não alcança a ação que a tela gravou por /api/ops (turno web sem sessão), nem a conversa a lista", async () => {
  const m = montar({});
  // O turno de uma ação só do POST /api/ops pela tela: canal web, CONCLUIDO, sem sessão, sem texto.
  m.loja.turnos.set("op-da-tela", {
    id: "op-da-tela", canal: "web", sessao_id: null, status: "CONCLUIDO", motivo: null, entrada: null, resposta: null,
    acoes: [{ idx: 0, acao: "NOVA_TAREFA", resumo: "Criou", desfazivel: true, desfeito_em: null }], metricas: null,
    criado_em: m.relogio.agora(), concluido_em: m.relogio.agora(), ordem: -1,
  });
  const r = await m.falar("desfazer");
  assert.deepEqual([r.motivo, m.chamadasDesfazer.length], ["NADA_A_DESFAZER", 0]);
  assert.deepEqual((await m.loja.listarConversa("web", 30)).map((t) => t.turno_id), [r.turno_id]);
});

test("o modelo de roteiro do dev (AGENTE_MODELO_FALSO) roda no motor: /op chama a operação, o resto é eco", async () => {
  const m = montar({ respostas: { NovaTarefa: ESCRITA() } });
  m.deps.cliente = modeloFalsoDev();
  const r = await m.falar('/op NovaTarefa {"frente_id":"f1","nome":"Revisar deck"}');
  assert.deepEqual([r.status, r.texto, r.acoes.length], ["CONCLUIDO", "NovaTarefa: feito.", 1]);
  assert.deepEqual(m.ex.chamadas.map((c) => [c.nome, c.args]), [["NovaTarefa", { frente_id: "f1", nome: "Revisar deck" }]]);
  assert.equal((await m.falar("bom dia")).texto, "eco: bom dia");
  assert.equal(m.loja.sessoes[0].modelo, "modelo-falso", "a sessão sabe com que modelo conversou");
});

// ─── A fila ───

test("um turno por canal por vez: o segundo espera o primeiro e vê o histórico dele", async () => {
  let soltar;
  const trava = new Promise((ok) => { soltar = ok; });
  const m = montar({ roteiro: [async () => { await trava; return { content: [texto("Primeiro.")] }; }, { content: [texto("Segundo.")] }] });
  const a = await iniciarTurno(m.deps, { canal: "web", entrada: { texto: "um" } });
  const b = await iniciarTurno(m.deps, { canal: "web", entrada: { texto: "dois" } });
  assert.equal(m.loja.turnos.get(b.turnoId).status, "EM_ANDAMENTO", "o segundo já existe (a tela tem o id) e espera");
  await new Promise((ok) => setImmediate(ok));
  assert.equal(m.cliente.chamadas.length, 1, "o segundo não chamou o modelo enquanto o primeiro roda");
  soltar();
  const [ra, rb] = await Promise.all([a.resultado, b.resultado]);
  assert.deepEqual([ra.texto, rb.texto], ["Primeiro.", "Segundo."]);
  assert.equal(m.cliente.chamadas[1].corpo.messages.length, 3, "o segundo vê o turno inteiro do primeiro");
  conferirPrefixo(m.cliente.chamadas);
});

test("naFila: uma falha não trava a fila", async () => {
  const ordem = [];
  const a = naFila("teste-fila", async () => { ordem.push("a"); throw new Error("x"); });
  const b = naFila("teste-fila", async () => { ordem.push("b"); return "ok"; });
  await assert.rejects(a);
  assert.equal(await b, "ok");
  assert.deepEqual(ordem, ["a", "b"]);
});

test("status de turno: todo status final do motor é um de STATUS_TURNO", async () => {
  const m = montar({ roteiro: [{ content: [texto("x")] }] });
  const r = await m.falar("oi");
  assert.ok(STATUS_TURNO.includes(r.status));
  await assert.rejects(() => rodarTurno(m.deps, { canal: "mcp", entrada: { texto: "x" } }), TypeError);
  await assert.rejects(() => rodarTurno(m.deps, { canal: "web", entrada: { texto: "   " } }), TypeError);
});
