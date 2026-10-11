#!/usr/bin/env node
// Faz o papel da Les Chats: monta o envelope do contrato (§3.3), assina como ela assina (§4) e faz o
// POST no webhook do Fields — para testar a A3 antes de a Les Chats ter o Bot kind=EXTERNAL.
//
//   node --env-file=.env scripts/simular-leschats.mjs --texto "quais tarefas vencem hoje?"
//   node --env-file=.env scripts/simular-leschats.mjs --texto "cria a tarefa X" --wamid wamid.teste-1
//   node --env-file=.env scripts/simular-leschats.mjs --texto "cria a tarefa X" --wamid wamid.teste-1 --tentativa 2
//   node --env-file=.env scripts/simular-leschats.mjs --texto desfazer
//   node --env-file=.env scripts/simular-leschats.mjs --audio "me lembra de ligar para o banco amanhã"
//   node --env-file=.env scripts/simular-leschats.mjs --audio-erro
//   node --env-file=.env scripts/simular-leschats.mjs --imagem "anota isso na frente de dados"
//   node --env-file=.env scripts/simular-leschats.mjs --antes "cria a tarefa ligar pro banco" --texto "pra amanhã"
//   node --env-file=.env scripts/simular-leschats.mjs --texto oi --wa-id 5521988887777     # → {}
//   node --env-file=.env scripts/simular-leschats.mjs --texto oi --janela-fechada         # → template/handoff
//   node --env-file=.env scripts/simular-leschats.mjs --texto oi --desvio=-400           # → 403 (fora da janela)
//
// O SEGREDO vem só de LESCHATS_SEGREDO no ambiente (o .env local) — nunca por argumento, que fica no
// histórico do shell. Ele não é impresso. O wa_id padrão é FIELDS_DONO_WA_ID (o do Carlos).
//
// ATENÇÃO: contra um backend com o agente ligado, isto roda um turno DE VERDADE — e, com a chave da
// Anthropic, gasta tokens e escreve no banco daquele ambiente. Para testar sem chave, suba o backend
// com AGENTE_MODELO_FALSO=1 ("/op NomeDaOperacao {json}" chama uma operação; o resto volta como eco).

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assinar } from "../src/integracoes/leschats.js";

const AJUDA = `
Uso: node --env-file=.env scripts/simular-leschats.mjs [opções]

  --texto <msg>         mensagem de texto (padrão: a do §3.3 do contrato)
  --audio <transcrição> áudio já transcrito pela Les Chats (message.transcription.text)
  --audio-erro          áudio cuja transcrição falhou (message.transcription_error)
  --imagem [legenda]    imagem, com a legenda dada (sem legenda: --imagem "")
  --antes <msg>         uma mensagem ANTERIOR da rajada, só no history, sem POST próprio (repita,
                        em ordem: --antes "cria a tarefa ligar pro banco" --texto "pra amanhã")
  --wamid <id>          o event_id (o wamid); repita o mesmo para testar a idempotência
  --wa-id <dígitos>     quem manda (padrão: FIELDS_DONO_WA_ID)
  --janela-fechada      window.open=false (a janela de 24 h fechada)
  --tentativa <n>       attempt e X-LesChats-Delivery (padrão 1)
  --evento <nome>       o "event" do envelope (padrão message.received)
  --desvio=<s>          soma segundos ao timestamp assinado (negativo: --desvio=-400)
  --url <url>           padrão: http://localhost:$PORT/api/agente/whatsapp (PORT padrão 3001)
  --mostrar             imprime o envelope antes de mandar
`;

