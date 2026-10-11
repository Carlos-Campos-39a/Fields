// O contrato da Les Chats sem HTTP: a assinatura (§4), o envelope (§3) e as formas de resposta (§5) —
// mais o formato do texto (a porta do formato.py do CRM). O caminho HTTP inteiro, com o motor, está em
// whatsapp.test.js.
//
// A fixture mensagem-texto.json é o JSON do §3.3 do contrato, copiado byte a byte (indentado, com o
// `history`): é sobre ESSES bytes que a assinatura é conferida, e reserializar muda o espaçamento — o
// erro clássico do §4.2. As de áudio são o §3.3 com o ajuste do plano §0 (transcrição feita pela Les
// Chats antes do POST, em message.transcription / message.transcription_error) e `history: []`. A
// mensagem-rajada.json é o §3.3 com o `history` terminando em DUAS mensagens do cliente sem resposta
// — a rajada do §6.2, em que só a última faz o POST.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  EVENTO_MENSAGEM, MOTIVOS_HANDOFF, PREFIXO_ASSINATURA, TOLERANCIA_S, assinar, difereSoNoNonoDigito, formaCanonicaWaId,
  formaDe, mesmoWaId, montarResposta, normalizarEnvelope, respostaHandoff, verificarAssinatura, verificarCabecalhos,
} from "../src/integracoes/leschats.js";
import { TEXTO_MAX_WHATSAPP, formatarResposta, limitarTexto, paraWhatsapp } from "../src/integracoes/formato.js";

const SEGREDO = "segredo-hmac-de-teste-0123456789abcdefgh";
const fixture = (nome) => readFileSync(new URL(`./fixtures/leschats/${nome}`, import.meta.url));
const TEXTO = fixture("mensagem-texto.json");
const AGORA_MS = Date.UTC(2026, 9, 3, 14, 22, 8);
const TS = String(Math.floor(AGORA_MS / 1000));

// ─── Assinatura (§4) ───

test("assinar = 'sha256=' + hex(HMAC-SHA256(segredo, ts + '.' + bytes)) — o cálculo do contrato", () => {
  const esperado = createHmac("sha256", SEGREDO).update(`${TS}.`).update(TEXTO).digest("hex");
  const sig = assinar(TEXTO, TS, SEGREDO);
  assert.equal(sig, `sha256=${esperado}`);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/, "hex minúsculo, 64 caracteres");
  assert.equal(assinar(TEXTO.toString("utf8"), TS, SEGREDO), sig, "string e Buffer dão o mesmo");
});

