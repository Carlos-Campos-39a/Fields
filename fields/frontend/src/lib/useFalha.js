import { useCallback } from "react";
import { useToast } from "../ui/index.js";
import { avisar, camposDoErro } from "./log.js";

/**
 * falha(evento, mensagem, erro, campos?) — a falha que a tela não pode engolir: log com o evento
 * (status e código do erro, nunca o texto do Carlos) + toast danger com a mensagem. Quem chama
 * desfaz o otimista ANTES (rollback) e só então avisa.
 */
export function useFalha() {
  const toast = useToast();
  return useCallback(
    (evento, mensagem, erro, campos = {}) => {
      avisar(evento, mensagem, { ...campos, ...camposDoErro(erro) });
      toast.show({ message: mensagem, tone: "danger" });
    },
    [toast],
  );
}