let opcoes;
try {
  ({ values: opcoes } = parseArgs({
    options: {
      texto: { type: "string" },
      audio: { type: "string" },
      "audio-erro": { type: "boolean" },
      imagem: { type: "string" },
      antes: { type: "string", multiple: true },
      wamid: { type: "string" },
      "wa-id": { type: "string" },
      "janela-fechada": { type: "boolean" },
      tentativa: { type: "string", default: "1" },
      evento: { type: "string", default: "message.received" },
      desvio: { type: "string", default: "0" },
      url: { type: "string" },
      mostrar: { type: "boolean" },
      ajuda: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  }));
} catch (err) {
  console.error(`${err.message}\n${AJUDA}`);
  process.exit(2);
}
if (opcoes.ajuda) { console.log(AJUDA); process.exit(0); }

const segredo = process.env.LESCHATS_SEGREDO;
if (!segredo) {
  console.error("LESCHATS_SEGREDO não está no ambiente. Rode com: node --env-file=.env scripts/simular-leschats.mjs …");
  process.exit(2);
}
const tentativa = Number(opcoes.tentativa);
const desvio = Number(opcoes.desvio);
if (!Number.isInteger(tentativa) || tentativa < 1 || !Number.isInteger(desvio)) {
  console.error("--tentativa e --desvio são inteiros (tentativa ≥ 1).");
  process.exit(2);
}
const url = opcoes.url ?? `http://localhost:${process.env.PORT || 3001}/api/agente/whatsapp`;

// ── O envelope: o §3.3 do contrato, com o que a linha de comando pediu ─────────
const base = JSON.parse(readFileSync(new URL("../test/fixtures/leschats/mensagem-texto.json", import.meta.url), "utf8"));
const agora = new Date();
const wamid = opcoes.wamid ?? `wamid.SIMULADO${randomBytes(12).toString("hex").toUpperCase()}`;
const waId = opcoes["wa-id"] ?? process.env.FIELDS_DONO_WA_ID ?? base.contact.wa_id;
const envelope = {
  ...base,
  event: opcoes.evento,
  event_id: wamid,
  sent_at: agora.toISOString(),
  attempt: tentativa,
  contact: { ...base.contact, wa_id: waId, phone_e164: `+${waId}` },
  window: opcoes["janela-fechada"]
    ? { ...base.window, open: false, requires_template: true, seconds_remaining: 0 }
    : { ...base.window, expires_at: new Date(agora.getTime() + 86_400_000).toISOString(), seconds_remaining: 86_400 },
  message: { ...base.message, external_id: wamid, created_at: agora.toISOString() },
  // O `history` (§3.2): o Fields lê as mensagens do cliente no FIM dele — a rajada (§6.2), que não
  // teve POST próprio. Por padrão vazio; com --antes, as mensagens dadas, segundos antes desta.
  history: (opcoes.antes ?? []).map((textoAnterior, i, todas) => ({
    ...base.history[0], // a entrada CUSTOMER/TEXT do §3.3
    id: 9000 + i,
    text: textoAnterior,
    external_id: `wamid.SIMULADO${randomBytes(12).toString("hex").toUpperCase()}`,
    created_at: new Date(agora.getTime() - (todas.length - i) * 2000).toISOString(),
  })),
};
const m = envelope.message;
if (opcoes.audio !== undefined || opcoes["audio-erro"]) {
  Object.assign(m, { type: "AUDIO", text: null, caption: null, media_mime: "audio/ogg; codecs=opus", media_url: null });
  if (opcoes["audio-erro"]) Object.assign(m, { transcription: null, transcription_error: "simulado" });
  else Object.assign(m, { transcription: { text: opcoes.audio, provider: "simulado", model: "simulado", duration_ms: 0 }, transcription_error: null });
} else if (opcoes.imagem !== undefined) {
  Object.assign(m, { type: "IMAGE", text: null, caption: opcoes.imagem || null, media_mime: "image/jpeg", media_url: null });
} else if (opcoes.texto !== undefined) {
  m.text = opcoes.texto;
}

// Indentado, como o da Les Chats: a assinatura é sobre ESTES bytes, não sobre o objeto.
const corpo = Buffer.from(JSON.stringify(envelope, null, 2), "utf8");
const ts = String(Math.floor(Date.now() / 1000) + desvio);
if (opcoes.mostrar) console.log(corpo.toString("utf8"));

const inicio = Date.now();
let res;
try {
  res = await fetch(url, {
    method: "POST",
    redirect: "manual", // a Les Chats não segue redirect (§3.1): um 302 reenviaria o corpo assinado
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "LesChats/0.1 (simular-leschats)",
      "X-LesChats-Timestamp": ts,
      "X-LesChats-Signature": assinar(corpo, ts, segredo),
      "X-LesChats-Event-Id": wamid,
      "X-LesChats-Delivery": String(tentativa),
    },
    body: corpo,
    signal: AbortSignal.timeout(120_000), // o timeout da Les Chats (ajuste do plano §0)
  });
} catch (err) {
  console.error(`Falhou sem resposta HTTP (${err.name}): o backend está no ar em ${new URL(url).origin}?`);
  process.exit(1);
}
const texto = await res.text();
let saida = texto;
try { saida = texto ? JSON.stringify(JSON.parse(texto), null, 2) : "(sem corpo)"; } catch { /* não-JSON: como veio */ }
console.log(`${res.status} em ${Date.now() - inicio} ms · wamid ${wamid}`);
console.log(saida);
