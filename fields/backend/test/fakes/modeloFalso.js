// O modelo de roteiro dos testes do motor: responde o que o teste mandou, na ordem, e GRAVA cada
// requisição (cópia profunda do corpo e o timeout) — é sobre essas gravações que o invariante de
// prefixo é conferido. Separado do modelo de roteiro do dev (agente/cliente.js, modeloFalsoDev):
// aquele imita um modelo; este obedece ao teste.
//
// Cada passo do roteiro é:
//   - um objeto parcial de resposta ({content, stop_reason?, usage?, model?, stop_details?,
//     input_transformations?}) — o resto ganha valores padrão;
//   - um Error (lançado, como o SDK lançaria);
//   - uma função (corpo, n) → um dos dois acima (para mexer no relógio, esperar uma trava etc.).

import { APIConnectionTimeoutError, BadRequestError } from "@anthropic-ai/sdk";

let sequencia = 0;

export const pensamento = (assinatura = `sig-${++sequencia}`) => ({ type: "thinking", thinking: "", signature: assinatura });
export const texto = (t) => ({ type: "text", text: t });
export const ferramenta = (nome, input = {}, id = `toolu_${++sequencia}`) => ({ type: "tool_use", id, name: nome, input });

/** O 400 que a API devolve para histórico inválido (o SDK lança BadRequestError). */
export function erro400(mensagem = "messages.1.content.0: Invalid `signature` in `thinking` block.") {
  return new BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: mensagem } }, mensagem, new Headers());
}

/** O timeout do SDK (o prazo da chamada acabou). */
export const erroTimeout = () => new APIConnectionTimeoutError();

function completar(passo, corpo, n) {
  const content = passo.content ?? [];
  return {
    id: `msg_teste_${n}`,
    type: "message",
    role: "assistant",
    model: passo.model ?? corpo.model,
    content,
    stop_reason: passo.stop_reason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
    stop_sequence: null,
    stop_details: passo.stop_details ?? null,
    usage: {
      input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      ...(passo.usage ?? {}),
    },
    input_transformations: passo.input_transformations ?? [],
  };
}

/**
 * A regra da API que o histórico do motor precisa respeitar: toda mensagem com `content` não vazio,
 * exceto a última, se for do assistente. Quebrada, a API devolve 400 — e o fake também, sem gastar
 * passo do roteiro (a requisição nem chegou ao modelo).
 */
function conteudoVazio(messages) {
  return (messages ?? []).findIndex((m, i) => {
    const vazio = Array.isArray(m.content) ? m.content.length === 0 : !String(m.content ?? "");
    return vazio && !(i === messages.length - 1 && m.role === "assistant");
  });
}

export function modeloFalso(roteiro = [], { modelo = "claude-opus-5-5" } = {}) {
  const fila = [...roteiro];
  const chamadas = [];
  return {
    modelo,
    chamadas,
    /** Quantos passos sobraram — o teste confere que o roteiro foi consumido inteiro. */
    get restantes() { return fila.length; },
    async criar(corpo, opcoes = {}) {
      chamadas.push({ corpo: JSON.parse(JSON.stringify(corpo)), timeoutMs: opcoes.timeoutMs });
      const vazia = conteudoVazio(corpo.messages);
      if (vazia >= 0) {
        throw erro400(`messages.${vazia}: all messages must have non-empty content except for the optional final assistant message`);
      }
      if (fila.length === 0) throw new Error("modeloFalso: o roteiro acabou (chamada a mais)");
      let passo = fila.shift();
      if (typeof passo === "function") passo = await passo(corpo, chamadas.length);
      if (passo instanceof Error) throw passo;
      return completar(passo, corpo, chamadas.length);
    },
  };
}
