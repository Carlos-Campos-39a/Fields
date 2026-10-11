// O miolo do useExclusao, sem React: recebe o toast em vez de chamar useToast(), e por isso é
// testável em exclusao.test.js. O hook (useExclusao.js) só o embrulha.

import { codigoDe } from "../api.js";
import { avisar, camposDoErro } from "./log.js";

/**
 * 404 num DELETE ou num /restaurar: o servidor JÁ está onde a tela queria chegar — outra aba, o MCP
 * ou o agente (ExcluirComentario, o WhatsApp) fez o mesmo gesto antes. Não é falha: tratar como
 * falha devolvia à tela um item que o servidor não tem mais, e cada nova tentativa batia no mesmo
 * 404 (o fantasma só sumia com F5). Projeto, frente, tarefa e reunião nem chegam aqui no DELETE (a
 * rota legada responde 200 sem ter o que excluir); comentário e entrada respondem 404, e o
 * /restaurar de todos responde 404 quando o item já está de volta.
 */
export function jaFeito(erro) {
  return codigoDe(erro) === "NAO_ENCONTRADO";
}

/**
 * Exclusão com "Desfazer" (ver useExclusao.js para o uso). Devolve true quando o item fica fora da
 * tela — excluído agora ou já antes — e false quando o DELETE falhou e ele voltou.
 *
 * - DELETE falhou → devolve à tela + toast danger.
 * - DELETE 404 → já estava excluído: a tela fica como está (o otimista era a verdade), toast neutro
 *   e sem Desfazer — não há exclusão NOSSA para desfazer.
 * - Deu certo → toast "… · Desfazer". O Desfazer chama /restaurar; se ele falhar, diz (toast danger
 *   + log) em vez de fingir que voltou. Se responder 404, o item já estava de volta: relê a lista
 *   (aposRestaurar) em vez de afirmar que não deu.
 */
export async function excluirComDesfazer(
  toast,
  { entidade, mensagem = "Excluído", tirar, devolver, apagar, restaurar, aposRestaurar },
) {
  tirar?.();
  try {
    await apagar();
  } catch (e) {
    if (jaFeito(e)) {
      avisar("EXCLUSAO_JA_FEITA", "o DELETE respondeu 404: já estava excluído; a tela fica como está", {
        entidade,
        ...camposDoErro(e),
      });
      toast.show({ message: "Isso já tinha sido excluído.", tone: "neutral" });
      return true;
    }
    devolver?.();
    avisar("EXCLUSAO_FALHOU", "o DELETE falhou; item devolvido à tela", { entidade, ...camposDoErro(e) });
    toast.show({ message: "Não foi possível excluir. Nada mudou.", tone: "danger" });
    return false;
  }
  toast.show({
    message: mensagem,
    action: {
      label: "Desfazer",
      onClick: async () => {
        let jaEstava = false;
        try {
          await restaurar();
        } catch (e) {
          if (!jaFeito(e)) {
            avisar("RESTAURACAO_FALHOU", "o /restaurar falhou; o item segue excluído", {
              entidade,
              ...camposDoErro(e),
            });
            toast.show({ message: "Não foi possível desfazer a exclusão.", tone: "danger" });
            return;
          }
          avisar("RESTAURACAO_JA_FEITA", "o /restaurar respondeu 404: já estava de volta; relendo a lista", {
            entidade,
            ...camposDoErro(e),
          });
          jaEstava = true;
        }
        try {
          await aposRestaurar?.();
        } catch (e) {
          // Restaurou no servidor; só a releitura falhou. O item volta no próximo carregamento.
          avisar("RESTAURACAO_SEM_RELEITURA", "restaurado, mas a lista não recarregou", {
            entidade,
            ...camposDoErro(e),
          });
        }
        toast.show(
          jaEstava
            ? { message: "Isso já tinha sido restaurado.", tone: "neutral" }
            : { message: "Restaurado", tone: "success" },
        );
      },
    },
  });
  return true;
}
