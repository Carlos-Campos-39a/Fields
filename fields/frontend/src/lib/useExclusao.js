import { useCallback } from "react";
import { useToast } from "../ui/index.js";
import { excluirComDesfazer } from "./exclusao.js";

/**
 * Exclusão com "Desfazer" — o gesto único de toda tela (A1: o DELETE é lógico e /restaurar existe).
 * Substitui o que o monólito fazia: tirar da tela, chamar o DELETE sem catch (ou com catch {}),
 * e o window.confirm só no projeto.
 *
 *   const excluir = useExclusao();
 *   excluir({
 *     entidade: "TAREFA",                      // vai para o log; nunca o nome do item
 *     mensagem: "Tarefa excluída",
 *     tirar:     () => …,                      // otimista: some da tela já
 *     devolver:  () => …,                      // rollback, se o DELETE falhar (404 não é falha)
 *     apagar:    () => api.deleteTask(id),
 *     restaurar: () => api.restaurarTask(id),
 *     aposRestaurar: () => recarregar(),       // põe o item de volta no lugar certo
 *   });
 *
 * O comportamento (falha, 404 de "já feito", Desfazer) mora em exclusao.js, sem React, para ser
 * testado; aqui só entra o toast do contexto.
 */
export function useExclusao() {
  const toast = useToast();
  return useCallback((opcoes) => excluirComDesfazer(toast, opcoes), [toast]);
}
