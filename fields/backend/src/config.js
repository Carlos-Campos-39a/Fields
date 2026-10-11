// Configuração lida do ambiente e validada no boot. Falha cedo, com a lista dos NOMES que faltam —
// nunca imprime valor.

import { lerHashSenha } from "./auth/sessao.js";
import { ORFAO_APOS_MIN } from "./servicos/turnos.js";

export class ErroConfig extends Error {
  constructor(problemas) {
    const partes = [];
    if (problemas.faltando.length) partes.push(`faltando: ${problemas.faltando.join(", ")}`);
    if (problemas.curtas.length) partes.push(`curtas demais (mínimo 32 caracteres): ${problemas.curtas.join(", ")}`);
    if (problemas.invalidas.length) partes.push(`formato inválido: ${problemas.invalidas.join(", ")}`);
    super(`Configuração inválida — ${partes.join("; ")}. Veja fields/backend/.env.example.`);
    this.name = "ErroConfig";
    this.problemas = problemas;
  }
}

const OBRIGATORIAS = ["DATABASE_URL", "FIELDS_SENHA_HASH", "FIELDS_SEGREDO_SESSAO", "FIELDS_API_TOKEN"];
const MINIMO_32 = ["FIELDS_SEGREDO_SESSAO", "FIELDS_API_TOKEN"];

/** "scrypt$<N>$<r>$<p>$<sal base64>$<hash base64>" (scripts/hash-senha.mjs). */
export function formatoHashValido(valor) {
  return lerHashSenha(valor) !== null; // a MESMA leitura que o login usa
}

// ─── A2b · o motor do agente ───
//
// As mesmas grafias de flag da ontologia (AGENTE_SOMENTE_LEITURA): "true", "1", "sim", "on".
const FLAG_LIGADA = new Set(["1", "true", "sim", "on"]);
export const flagLigada = (valor) => FLAG_LIGADA.has(String(valor ?? "").trim().toLowerCase());

/** Os níveis de `output_config.effort` que o Opus 5.5 aceita. */
export const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

// Os padrões ficam aqui, num lugar só: o .env.example os documenta, e o teste de config os cobra.
//   - effort POR CANAL e fixo dentro da sessão: trocar o effort entre chamadas invalida o cache das
//     mensagens. No WhatsApp, `low` (latência); na tela, `medium` (o padrão do modelo, explícito).
//   - orçamento: a tela espera por consulta periódica (60 s); o POST da Les Chats tem 120 s, e os
//     100 s deixam folga para a resposta voltar antes do corte dela.
export const PADROES_AGENTE = Object.freeze({
  AGENTE_MODELO: "claude-opus-5-5",
  AGENTE_EFFORT_WEB: "medium",
  AGENTE_EFFORT_WHATSAPP: "low",
  AGENTE_ORCAMENTO_WEB_S: 60,
  AGENTE_ORCAMENTO_WHATSAPP_S: 100,
  AGENTE_MAX_CHAMADAS: 6,
  SESSAO_OCIOSA_HORAS: 6,
});

/**
 * O maior orçamento de turno aceito, em segundos. A varredura de órfãos (servicos/turnos.js) fecha
 * como FALHOU/REINICIO todo EM_ANDAMENTO com mais de ORFAO_APOS_MIN minutos — a cada minuto, não só
 * no boot. Um turno vivo precisa terminar antes disso, com um minuto de folga para a ferramenta que
 * começou no limite do prazo e para o fechamento; um orçamento maior faria a varredura matar turno
 * vivo (e o fim dele chegaria tarde, como AGENTE_TURNO_JA_FECHADO).
 */
export const ORCAMENTO_MAX_S = ORFAO_APOS_MIN * 60 - 60;

function numeroPositivo(env, nome, problemas, { inteiro = false, maximo = Infinity, porQue = "" } = {}) {
  const cru = env[nome];
  if (cru === undefined || String(cru).trim() === "") return PADROES_AGENTE[nome];
  const n = Number(cru);
  if (!Number.isFinite(n) || n <= 0 || (inteiro && !Number.isInteger(n))) {
    problemas.invalidas.push(`${nome} (${inteiro ? "inteiro" : "número"} maior que zero)`);
    return PADROES_AGENTE[nome];
  }
  if (n > maximo) {
    problemas.invalidas.push(`${nome} (no máximo ${maximo}${porQue ? `: ${porQue}` : ""})`);
    return PADROES_AGENTE[nome];
  }
  return n;
}

