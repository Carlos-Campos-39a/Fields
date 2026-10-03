// Utilitários internos dos primitivos de src/ui/. Sem React, sem estilo.

/** Junta classes, ignorando falsy. */
export function cx(...partes) {
  return partes.filter(Boolean).join(" ");
}

const avisados = new Set();

/**
 * console.warn uma vez por chave. O primitivo que recusa um valor (tom desconhecido, status sem
 * mapa, IconButton sem rótulo) diz o porquê e com que valor — nunca cai no padrão em silêncio.
 * `evento` é um código estável em UPPER_SNAKE; os valores vão em campo nomeado.
 */
export function avisarUmaVez(evento, mensagem, campos = {}) {
  const chave = `${evento}:${JSON.stringify(campos)}`;
  if (avisados.has(chave)) return;
  avisados.add(chave);
  console.warn(`[${evento}] ${mensagem}`, { evento, ...campos });
}

const SELETOR_FOCAVEL = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/** Elementos focáveis e visíveis dentro de `raiz`, na ordem do documento. */
export function focaveis(raiz) {
  if (!raiz) return [];
  return Array.from(raiz.querySelectorAll(SELETOR_FOCAVEL)).filter(
    (el) => el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0,
  );
}

/** Foca sem rolar a página, se o elemento ainda estiver no documento. */
export function focarSemRolar(el) {
  if (el && el.isConnected && typeof el.focus === "function") el.focus({ preventScroll: true });
}
