// O atalho global do composer (R3): ⌘K no Mac, Ctrl+K no resto, de qualquer tela. Puro (recebe o
// evento e o navigator), para o teste não precisar de DOM.

/**
 * O keydown é o atalho do composer? Só K com ⌘ ou Ctrl — com Alt ou Shift é outro atalho (do
 * navegador ou de quem vier depois). Tecla segurada (repeat) não navega de novo a cada repetição,
 * e o K de uma composição de IME (japonês, acentos mortos) não é atalho.
 */
export function ehAtalhoDoComposer(e) {
  if (!e || e.repeat || e.isComposing) return false;
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  return String(e.key ?? "").toLowerCase() === "k";
}

/** Mac (ou iPad/iPhone com teclado)? Pela plataforma que o navegador declara; sem ela, não. */
export function ehMac(nav = globalThis.navigator) {
  const plataforma = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac|iphone|ipad/i.test(plataforma);
}

/** O nome do atalho como a tela mostra: "⌘K" ou "Ctrl+K". */
export function rotuloDoAtalho(nav = globalThis.navigator) {
  return ehMac(nav) ? "⌘K" : "Ctrl+K";
}