test("matriz do HMAC: válido passa; corpo alterado, ts fora, tamanho diferente, sem prefixo, corpo vazio e sem cabeçalho são recusados — sem lançar", () => {
  const sig = assinar(TEXTO, TS, SEGREDO);
  const v = (corpo, ts, s, segredo = SEGREDO) => verificarAssinatura(corpo, ts, s, segredo, { agoraMs: AGORA_MS });

  assert.deepEqual(v(TEXTO, TS, sig), { ok: true });

  const alterado = Buffer.from(TEXTO);
  alterado[alterado.indexOf("quais")] = "Q".charCodeAt(0);
  assert.deepEqual(v(alterado, TS, sig), { ok: false, motivo: "ASSINATURA" }, "um byte do corpo");
  assert.deepEqual(v(TEXTO, TS, sig, `${SEGREDO}x`), { ok: false, motivo: "ASSINATURA" }, "outro segredo");
  // O erro clássico do §4.2: o objeto reserializado não é o corpo que foi assinado.
  const reserializado = Buffer.from(JSON.stringify(JSON.parse(TEXTO.toString("utf8"))));
  assert.deepEqual(v(reserializado, TS, sig), { ok: false, motivo: "ASSINATURA" }, "JSON.stringify(JSON.parse(corpo))");

  // A janela de 300 s, nos dois sentidos, com a fronteira incluída.
  const ts = (desvio) => String(Number(TS) + desvio);
  assert.deepEqual(v(TEXTO, ts(-TOLERANCIA_S), assinar(TEXTO, ts(-TOLERANCIA_S), SEGREDO)), { ok: true }, "300 s ainda vale");
  assert.deepEqual(v(TEXTO, ts(-301), assinar(TEXTO, ts(-301), SEGREDO)), { ok: false, motivo: "FORA_DA_JANELA", desvio_s: 301 });
  assert.deepEqual(v(TEXTO, ts(301), assinar(TEXTO, ts(301), SEGREDO)), { ok: false, motivo: "FORA_DA_JANELA", desvio_s: -301 });
  assert.deepEqual(v(TEXTO, ts(-3600), sig), { ok: false, motivo: "FORA_DA_JANELA", desvio_s: 3600 }, "replay de uma hora atrás");
  for (const ruim of ["1790000000.5", "abc", "-1", "1e9", " "]) assert.equal(v(TEXTO, ruim, sig).motivo, "TIMESTAMP_INVALIDO", ruim);

  // Tamanho diferente: o timingSafeEqual LANÇA com tamanhos distintos — a guarda vem antes.
  for (const curta of [`${PREFIXO_ASSINATURA}abc`, `${sig}00`, `${PREFIXO_ASSINATURA}${"é".repeat(64)}`]) {
    assert.doesNotThrow(() => v(TEXTO, TS, curta));
    assert.deepEqual(v(TEXTO, TS, curta), { ok: false, motivo: "TAMANHO" }, curta.slice(0, 20));
  }
  assert.deepEqual(v(TEXTO, TS, sig.slice(PREFIXO_ASSINATURA.length)), { ok: false, motivo: "SEM_PREFIXO" }, "o hex sem 'sha256='");
  assert.deepEqual(v(TEXTO, TS, sig.replace("sha256=", "SHA256=")), { ok: false, motivo: "SEM_PREFIXO" });

  assert.deepEqual(v(Buffer.alloc(0), TS, assinar(Buffer.alloc(0), TS, SEGREDO)), { ok: false, motivo: "CORPO_VAZIO" }, "corpo vazio nunca valida");
  assert.deepEqual(v({}, TS, sig), { ok: false, motivo: "CORPO_VAZIO" }, "o {} que o express.raw deixa sem corpo");
  assert.deepEqual(v(TEXTO, undefined, sig), { ok: false, motivo: "SEM_CABECALHO" });
  assert.deepEqual(v(TEXTO, TS, undefined), { ok: false, motivo: "SEM_CABECALHO" });
  assert.deepEqual(v(TEXTO, TS, sig, ""), { ok: false, motivo: "SEM_SEGREDO" }, "sem segredo, nada passa");
});

test("verificarCabecalhos (antes de ler o corpo): a forma da assinatura e a janela de 300 s — sem segredo e sem corpo", () => {
  const sig = assinar(TEXTO, TS, SEGREDO);
  const c = (ts, s) => verificarCabecalhos(ts, s, { agoraMs: AGORA_MS });
  assert.deepEqual(c(TS, sig), { ok: true });
  assert.deepEqual(c(TS, `${PREFIXO_ASSINATURA}${"0".repeat(64)}`), { ok: true }, "a forma passa; quem decide é o HMAC, depois");
  assert.deepEqual(c(undefined, sig), { ok: false, motivo: "SEM_CABECALHO" });
  assert.deepEqual(c(TS, ""), { ok: false, motivo: "SEM_CABECALHO" });
  assert.deepEqual(c(TS, sig.slice(PREFIXO_ASSINATURA.length)), { ok: false, motivo: "SEM_PREFIXO" });
  assert.deepEqual(c("abc", sig), { ok: false, motivo: "TIMESTAMP_INVALIDO" });
  assert.deepEqual(c(String(Number(TS) - 301), sig), { ok: false, motivo: "FORA_DA_JANELA", desvio_s: 301 });
  assert.deepEqual(c(String(Number(TS) + TOLERANCIA_S), sig), { ok: true }, "a fronteira vale");
  for (const ruim of [`${PREFIXO_ASSINATURA}abc`, `${sig}00`, `${PREFIXO_ASSINATURA}${"é".repeat(64)}`]) {
    assert.deepEqual(c(TS, ruim), { ok: false, motivo: "TAMANHO" }, ruim.slice(0, 12));
  }
  assert.deepEqual(c(TS, sig.toUpperCase().replace("SHA256=", PREFIXO_ASSINATURA)), { ok: false, motivo: "FORMATO" }, "hex maiúsculo nunca bateria");
});

