import { useCallback, useRef, useState } from "react";
import { useFalha } from "../lib/useFalha.js";
import { encerrarSessao } from "./sessao.js";

/**
 * { sair, saindo } — o "Sair" de qualquer tela (TopBar, home, menu "Mais" do celular).
 * A falha vira toast danger com LOGOUT_FALHOU no console (status e código, nada mais); deu certo,
 * o Gate troca a tela pelo login. Dois toques seguidos fazem UMA chamada.
 */
export function useSair() {
  const falha = useFalha();
  const [saindo, setSaindo] = useState(false);
  const emVoo = useRef(false);

  const sair = useCallback(async () => {
    if (emVoo.current) return;
    emVoo.current = true;
    setSaindo(true);
    try {
      await encerrarSessao();
    } catch (e) {
      falha("LOGOUT_FALHOU", "Não foi possível sair. A sessão continua aberta — tente de novo.", e);
    } finally {
      emVoo.current = false;
      setSaindo(false);
    }
  }, [falha]);

  return { sair, saindo };
}
