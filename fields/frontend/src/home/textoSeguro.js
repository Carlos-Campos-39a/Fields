// O texto do agente → uma estrutura que o React desenha com elementos, nunca com HTML.
//
// A resposta vem do modelo, e o modelo repete o que leu: o título de uma nota, um comentário
// colado, a pauta de uma reunião. Um "<img onerror=…>" escrito num desses lugares voltaria inteiro
// na resposta — com dangerouslySetInnerHTML ele rodaria na sessão do Carlos. Aqui não existe
// caminho de texto para HTML: o parser só devolve pedaços de texto marcados (negrito, item), e o
// React escapa cada um (home/TextoDoAgente.jsx). Por isso também não há link automático.
//
// O que se reconhece é o mínimo que o modelo escreve e que muda a leitura:
//   *negrito* e **negrito**   (a regra do WhatsApp: o asterisco abre colado ao texto e fecha colado
//                              a ele, sem letra ou número encostado por fora — "2*3*4" fica como está)
//   "- item", "* item", "• item" no começo da linha → marcador
//   "# Título" (até ######)   → a linha inteira em negrito
//   linha em branco           → parágrafo novo; quebra simples → quebra de linha
// Asterisco que não fecha fica como veio: melhor um "*" a mais na tela que uma palavra sumida.

// Sem lookbehind de propósito: o alvo do Vite ainda cobre Safari < 16.4, onde `(?<=` é erro de
// sintaxe — e um regex inválido derruba o MÓDULO inteiro, não só esta função.
//   1: o que vem antes (início ou um caractere que não é letra, número ou asterisco)
//   2: o delimitador (** ou *), que precisa fechar igual (\2)
//   3: o miolo, que começa e termina sem espaço e sem asterisco — o resto dele é opcional PREGUIÇOSO
//      (`??`): com `?` o motor tentava o miolo mais longo primeiro, e "*a* e *b*" virava UM
//      negrito com "a* e *b" dentro.
const NEGRITO = /(^|[^\p{L}\p{N}*])(\*\*|\*)([^\s*](?:.*?[^\s*])??)\2(?![\p{L}\p{N}*])/gu;
const MARCADOR = /^\s*[-*•]\s+/;
const TITULO = /^\s{0,3}#{1,6}\s+/;

/** Uma linha → [{texto, negrito}], com os trechos de texto vizinhos já juntos. */
export function analisarLinha(linha) {
  const partes = [];
  const empurrar = (texto, negrito) => {
    if (!texto) return;
    const ultima = partes[partes.length - 1];
    if (ultima && ultima.negrito === negrito) ultima.texto += texto;
    else partes.push({ texto, negrito });
  };
  let desde = 0;
  for (const m of linha.matchAll(NEGRITO)) {
    empurrar(linha.slice(desde, m.index) + m[1], false);
    empurrar(m[3], true);
    desde = m.index + m[0].length;
  }
  empurrar(linha.slice(desde), false);
  return partes;
}

/**
 * Texto → parágrafos → linhas: [[{marcador, partes: [{texto, negrito}]}]]. Pura.
 * Vazio, null ou não-texto → [] (quem desenha não mostra nada; quem chama decide o que dizer).
 */
export function analisarTexto(texto) {
  if (typeof texto !== "string") return [];
  const limpo = texto.replace(/\r\n?/g, "\n").trim();
  if (!limpo) return [];
  return limpo.split(/\n[ \t]*\n+/).map((paragrafo) =>
    paragrafo
      .split("\n")
      .map((bruta) => {
        const linha = bruta.trimEnd();
        if (TITULO.test(linha)) {
          const titulo = linha.replace(TITULO, "").replace(/\*/g, "").trim();
          return { marcador: false, partes: titulo ? [{ texto: titulo, negrito: true }] : [] };
        }
        const marcador = MARCADOR.test(linha);
        return { marcador, partes: analisarLinha(marcador ? linha.replace(MARCADOR, "") : linha) };
      })
      .filter((l) => l.partes.length > 0),
  );
}
