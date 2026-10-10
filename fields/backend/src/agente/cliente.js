// O cliente do modelo — a ÚNICA porta do Fields para a API da Anthropic, e o único lugar que sabe a
// forma da requisição. O motor (motor.js) monta a conversa; daqui sai o corpo do POST /v1/messages e
// a chamada. Injetável: o teste passa um modelo de roteiro (test/fakes/modeloFalso.js), o dev pode
// ligar o de roteiro daqui (AGENTE_MODELO_FALSO), e só a produção fala com a API.
//
// ## A requisição (conferida na skill claude-api, para o claude-opus-5-5)
//
//   - `thinking: {type: "adaptive"}` — no Opus 5.5 o pensamento não desliga (`disabled` é 400); quem
//     dosa é o `output_config.effort`, POR CANAL e fixo dentro da sessão (trocar o effort entre
//     chamadas invalida o cache das mensagens).
//   - `block_binding.prefix_mismatch_behavior: "drop_block"` (beta thinking-binding-controls-2026-08-01):
//     se algum byte antigo do histórico mudar, a API descarta o raciocínio afetado em vez de recusar
//     o turno com 400 — e diz o que descartou em `input_transformations` (o motor loga
//     LLM_THINKING_DESCARTADO). O histórico só por INSERT (sessoes.js) é o que deve manter a lista
//     vazia; o drop_block é o cinto, o log é o alarme.
//   - `fallbacks: "default"` (beta server-side-fallback-2026-07-01): se os classificadores recusarem,
//     a API refaz a mesma chamada no modelo que a Anthropic recomenda para aquela categoria, dentro
//     da mesma requisição. O modelo de fallback não lê os blocos de pensamento do Opus 5.5 (a API os
//     descarta, sem cobrar). Recusa que sobra (stop_reason "refusal") o motor trata.
//   - `tool_choice: {type: "auto"}` — forçar ferramenta (`any`/`tool`) é 400 no Opus 5.5.
//   - cache: um breakpoint explícito no system (o prefixo caro: ferramentas + system, que nunca
//     mudam) + o automático no topo, que acompanha a ponta da conversa. Dois dos quatro permitidos,
//     os dois de 5 minutos.
//   - `max_tokens: 16000` sem streaming: cabe no limite do SDK para chamada não-streaming, e o
//     pensamento conta dentro dele.
//
// Prazo: o timeout de cada chamada é o que RESTA do turno, e um AbortSignal com o mesmo prazo corta
// também a retentativa (o SDK refaz timeout e 5xx; com maxRetries 1, o relógio do turno é o teto).

import Anthropic, { APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { systemPrompt } from "./ontologia.js";
import { ferramentasClaude } from "./catalogo.js";

export const MAX_TOKENS = 16000;
export const BETAS = Object.freeze(["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"]);

// System e ferramentas são congelados por processo (a flag de rollout é lida no import): montados
// uma vez por canal, e a MESMA string vai em toda chamada.
const SYSTEM_DO_CANAL = new Map();
function systemDoCanal(canal) {
  if (!SYSTEM_DO_CANAL.has(canal)) SYSTEM_DO_CANAL.set(canal, systemPrompt({ canal }));
  return SYSTEM_DO_CANAL.get(canal);
}

/**
 * O corpo do POST /v1/messages (beta). Puro: o teste do invariante de prefixo o compara chamada a
 * chamada — system e tools idênticos, e cada `messages` prefixo do seguinte.
 */
export function montarRequisicao({ canal, modelo, effort, messages }) {
  return {
    model: modelo,
    max_tokens: MAX_TOKENS,
    betas: [...BETAS],
    fallbacks: "default",
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort },
    system: [{ type: "text", text: systemDoCanal(canal), cache_control: { type: "ephemeral" } }],
    tools: ferramentasClaude(),
    tool_choice: { type: "auto" },
    cache_control: { type: "ephemeral" },
    messages,
  };
}

/**
 * O que deu errado numa chamada, em categorias que o motor sabe tratar — pelas classes do SDK, nunca
 * pelo texto da mensagem:
 *   PRAZO          — o prazo do turno acabou (timeout do SDK ou o AbortSignal);
 *   REQUISICAO_400 — a API recusou a requisição; com histórico, é o candidato a "histórico inválido";
 *   API            — outro status (429, 5xx, 401…);
 *   REDE           — sem resposta HTTP;
 *   INTERNO        — não veio do SDK.
 * `request_id` é o da Anthropic (seguro de logar; é por ele que o console acha a chamada).
 */
