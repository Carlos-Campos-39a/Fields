import { api, ApiError } from "../api.js";

// A ponte entre os comentários da API nova (/api/comentarios, uma linha por comentário — A1) e o
// formato LEGADO, o array inteiro dentro da entidade, com a chave de data de cada época:
//   entries.threads   = [{id, text, createdAt}]
//   tasks.comments    = [{id, text, created_at}]
//   meetings.comments = [{id, text, created_at}]
// O GET das entidades continua devolvendo esses arrays (montados da tabela), e é deles que saem as
// contagens das listas. A tela ESCREVE pela API nova; o PATCH do array só volta quando o backend
// responde 503 COMENTARIOS_INDISPONIVEIS (a migração da A1 falhou e a tabela não é a verdade).
// Escrever o array inteiro em modo migrado era o bug: o retrato velho voltava 409 e sumia da tela.

export const CHAVE_DATA_LEGADA = Object.freeze({ ENTRADA: "createdAt", TAREFA: "created_at", REUNIAO: "created_at" });

/** O backend está em modo legado (migração dos comentários falhou)? */
export function ehIndisponivel(erro) {
  return erro instanceof ApiError && erro.codigo === "COMENTARIOS_INDISPONIVEIS";
}

/** Comentário da API nova → item da tela. */
export function deApi(c) {
  return { id: String(c.id), texto: c.texto ?? "", criado_em: c.criado_em ?? null };
}

/** Item legado → item da tela. Aceita a chave de data da outra época (a A0 gravou as duas). */
export function deLegado(tipo, item) {
  const chave = CHAVE_DATA_LEGADA[tipo];
  return {
    id: String(item?.id ?? ""),
    texto: typeof item?.text === "string" ? item.text : "",
    criado_em: item?.[chave] ?? item?.createdAt ?? item?.created_at ?? null,
  };
}

/** Item da tela → item legado do alvo (para o estado do pai e para o PATCH de reserva). */
export function paraLegado(tipo, c) {
  return { id: c.id, text: c.texto, [CHAVE_DATA_LEGADA[tipo]]: c.criado_em };
}

/** Array legado (ou o que vier) → itens da tela, sem os ilegíveis. */
export function listaDeLegado(tipo, lista) {
  return (Array.isArray(lista) ? lista : [])
    .filter((i) => i && typeof i === "object" && typeof i.text === "string")
    .map((i) => deLegado(tipo, i));
}

/** Item novo, já no formato da tela, para o caminho legado (o id nasce aqui, como no monólito). */
export function novoItem(texto, agora = new Date()) {
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `c-${agora.getTime()}`;
  return { id, texto, criado_em: agora.toISOString() };
}

/** PATCH do array inteiro na entidade dona — o caminho de reserva do modo legado. */
export function patchLegado(tipo, alvoId, itens) {
  const lista = itens.map((c) => paraLegado(tipo, c));
  if (tipo === "ENTRADA") return api.updateEntry(alvoId, { threads: lista });
  if (tipo === "TAREFA") return api.updateTask(alvoId, { comments: lista });
  if (tipo === "REUNIAO") return api.updateMeeting(alvoId, { comments: lista });
  return Promise.reject(new TypeError(`patchLegado: alvo desconhecido (${String(tipo)})`));
}

/**
 * Acrescenta UM comentário a um alvo: API nova; com 503 COMENTARIOS_INDISPONIVEIS, o PATCH do
 * array — `legadoAtual` é o array que a tela tem do alvo. Devolve {item, modo: "novo"|"legado"}.
 * É o que "vincular à tarefa" usa (InputBar, CommentThread): um POST, nunca um array montado em
 * cima do retrato que o seletor carregou.
 */
export async function comentar({ tipo, id }, texto, legadoAtual = []) {
  try {
    const { comentario } = await api.createComentario({ alvo_tipo: tipo, alvo_id: id, texto });
    return { item: deApi(comentario), modo: "novo" };
  } catch (e) {
    if (!ehIndisponivel(e)) throw e;
  }
  const item = novoItem(texto);
  await patchLegado(tipo, id, [...listaDeLegado(tipo, legadoAtual), item]);
  return { item, modo: "legado" };
}