// ─── O wa_id e o nono dígito ───

test("mesmoWaId: 5511999998888 e 551199998888 são a mesma linha (o nono dígito); número diferente, fixo e lixo, não", () => {
  assert.equal(mesmoWaId("5511999998888", "551199998888"), true);
  assert.equal(mesmoWaId("551199998888", "5511999998888"), true, "nos dois sentidos");
  assert.equal(mesmoWaId("5511999998888", "5511999998888"), true);
  assert.equal(mesmoWaId("551199998888", "551199998888"), true);
  assert.equal(mesmoWaId(" 5511999998888 ", "5511999998888"), true, "espaço em volta não importa");
  assert.equal(formaCanonicaWaId("551199998888"), "5511999998888");
  assert.equal(formaCanonicaWaId("5511999998888"), "5511999998888");

  // Não alarga a allowlist: outro número, outro DDD, o fixo (número local de 2 a 5 não ganha o 9) e
  // qualquer coisa que não seja só dígitos.
  assert.equal(mesmoWaId("5511999998888", "5511999998887"), false);
  assert.equal(mesmoWaId("5511999998888", "552199998888"), false, "outro DDD");
  assert.equal(mesmoWaId("551133334444", "5511933334444"), false, "fixo não tem nono dígito");
  assert.equal(formaCanonicaWaId("551133334444"), "551133334444");
  assert.equal(mesmoWaId("441199998888", "4411999998888"), false, "só o Brasil (55)");
  for (const lixo of [null, undefined, "", "+5511999998888", "55 11 99999-8888"]) {
    assert.equal(mesmoWaId(lixo, "5511999998888"), false, String(lixo));
  }
  assert.equal(mesmoWaId(null, null), false, "dois vazios não são o mesmo número");
});

test("difereSoNoNonoDigito: o diagnóstico sem PII para o log da recusa", () => {
  assert.equal(difereSoNoNonoDigito("551133334444", "5511933334444"), true, "o caso que a forma canônica não iguala");
  assert.equal(difereSoNoNonoDigito("5511999998888", "551199998888"), true);
  assert.equal(difereSoNoNonoDigito("5511999998888", "5521988887777"), false);
  assert.equal(difereSoNoNonoDigito("5511999998888", "5511999998888"), false, "iguais não diferem");
  assert.equal(difereSoNoNonoDigito("5511899998888", "551199998888"), false, "o dígito a mais não é um 9");
  assert.equal(difereSoNoNonoDigito("5511999998888", null), false);
});

// ─── Envelope (§3) ───

test("normalizarEnvelope: o §3.3 exato → só o que o Fields usa; o `history` termina na resposta do bot, então não há rajada", () => {
  const r = normalizarEnvelope(JSON.parse(TEXTO.toString("utf8")));
  assert.equal(r.ok, true);
  assert.deepEqual(r.envelope, {
    eventId: "wamid.HBgNNTUxMTk5OTk5ODg4OBUCABIYFjNFQjBEMkIzQkM5RkYxQTkxQzcA",
    attempt: 1, botId: 3, channelId: 1, conversationId: 42, waId: "5511999998888", janelaAberta: true,
    tipo: "TEXT", texto: "quais tasks da frente de dados vencem essa semana?", legenda: null,
    transcricao: null, transcricaoFalhou: false,
    criadoEm: "2026-10-03T14:22:05+00:00", enviadoEm: "2026-10-03T14:22:07.431290+00:00", anteriores: [],
  });
});

