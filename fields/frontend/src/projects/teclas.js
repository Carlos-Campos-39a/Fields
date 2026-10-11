// Teclas dos campos da tabela de projetos.
//
// Teclado de composição (IME — o Carlos escreve em japonês): o Enter que CONFIRMA a palavra chega
// como keydown "Enter" com isComposing (ou keyCode 229 no Safari). Tratado como "salvar", gravava
// a palavra pela metade e fechava o campo; o Escape da composição, idem, descartava o campo todo.

const compondo = (e) => Boolean(e.nativeEvent?.isComposing) || e.keyCode === 229;

/** Enter que é "salvar", e não o fim de uma composição. */
export const ehEnter = (e) => e.key === "Enter" && !compondo(e);

/** Escape que é "cancelar", e não o fim de uma composição. */
export const ehEscape = (e) => e.key === "Escape" && !compondo(e);

/** Enter ou espaço sobre um elemento role="button" que não é <button>. */
export const ehAtivar = (e) => (e.key === "Enter" || e.key === " ") && !compondo(e);
