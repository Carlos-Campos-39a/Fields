// Resposta do agente → o texto de UMA mensagem do WhatsApp. Porta do `formato.py` do CRM
// (services/whatsapp/formato.py), com uma diferença de forma: lá a saída é uma lista de bolhas para o
// gateway do Otto; aqui é um texto só, porque o contrato da Les Chats (§5) aceita um `text` por
// resposta.
//
// Deterministico, sem LLM — pela mesma razão do CRM: um segundo modelo "formatando" reescreve texto
// que já estava certo (arredonda um número, troca um nome), e o Carlos age sobre o errado sem nada
// indicar que houve reescrita. Aqui só se troca a SINTAXE que o WhatsApp não entende:
//   - `**x**` → `*x*` (o negrito de lá é asterisco simples; o duplo chegaria à mostra);
//   - título markdown (`## x`) → a linha sem os `#`;
//   - marcador `* x` / `+ x` → `- x`;
//   - `[rótulo](url)` → `rótulo: url` (com a sintaxe, ele veria os colchetes e não tocaria o link).
//
// Duas diferenças deliberadas do Python:
//   - lá o `\s` do começo de linha casa quebra de linha também, e um título engolia a linha em branco
//     antes dele. Aqui o espaço é só espaço/tab (`[ \t]`), e o parágrafo fica onde estava;
//   - lá `#{1,6}\s*` aceita zero espaços depois do `#`, e "#88 vence hoje" no começo da linha virava
//     "88 vence hoje". Aqui, como no markdown, título exige espaço (ou fim de linha) depois dos `#`.

/** O teto do `text` de uma mensagem do WhatsApp (contrato §5: acima disso, a Les Chats corta). */
export const TEXTO_MAX_WHATSAPP = 4096;

const NEGRITO = /\*\*(.+?)\*\*/gs;
const TITULO = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gm;
const MARCADOR = /^[ \t]{0,3}[*+][ \t]+/gm;
const LINK_MD = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const RETICENCIAS = "…";

/** Markdown de bloco → o que o WhatsApp mostra direito. */
export function paraWhatsapp(texto) {
  return String(texto ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(NEGRITO, "*$1*")
    .replace(TITULO, "")
    .replace(MARCADOR, "- ")
    .replace(LINK_MD, "$1: $2")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Corta em `max` caracteres, na última fronteira que couber — parágrafo, linha, palavra — e marca o
 * corte com "…". Cortar nós mesmos, e não deixar para a Les Chats, é o que garante que o corte cai
 * numa fronteira e que ele vira log (LESCHATS_TEXTO_CORTADO) deste lado.
 *
 * O tamanho é em unidades UTF-16 (o `length` do JS), que é ≥ o número de caracteres que a Meta conta
 * — conservador. Um emoji nunca é partido ao meio: o substituto alto solto no fim sai.
 */
export function limitarTexto(texto, max = TEXTO_MAX_WHATSAPP) {
  const t = String(texto ?? "");
  if (t.length <= max) return { texto: t, cortado: false };
  const teto = max - RETICENCIAS.length;
  const janela = t.slice(0, teto);
  // A fronteira só vale se não jogar fora mais da metade do texto: um parágrafo enorme cortado no
  // primeiro "\n\n" mandaria quase nada.
  const minimo = Math.floor(teto / 2);
  let corte = -1;
  for (const separador of ["\n\n", "\n", " "]) {
    const i = janela.lastIndexOf(separador);
    if (i >= minimo) { corte = i; break; }
  }
  let parte = corte >= 0 ? janela.slice(0, corte) : janela;
  const ultimo = parte.charCodeAt(parte.length - 1);
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) parte = parte.slice(0, -1);
  return { texto: parte.trimEnd() + RETICENCIAS, cortado: true };
}

/**
 * O texto final da resposta: sintaxe do WhatsApp + teto. Nunca vazio — texto vazio a Les Chats
 * gravaria como mensagem do bot sem conteúdo, e o Carlos ficaria sem resposta nenhuma.
 */
export function formatarResposta(texto, max = TEXTO_MAX_WHATSAPP) {
  const limpo = paraWhatsapp(texto);
  if (!limpo) return { texto: RETICENCIAS, cortado: false };
  return limitarTexto(limpo, max);
}
