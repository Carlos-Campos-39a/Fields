// A gramática da caixa de captura: um prefixo no começo do texto escolhe o tipo da entrada
// ("evento reunião às 14h" → event). Sem prefixo, é nota. Os prefixos são do TECLADO (palavras sem
// acento, abreviações), não rótulos de tela — por isso não vêm da ontologia; o tipo resultante sim.

const PREFIXOS = Object.freeze([
  { tipo: "event", re: /^(evento|event)\s+/i },
  { tipo: "reminder", re: /^(lembrete|reminder)\s+/i },
  { tipo: "lang_fr", re: /^(frances|fr)\s+/i },
  { tipo: "lang_jp", re: /^(japones|china|nihon|jp)\s+/i },
]);

/** "evento X" → {type: "event", body: "X"}; sem prefixo → {type: "note", body}. */
export function parseInput(text) {
  const t = String(text ?? "").trim();
  for (const { tipo, re } of PREFIXOS) {
    if (re.test(t)) return { type: tipo, body: t.replace(re, "") };
  }
  return { type: "note", body: t };
}

/** As dicas mostradas na home e no painel vazio: o prefixo e o tipo que ele produz. */
export const DICAS_DE_PREFIXO = Object.freeze([
  { prefixo: "evento …", tipo: "event" },
  { prefixo: "lembrete …", tipo: "reminder" },
  { prefixo: "frances …", tipo: "lang_fr" },
  { prefixo: "jp …", tipo: "lang_jp" },
]);
