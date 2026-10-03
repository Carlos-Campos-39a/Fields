import { useSyncExternalStore } from "react";
import { assinarTema, getPreferenciaAplicada, getTema, setPreferencia } from "./theme.js";

// O snapshot precisa ser estável entre leituras sem mudança: uma string resolve isso sem cache.
function lerChave() {
  return `${getPreferenciaAplicada()}|${getTema()}`;
}

/** { preferencia: light|dark|system, tema: light|dark, setPreferencia } — re-renderiza na troca. */
export function useTema() {
  const chave = useSyncExternalStore(assinarTema, lerChave, () => "light|light");
  const [preferencia, tema] = chave.split("|");
  return { preferencia, tema, setPreferencia };
}