export function classificarErro(err) {
  if (err instanceof APIUserAbortError || err instanceof APIConnectionTimeoutError) return { tipo: "PRAZO" };
  if (err instanceof APIError) {
    if (typeof err.status !== "number") return { tipo: "REDE" };
    return {
      tipo: err.status === 400 ? "REQUISICAO_400" : "API",
      status: err.status,
      tipo_api: err.type ?? undefined,
      request_id: err.requestID ?? undefined,
    };
  }
  return { tipo: "INTERNO" };
}

/**
 * O cliente de verdade. `criar(corpo, {timeoutMs})` → a mensagem da API, como veio (o motor a guarda
 * byte a byte). `fetch` é a costura do teste que confere o POST que o SDK monta.
 */
function clienteAnthropic({ apiKey, modelo, fetch }) {
  const sdk = new Anthropic({ apiKey, maxRetries: 1, ...(fetch ? { fetch } : {}) });
  return {
    modelo,
    async criar(corpo, { timeoutMs }) {
      const prazo = Math.max(1, Math.floor(timeoutMs));
      return sdk.beta.messages.create(corpo, { timeout: prazo, maxRetries: 1, signal: AbortSignal.timeout(prazo) });
    },
  };
}

// ── O modelo de roteiro do dev (AGENTE_MODELO_FALSO=1) ────────────────────────
//
// Para ver a Home (R3) e o WhatsApp (A3) funcionando sem chave: deterministico, sem rede. Fala uma
// língua mínima, o bastante para exercitar o caminho inteiro (ferramenta, ação, desfazer):
//   "/op NomeDaOperacao {json}" → um tool_use dessa operação; depois do resultado, uma frase curta;
//   qualquer outro texto        → "eco: <texto>".
// A config o recusa com NODE_ENV=production (config.js).

export const MODELO_FALSO = "modelo-falso";
const OP = /^\/op\s+([A-Za-z][A-Za-z0-9]*)\s*([\s\S]*)$/;

function textoDoUsuario(mensagem) {
  const blocos = Array.isArray(mensagem?.content) ? mensagem.content : [{ type: "text", text: String(mensagem?.content ?? "") }];
  const textos = blocos.filter((b) => b?.type === "text");
  return String(textos.at(-1)?.text ?? "").trim();
}

function respostaFalsa(corpo, content, stop_reason) {
  return {
    id: `msg_falso_${corpo.messages.length}`,
    type: "message",
    role: "assistant",
    model: MODELO_FALSO,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: Math.ceil(JSON.stringify(corpo.messages).length / 4),
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    input_transformations: [],
  };
}

export function modeloFalsoDev() {
  return {
    modelo: MODELO_FALSO,
    async criar(corpo) {
      const ultima = corpo.messages.at(-1);
      const resultados = Array.isArray(ultima?.content) ? ultima.content.filter((b) => b?.type === "tool_result") : [];
      if (resultados.length) {
        // A volta da ferramenta: uma frase sobre cada uma, pelo nome que o tool_use pediu.
        const pedidos = (corpo.messages.at(-2)?.content ?? []).filter((b) => b?.type === "tool_use");
        const frases = resultados.map((r) => {
          const nome = pedidos.find((p) => p.id === r.tool_use_id)?.name ?? "operação";
          if (!r.is_error) return `${nome}: feito.`;
          let codigo = "erro";
          try { codigo = JSON.parse(r.content)?.codigo ?? codigo; } catch { /* conteúdo não-JSON */ }
          return `${nome} recusou (${codigo}).`;
        });
        return respostaFalsa(corpo, [{ type: "text", text: frases.join(" ") }], "end_turn");
      }
      const texto = textoDoUsuario(ultima);
      const m = OP.exec(texto);
      if (!m) return respostaFalsa(corpo, [{ type: "text", text: `eco: ${texto}` }], "end_turn");
      let input;
      try { input = m[2].trim() ? JSON.parse(m[2]) : {}; } catch { input = null; }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return respostaFalsa(corpo, [{ type: "text", text: "modelo falso: os argumentos de /op têm de ser um objeto JSON." }], "end_turn");
      }
      return respostaFalsa(corpo, [{ type: "tool_use", id: `toolu_falso_${corpo.messages.length}`, name: m[1], input }], "tool_use");
    },
  };
}

/** O cliente do processo, pela config: o de roteiro com AGENTE_MODELO_FALSO, senão a API. */
export function criarCliente(agente, { fetch } = {}) {
  if (agente.modeloFalso) return modeloFalsoDev();
  return clienteAnthropic({ apiKey: agente.apiKey, modelo: agente.modelo, fetch });
}