test("normalizarEnvelope: a rajada (§6.2) — as CUSTOMER do fim do `history`, depois da última que não é, em ordem", () => {
  const rajada = JSON.parse(fixture("mensagem-rajada.json").toString("utf8"));
  const r = normalizarEnvelope(rajada);
  assert.equal(r.envelope.texto, "pra amanhã");
  assert.deepEqual(r.envelope.anteriores, [
    {
      externalId: "wamid.HBgNNTUxMTk5OTk5ODg4OBUCABIYFjNFQjBEMkIzQkM5RkYxQTkxQzYA", tipo: "TEXT",
      texto: "cria a tarefa ligar pro banco", legenda: null, transcricao: null, criadoEm: "2026-10-03T14:21:58+00:00",
    },
    {
      externalId: "wamid.HBgNNTUxMTk5OTk5ODg4OBUCABIYFjNFQjBEMkIzQkM5RkYxQTkxQzgA", tipo: "TEXT",
      texto: "na frente Casa", legenda: null, transcricao: null, criadoEm: "2026-10-03T14:22:01+00:00",
    },
  ], "o 'bom dia' das 9h ficou antes da resposta do bot: já foi atendido");

  const com = (mudar) => { const o = JSON.parse(JSON.stringify(rajada)); mudar(o); return normalizarEnvelope(o); };
  // Uma resposta de atendente (ou nota) no meio corta a rajada nela.
  const atendente = com((o) => { o.history[2].sender_type = "USER"; });
  assert.deepEqual(atendente.envelope.anteriores.map((a) => a.texto), ["na frente Casa"]);
  // Uma entrada ilegível é fronteira: sem saber quem a mandou, não se afirma que o antes ficou sem resposta.
  const torta = com((o) => { o.history[2] = "isto não é uma mensagem"; });
  assert.deepEqual(torta.envelope.anteriores.map((a) => a.texto), ["na frente Casa"]);
  // Áudio e anexo: a transcrição e a legenda; o resto dos campos torto cai para nulo.
  const midia = com((o) => {
    Object.assign(o.history[2], { type: "audio", text: null, transcription: { text: " me lembra do banco " } });
    Object.assign(o.history[3], { type: "IMAGE", text: null, caption: "o boleto", external_id: 7, created_at: 1 });
  });
  assert.deepEqual(midia.envelope.anteriores.map((a) => [a.tipo, a.texto, a.transcricao, a.legenda, a.externalId, a.criadoEm]), [
    ["AUDIO", null, "me lembra do banco", null, "wamid.HBgNNTUxMTk5OTk5ODg4OBUCABIYFjNFQjBEMkIzQkM5RkYxQTkxQzYA", "2026-10-03T14:21:58+00:00"],
    ["IMAGE", null, null, "o boleto", null, null],
  ]);
  // A própria mensagem da vez, repetida no `history`, não conta duas vezes.
  const repetida = com((o) => { o.history.push({ ...o.history[3], external_id: o.event_id }); });
  assert.equal(repetida.envelope.anteriores.length, 2);
  // `history` ausente, vazio, nulo ou torto: sem rajada, e o envelope continua válido.
  for (const h of [undefined, [], null, "x", { a: 1 }]) {
    const sem = com((o) => { if (h === undefined) delete o.history; else o.history = h; });
    assert.deepEqual([sem.ok, sem.envelope.anteriores], [true, []], JSON.stringify(h));
  }
  // Tudo CUSTOMER (nenhuma resposta ainda): o `history` inteiro é rajada — a rota é que corta pela idade.
  const tudo = com((o) => { o.history.splice(1, 1); });
  assert.deepEqual(tudo.envelope.anteriores.map((a) => a.texto), ["bom dia", "cria a tarefa ligar pro banco", "na frente Casa"]);
});