const ORCAMENTO = { maximo: ORCAMENTO_MAX_S, porQue: "acima disso a recuperação de órfãos fecharia um turno vivo" };

function effortDe(env, nome, problemas) {
  const cru = String(env[nome] ?? "").trim();
  if (!cru) return PADROES_AGENTE[nome];
  if (!EFFORTS.includes(cru)) {
    problemas.invalidas.push(`${nome} (use ${EFFORTS.join(", ")})`);
    return PADROES_AGENTE[nome];
  }
  return cru;
}

/**
 * A parte do agente. Só pesa quando AGENTE_HABILITADO está ligado: sem ela o servidor sobe como
 * antes, e POST /api/agente/chat responde 503 AGENTE_DESLIGADO (a tela cai em "Salvar como nota").
 *
 * AGENTE_MODELO_FALSO=1 troca a API da Anthropic por um modelo de roteiro (agente/cliente.js), para
 * ver a tela e o WhatsApp funcionando sem chave. É RECUSADO com NODE_ENV=production: um deploy que
 * herdasse a flag responderia "eco: …" ao Carlos em vez de agir — erro que só se vê usando.
 */
function configDoAgente(env, problemas) {
  const habilitado = flagLigada(env.AGENTE_HABILITADO);
  const modeloFalso = flagLigada(env.AGENTE_MODELO_FALSO);
  if (modeloFalso && String(env.NODE_ENV ?? "").trim() === "production") {
    problemas.invalidas.push("AGENTE_MODELO_FALSO (proibido com NODE_ENV=production)");
  }
  // A chave só é obrigatória quando alguém vai usá-la: o agente ligado com o modelo de verdade.
  if (habilitado && !modeloFalso && !env.ANTHROPIC_API_KEY) problemas.faltando.push("ANTHROPIC_API_KEY");
  const modelo = String(env.AGENTE_MODELO ?? "").trim() || PADROES_AGENTE.AGENTE_MODELO;
  return Object.freeze({
    habilitado,
    modeloFalso,
    apiKey: env.ANTHROPIC_API_KEY || null,
    modelo,
    effort: Object.freeze({
      web: effortDe(env, "AGENTE_EFFORT_WEB", problemas),
      whatsapp: effortDe(env, "AGENTE_EFFORT_WHATSAPP", problemas),
    }),
    orcamentoMs: Object.freeze({
      web: numeroPositivo(env, "AGENTE_ORCAMENTO_WEB_S", problemas, ORCAMENTO) * 1000,
      whatsapp: numeroPositivo(env, "AGENTE_ORCAMENTO_WHATSAPP_S", problemas, ORCAMENTO) * 1000,
    }),
    maxChamadas: numeroPositivo(env, "AGENTE_MAX_CHAMADAS", problemas, { inteiro: true }),
    sessaoOciosaHoras: numeroPositivo(env, "SESSAO_OCIOSA_HORAS", problemas),
  });
}

export function carregarConfig(env = process.env) {
  const problemas = { faltando: [], curtas: [], invalidas: [] };
  for (const nome of OBRIGATORIAS) if (!env[nome]) problemas.faltando.push(nome);
  for (const nome of MINIMO_32) if (env[nome] && env[nome].length < 32) problemas.curtas.push(nome);
  if (env.FIELDS_SENHA_HASH && !formatoHashValido(env.FIELDS_SENHA_HASH)) {
    problemas.invalidas.push("FIELDS_SENHA_HASH (gere com: node scripts/hash-senha.mjs)");
  }
  const agente = configDoAgente(env, problemas);
  if (problemas.faltando.length || problemas.curtas.length || problemas.invalidas.length) {
    throw new ErroConfig(problemas);
  }

  return Object.freeze({
    porta: Number(env.PORT) || 3001,
    databaseUrl: env.DATABASE_URL,
    // "false" desliga o SSL (Postgres local). O padrão é o de sempre: SSL sem verificar o
    // certificado, que é o que o Postgres do Railway aceita.
    databaseSsl: env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    senhaHash: env.FIELDS_SENHA_HASH,
    segredoSessao: env.FIELDS_SEGREDO_SESSAO,
    apiToken: env.FIELDS_API_TOKEN,
    agente,
  });
}
