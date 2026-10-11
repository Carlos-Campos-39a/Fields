// As sessões do motor sem banco (agente/sessoes.js e o formato público de servicos/turnos.js): a
// versão do prompt, a regra de renovação, o recap deterministico — e a varredura que garante que o
// histórico só cresce. O SQL contra Postgres real está em motor_integracao.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { LIMITES_SESSAO, MOTIVOS_SESSAO, RECAP_RECUSADO, motivoDeRenovacao, promptVersao, recapDeterministico } from "../src/agente/sessoes.js";
import { operacoesPara, systemPrompt } from "../src/agente/ontologia.js";
import { ferramentasClaude } from "../src/agente/catalogo.js";
import {
  ORFAO_APOS_MIN, ORFAO_VARREDURA_MS, TEXTO_FALHA, agendarRecuperacaoDeOrfaos, recuperarOrfaosSemFalhar, recuperarTurnosOrfaos, turnoPublico,
} from "../src/servicos/turnos.js";
import { definirSaida } from "../src/lib/log.js";
import { ORCAMENTO_MAX_S, PADROES_AGENTE } from "../src/config.js";

test("promptVersao = sha256(systemPrompt + JSON(ferramentasClaude)): estável, por canal, e muda com a ontologia", () => {
  const web = promptVersao("web");
  assert.equal(web, createHash("sha256").update(systemPrompt({ canal: "web" }) + JSON.stringify(ferramentasClaude())).digest("hex"));
  assert.equal(promptVersao("web"), web, "a mesma em toda chamada");
  assert.notEqual(promptVersao("whatsapp"), web, "cada canal tem o seu system");
  // A flag de rollout muda o prompt E as ferramentas: muda a versão (e a próxima mensagem abre sessão nova).
  assert.notEqual(promptVersao("web", { operacoes: operacoesPara({ somenteLeitura: true }) }), web);
});

const SESSAO = Object.freeze({
  prompt_versao: "v1", modelo: "claude-opus-5-5", n_mensagens: 10, ultimo_input_tokens: 5000,
  ultima_atividade_em: new Date("2026-10-10T12:00:00Z"),
});
const AGORA = new Date("2026-10-10T13:00:00Z");
const PEDIDO = { promptVersao: "v1", modelo: "claude-opus-5-5", agora: AGORA, ociosaHoras: 6 };

test("motivoDeRenovacao: null enquanto serve; cada teto com o seu motivo, na ordem de gravidade", () => {
  assert.equal(motivoDeRenovacao(SESSAO, PEDIDO), null);
  assert.equal(motivoDeRenovacao(SESSAO, { ...PEDIDO, promptVersao: "v2" }), "PROMPT_VERSAO");
  assert.equal(motivoDeRenovacao(SESSAO, { ...PEDIDO, modelo: "claude-opus-5" }), "MODELO");
  assert.equal(motivoDeRenovacao(SESSAO, { ...PEDIDO, agora: new Date("2026-10-10T18:00:00Z") }), null, "5 h parada ainda serve");
  assert.equal(motivoDeRenovacao(SESSAO, { ...PEDIDO, agora: new Date("2026-10-10T18:00:01Z") }), "PARADA");
  assert.equal(motivoDeRenovacao({ ...SESSAO, n_mensagens: LIMITES_SESSAO.mensagens - 1 }, PEDIDO), null);
  assert.equal(motivoDeRenovacao({ ...SESSAO, n_mensagens: LIMITES_SESSAO.mensagens }, PEDIDO), "MENSAGENS");
  assert.equal(motivoDeRenovacao({ ...SESSAO, ultimo_input_tokens: LIMITES_SESSAO.inputTokens }, PEDIDO), null);
  assert.equal(motivoDeRenovacao({ ...SESSAO, ultimo_input_tokens: LIMITES_SESSAO.inputTokens + 1 }, PEDIDO), "TOKENS");
  // Dois motivos ao mesmo tempo: vale o da versão do prompt (o único que QUEBRA a requisição).
  assert.equal(motivoDeRenovacao({ ...SESSAO, n_mensagens: 999 }, { ...PEDIDO, promptVersao: "v2" }), "PROMPT_VERSAO");
  assert.deepEqual(LIMITES_SESSAO, { mensagens: 150, inputTokens: 200_000 });
  assert.equal(PADROES_AGENTE.SESSAO_OCIOSA_HORAS, 6);
  for (const m of ["PROMPT_VERSAO", "MODELO", "PARADA", "MENSAGENS", "TOKENS", "RECUSA", "ERRO_HISTORICO", "PEDIDO"]) {
    assert.ok(MOTIVOS_SESSAO.includes(m), m);
  }
});