test("normalizarEnvelope: áudio com transcrição (ajuste do §0) e áudio com transcription_error", () => {
  const ok = normalizarEnvelope(JSON.parse(fixture("mensagem-audio-transcrito.json").toString("utf8")));
  assert.deepEqual([ok.envelope.tipo, ok.envelope.texto, ok.envelope.transcricao, ok.envelope.transcricaoFalhou],
    ["AUDIO", null, "me lembra de ligar para o banco amanhã às dez", false]);
  const erro = normalizarEnvelope(JSON.parse(fixture("mensagem-audio-erro.json").toString("utf8")));
  assert.deepEqual([erro.envelope.tipo, erro.envelope.transcricao, erro.envelope.transcricaoFalhou], ["AUDIO", null, true]);
  // A forma do erro não está fixada no contrato: objeto também conta.
  const obj = JSON.parse(fixture("mensagem-audio-erro.json").toString("utf8"));
  obj.message.transcription_error = { code: "TIMEOUT" };
  assert.equal(normalizarEnvelope(obj).envelope.transcricaoFalhou, true);
});

test("normalizarEnvelope: a janela fecha com open=false OU requires_template=true; sem o objeto, aberta", () => {
  const base = () => JSON.parse(TEXTO.toString("utf8"));
  const com = (window) => { const o = base(); o.window = window; return normalizarEnvelope(o).envelope.janelaAberta; };
  assert.equal(com({ open: false, requires_template: true }), false);
  assert.equal(com({ open: false }), false);
  assert.equal(com({ open: true, requires_template: true }), false, "texto livre nasceria DRAFT");
  assert.equal(com(null), true);
  const sem = base(); delete sem.window;
  assert.equal(normalizarEnvelope(sem).envelope.janelaAberta, true);
});

test("normalizarEnvelope: campos novos são aceitos; o que falta ou vem torto volta com os NOMES dos campos", () => {
  const o = JSON.parse(TEXTO.toString("utf8"));
  o.campo_do_futuro = { x: 1 };
  o.message.outra_coisa = "y";
  delete o.bot_id; delete o.channel_id;
  const r = normalizarEnvelope(o);
  assert.equal(r.ok, true);
  assert.deepEqual([r.envelope.botId, r.envelope.channelId, r.envelope.conversationId], [null, null, 42]);

  // O que não é essencial e vem torto cai para o padrão — não vira handoff.
  const torto = JSON.parse(TEXTO.toString("utf8"));
  Object.assign(torto, { attempt: "2", conversation_id: "42", window: "aberta" });
  torto.message.caption = 7;
  const t = normalizarEnvelope(torto);
  assert.equal(t.ok, true);
  assert.deepEqual([t.envelope.attempt, t.envelope.conversationId, t.envelope.janelaAberta, t.envelope.legenda], [1, null, true, null]);

  const ruim = JSON.parse(TEXTO.toString("utf8"));
  delete ruim.event_id;
  ruim.contact.wa_id = 5511999998888;
  delete ruim.message.type;
  const recusa = normalizarEnvelope(ruim);
  assert.deepEqual([recusa.ok, recusa.motivo], [false, "ENVELOPE_INVALIDO"]);
  assert.deepEqual(recusa.campos.sort(), ["contact.wa_id", "event_id", "message.type"]);
  assert.equal(normalizarEnvelope({ event: "outro" }).ok, false);
  assert.equal(EVENTO_MENSAGEM, "message.received");
});

// ─── Resposta (§5) ───

test("montarResposta: janela aberta → {text} no formato do WhatsApp; fechada → template configurado ou handoff OUTSIDE_WINDOW", () => {
  assert.deepEqual(montarResposta({ janelaAberta: true, texto: "Vencem **3**." }), { corpo: { text: "Vencem *3*." }, forma: "TEXT", cortado: false });
  assert.deepEqual(montarResposta({ janelaAberta: false, texto: "x", templateJanelaFechada: "hello_world" }),
    { corpo: { template: { name: "hello_world" } }, forma: "TEMPLATE", cortado: false });
  assert.deepEqual(montarResposta({ janelaAberta: false, texto: "x" }),
    { corpo: { handoff: { reason: "OUTSIDE_WINDOW" } }, forma: "HANDOFF", cortado: false });
  const longa = montarResposta({ janelaAberta: true, texto: "palavra ".repeat(1000) });
  assert.equal(longa.cortado, true);
  assert.ok(longa.corpo.text.length <= TEXTO_MAX_WHATSAPP);
});

