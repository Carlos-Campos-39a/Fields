import { formatHash } from "../lib/useHashRoute.js";

/**
 * Abrir uma entrada é NAVEGAR, então é um <a href="#/notas/:id"> de verdade (era um div com
 * role="button"): o leitor de tela anuncia "link", Ctrl/⌘+clique e o botão do meio abrem em outra
 * aba, e "copiar endereço do link" funciona. O clique simples continua passando pelo `onOpen` do
 * pai — é a casca que decide o que abrir significa.
 */
export function EntradaLink({ entrada, onOpen, children, ...rest }) {
  function aoClicar(e) {
    if (!onOpen || e.defaultPrevented) return;
    // Modificador ou botão que não é o principal: deixa o navegador fazer o dele (nova aba etc.).
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(entrada);
  }

  return (
    <a href={formatHash({ view: "notas", id: entrada.id })} onClick={aoClicar} {...rest}>
      {children}
    </a>
  );
}