test("recapDeterministico: uma linha por turno, com o que foi feito (e desfeito) e como acabou; vazio sem turnos", () => {
  assert.equal(recapDeterministico([]), "");
  const turnos = [
    { status: "CONCLUIDO", entrada: "cria   a tarefa\nrevisar deck", resposta: "Criei a tarefa Revisar deck.", criado_em: new Date("2026-10-09T17:05:00Z"),
      acoes: [{ resumo: "Criou a tarefa “Revisar deck”", desfeito_em: "2026-10-09T17:06:00Z" }] },
    { status: "ESGOTADO", entrada: "x".repeat(300), resposta: null, criado_em: new Date("2026-10-10T12:00:00Z"), acoes: [] },
  ];
  const r = recapDeterministico(turnos);
  assert.equal(r, recapDeterministico(turnos), "o mesmo dado, o mesmo texto");
  const [cabeca, l1, l2, l3] = r.split("\n");
  assert.match(cabeca, /últimos turnos antes desta conversa/);
  assert.equal(l1, '- 09/10 14:05 · Carlos: "cria a tarefa revisar deck" → você: "Criei a tarefa Revisar deck."');
  assert.equal(l2, "  feito: Criou a tarefa “Revisar deck” (desfeita)");
  assert.match(l3, /^- 10\/10 09:00 · Carlos: "x{199}…" → você: ""  ?\(não terminou a tempo\)$/);
});

test("recapDeterministico: o turno RECUSADO entra sem o pedido e sem a resposta, mas com o que foi feito antes da recusa", () => {
  // A recusa encerra a sessão; o turno seguinte é o 1º da nova e leva este recap. Com o pedido aqui,
  // os classificadores veriam o mesmo texto de novo e recusariam também turnos sem relação.
  const r = recapDeterministico([
    { status: "RECUSADO", entrada: "texto-que-disparou-a-recusa", resposta: "O modelo recusou continuar este pedido. O que já fiz antes disso: Criou a tarefa “A”.",
      criado_em: new Date("2026-10-10T17:03:00Z"), acoes: [{ resumo: "Criou a tarefa “A”" }] },
    { status: "CONCLUIDO", entrada: "oi", resposta: "Oi.", criado_em: new Date("2026-10-10T17:04:00Z"), acoes: [] },
  ]);
  assert.ok(!r.includes("texto-que-disparou-a-recusa"));
  const [, l1, l2, l3] = r.split("\n");
  assert.equal(l1, `- 10/10 14:03 · ${RECAP_RECUSADO}`);
  assert.equal(l2, "  feito: Criou a tarefa “A”");
  assert.equal(l3, '- 10/10 14:04 · Carlos: "oi" → você: "Oi."');
  assert.ok(MOTIVOS_SESSAO.includes("ERRO_INTERNO"), "a sessão que o motor fecha depois de uma exceção com escrita");
});

test("turnoPublico: o contrato da tela — chaves fixas, ações só com o que o chip usa, datas em ISO", () => {
  const linha = {
    id: "t1", canal: "web", sessao_id: "s1", status: "CONCLUIDO", motivo: null, entrada: "oi", resposta: "Oi.",
    metricas: { n_tools: 2, input_tokens: 9 }, criado_em: new Date("2026-10-10T12:00:00Z"), concluido_em: new Date("2026-10-10T12:00:03Z"),
    acoes: [{ idx: 0, tool: "NovaTarefa", acao: "NOVA_TAREFA", entidade_tipo: "TAREFA", entidade_id: "x", historico_id: 7, inverso: "EXCLUIR", resumo: "Criou", desfazivel: true, desfeito_em: null }],
  };
  assert.deepEqual(turnoPublico(linha), {
    turno_id: "t1", status: "CONCLUIDO", motivo: null, texto: "Oi.", entrada: "oi",
    acoes: [{ idx: 0, acao: "NOVA_TAREFA", resumo: "Criou", desfazivel: true, desfeito_em: null }],
    progresso: { n_tools: 2 }, sessao_id: "s1", criado_em: "2026-10-10T12:00:00.000Z", concluido_em: "2026-10-10T12:00:03.000Z",
  });
  assert.deepEqual(turnoPublico({ ...linha, metricas: null, acoes: null, resposta: null, concluido_em: null }).progresso, { n_tools: 0 });
  assert.equal(TEXTO_FALHA, "Desculpe, não consegui processar agora.");
  assert.ok(ORFAO_APOS_MIN * 60 > PADROES_AGENTE.AGENTE_ORCAMENTO_WHATSAPP_S, "órfão só depois do maior orçamento padrão");
  assert.ok(ORFAO_APOS_MIN * 60 > PADROES_AGENTE.AGENTE_ORCAMENTO_WEB_S);
  // E depois do maior orçamento ACEITO (a config recusa acima dele), com folga para o fechamento.
  assert.ok(ORCAMENTO_MAX_S < ORFAO_APOS_MIN * 60 && ORCAMENTO_MAX_S >= PADROES_AGENTE.AGENTE_ORCAMENTO_WHATSAPP_S);
});