test("respostaHandoff: só os reasons do contrato; formaDe reconhece as quatro formas", () => {
  assert.deepEqual(respostaHandoff("BOT_FAILURE", "nota"), { handoff: { reason: "BOT_FAILURE", note: "nota" } });
  assert.deepEqual(respostaHandoff("OUTSIDE_WINDOW"), { handoff: { reason: "OUTSIDE_WINDOW" } });
  assert.throws(() => respostaHandoff("QUALQUER"), /fora do contrato/);
  assert.deepEqual([...MOTIVOS_HANDOFF], ["BOT_TOOL", "KEYWORD", "NO_BOT", "BOT_FAILURE", "AGENT_PICKUP", "OUTSIDE_WINDOW"]);
  assert.deepEqual([formaDe({ text: "" }), formaDe({ template: { name: "a" } }), formaDe({ handoff: { reason: "BOT_FAILURE" } }), formaDe({})],
    ["TEXT", "TEMPLATE", "HANDOFF", "VAZIO"]);
});

// ─── Formato (porta do formato.py do CRM) ───

test("paraWhatsapp: **negrito** → *negrito*, título sem #, marcador → hífen, link legível, sem linhas em branco a mais", () => {
  assert.equal(paraWhatsapp("Vencem **3 tarefas**."), "Vencem *3 tarefas*.");
  assert.equal(paraWhatsapp("## Esta semana\n* #88 hoje\n+ #91 sexta\n- #94 sábado"), "Esta semana\n- #88 hoje\n- #91 sexta\n- #94 sábado");
  assert.equal(paraWhatsapp("Veja [o deck](https://exemplo.com/deck)."), "Veja o deck: https://exemplo.com/deck.");
  assert.equal(paraWhatsapp("um\n\n\n\ndois  \r\n\r\n\r\ntrês"), "um\n\ndois\n\ntrês");
  assert.equal(paraWhatsapp("  *negrito* já certo  "), "*negrito* já certo", "asterisco simples não vira marcador");
  // Diferenças deliberadas do Python: o título não engole a linha em branco antes dele, e "#88" no
  // começo da linha é número de tarefa, não título.
  assert.equal(paraWhatsapp("Antes.\n\n# Título\nDepois."), "Antes.\n\nTítulo\nDepois.");
  assert.equal(paraWhatsapp("#88 vence hoje\n#\nfim"), "#88 vence hoje\n\nfim");
  assert.equal(paraWhatsapp(null), "");
});

test("limitarTexto/formatarResposta: ≤ 4096 intocado; acima, corte na fronteira com '…'; emoji nunca partido; vazio vira '…'", () => {
  const exato = "a".repeat(TEXTO_MAX_WHATSAPP);
  assert.deepEqual(limitarTexto(exato), { texto: exato, cortado: false });

  const paragrafos = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
  const p = limitarTexto(paragrafos);
  assert.deepEqual([p.cortado, p.texto], [true, `${"a".repeat(3000)}…`], "corta no parágrafo");

  const palavras = "palavra ".repeat(600);
  const w = limitarTexto(palavras);
  assert.ok(w.texto.length <= TEXTO_MAX_WHATSAPP);
  assert.match(w.texto, /palavra…$/, "corta na palavra, não no meio dela");

  const corrido = "x".repeat(5000);
  assert.equal(limitarTexto(corrido).texto, `${"x".repeat(TEXTO_MAX_WHATSAPP - 1)}…`, "sem fronteira: corte seco");

  const emojis = `${"x".repeat(TEXTO_MAX_WHATSAPP - 2)}😀😀`;
  const e = limitarTexto(emojis).texto;
  assert.ok(e.length <= TEXTO_MAX_WHATSAPP);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(e), "nenhum substituto alto solto antes das reticências");

  assert.deepEqual(formatarResposta("   "), { texto: "…", cortado: false });
  assert.deepEqual(formatarResposta("**Feito.**"), { texto: "*Feito.*", cortado: false });
});