// ─── Varredura: o histórico só cresce ───
// Um UPDATE ou DELETE em agente_mensagens edita a conversa que o pensamento preservado amarrou: o
// 400 (ou o raciocínio descartado) só apareceria na mensagem seguinte, longe da causa.
test("nenhum código em src/ faz UPDATE ou DELETE em agente_mensagens", () => {
  const raiz = fileURLToPath(new URL("../src/", import.meta.url));
  const arquivos = [];
  const andar = (pasta) => {
    for (const nome of readdirSync(pasta)) {
      const caminho = `${pasta}/${nome}`;
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (nome.endsWith(".js")) arquivos.push(caminho);
    }
  };
  andar(raiz.replace(/[\\/]$/, ""));
  const violacoes = [];
  let insercoes = 0;
  for (const arquivo of arquivos) {
    const texto = readFileSync(arquivo, "utf8");
    if (/UPDATE\s+agente_mensagens|DELETE\s+FROM\s+agente_mensagens|TRUNCATE\s+agente_mensagens/i.test(texto)) violacoes.push(arquivo);
    insercoes += (texto.match(/INSERT INTO agente_mensagens/g) ?? []).length;
  }
  assert.deepEqual(violacoes, []);
  assert.equal(insercoes, 1, "um só caminho de escrita: sessoes.acrescentarMensagens");
});

// ─── A recuperação no boot (o SQL; a ligação no initDB e o efeito no banco: motor_integracao) ───
test("recuperarTurnosOrfaos: EM_ANDAMENTO mais velho que 5 min → FALHOU/REINICIO com o texto de falha, e o log conta", async () => {
  const chamadas = [];
  const db = { query: async (sql, params) => { chamadas.push({ sql, params }); return { rows: [{ id: "a" }, { id: "b" }], rowCount: 2 }; } };
  const linhas = [];
  definirSaida((_n, l) => linhas.push(JSON.parse(l)));
  let n;
  try { n = await recuperarTurnosOrfaos(db); } finally { definirSaida(null); }
  assert.equal(n, 2);
  const [{ sql, params }] = chamadas;
  assert.ok(sql.startsWith("UPDATE agente_turnos SET status = $1, motivo = 'REINICIO', resposta = COALESCE(resposta, $2), concluido_em = NOW()"), sql);
  assert.ok(sql.includes("WHERE status = $3 AND criado_em < NOW() - make_interval(mins => $4::int)"), sql);
  assert.ok(sql.includes("RETURNING id"));
  assert.deepEqual(params, ["FALHOU", TEXTO_FALHA, "EM_ANDAMENTO", ORFAO_APOS_MIN]);
  assert.equal(ORFAO_APOS_MIN, 5);
  const log = linhas.find((l) => l.evento === "AGENTE_TURNO_RECUPERADO");
  assert.deepEqual([log.nivel, log.turnos, log.motivo], ["warn", 2, "REINICIO"]);
});

// O órfão de uma queda tem menos de 5 min no boot seguinte, e o da instância velha num deploy também:
// só a passada do boot os deixaria EM_ANDAMENTO até o próximo deploy ("Trabalhando…" para sempre).
test("recuperação de órfãos também com o servidor no ar: a cada minuto, e uma falha só loga (com o momento)", async () => {
  assert.equal(ORFAO_VARREDURA_MS, 60_000);
  const linhas = [];
  definirSaida((_n, l) => linhas.push(JSON.parse(l)));
  let timer;
  try {
    const quebrado = { query: async () => { throw Object.assign(new Error("caiu"), { code: "57P01" }); } };
    assert.equal(await recuperarOrfaosSemFalhar(quebrado, { momento: "boot" }), 0, "não lança");
    const falhou = linhas.find((l) => l.evento === "AGENTE_RECUPERACAO_FALHOU");
    assert.deepEqual([falhou.nivel, falhou.momento, falhou.pg_codigo], ["erro", "boot", "57P01"]);

    let passadas = 0;
    const db = { query: async () => { passadas++; return { rows: [], rowCount: 0 }; } };
    timer = agendarRecuperacaoDeOrfaos(db, { intervaloMs: 5 });
    // Espera duas passadas (com teto): sob a carga da suíte inteira, um intervalo de 5 ms atrasa.
    for (const fim = Date.now() + 2_000; passadas < 2 && Date.now() < fim;) await new Promise((ok) => setTimeout(ok, 10));
    assert.ok(passadas >= 2, `rodou ${passadas} vez(es)`);
    assert.equal(timer.hasRef(), false, "o timer não segura o processo");
  } finally {
    clearInterval(timer);
    definirSaida(null);
  }
});
