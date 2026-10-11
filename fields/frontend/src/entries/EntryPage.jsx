import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Button, EmptyState, Spinner, useToast } from "../ui/index.js";
import { avisar } from "../lib/log.js";
import { useExclusao } from "../lib/useExclusao.js";
import { useFalha } from "../lib/useFalha.js";
import { EditForm } from "./EditForm.jsx";
import { EntryView } from "./EntryView.jsx";
import css from "./EntryPage.module.css";

/**
 * #/notas/:id — uma entrada aberta: busca a versão completa (com as relacionadas), alterna
 * leitura/edição, fixa e exclui. No monólito isso era estado solto no App (activeEntry, editing,
 * activeRelated); agora a rota manda e esta página só obedece ao `id`.
 *
 * A página fica montada quando o `id` muda (anterior/próxima, relacionadas): toda resposta que
 * chega depois confere se ainda é da entrada aberta antes de pintar — senão o PATCH lento da
 * entrada A escreveria o título dela por cima da B.
 *
 * Do shell recebe:
 *   resumo        a entrada como está na lista (pinta na hora, antes do GET)
 *   onAtualizada  (parcial com id) → o shell mescla na linha da lista
 *   onTirar       (id)      → o shell tira a linha da lista (exclusão otimista)
 *   onRecarregar  ()        → o shell relê a lista (filtro e ordem podem mudar)
 *   navegar       o do useHashRoute
 */
export function EntryPage({ id, resumo, onAtualizada, onTirar, onRecarregar, navegar }) {
  const toast = useToast();
  const falha = useFalha();
  const excluir = useExclusao();
  const [entrada, setEntrada] = useState(resumo ?? null);
  const [relacionadas, setRelacionadas] = useState([]);
  const [editando, setEditando] = useState(false);
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const fixandoRef = useRef(null); // id da entrada com PATCH de pinned em voo
  const resumoRef = useRef(resumo);
  resumoRef.current = resumo;
  const entradaRef = useRef(entrada);
  entradaRef.current = entrada;
  const idRef = useRef(id);
  idRef.current = id;
  const editarRef = useRef(null);
  const devolverFoco = useRef(false);

  useEffect(() => {
    let vivo = true;
    setEditando(false);
    setErro(false);
    setRelacionadas([]);
    setEntrada(resumoRef.current ?? null);
    api
      .getEntry(id)
      .then((corpo) => {
        if (!vivo) return;
        const entry = corpo?.entry;
        if (!entry || typeof entry !== "object" || entry.id == null) {
          // 200 sem entrada: não pinta o vazio por cima do resumo, diz o que recusou.
          avisar("ENTRADA_RESPOSTA_INVALIDA", "GET da entrada voltou sem `entry`; mantido o resumo da lista", {
            tem_corpo: Boolean(corpo),
          });
          setErro(true);
          return;
        }
        setEntrada(entry);
        setRelacionadas(Array.isArray(corpo.related) ? corpo.related : []);
      })
      .catch((e) => {
        if (!vivo) return;
        if (e?.codigo === "NAO_ENCONTRADO") {
          avisar("ENTRADA_NAO_ENCONTRADA", "a rota pediu uma entrada que não existe (ou foi excluída)", {});
          toast.show({ message: "Essa entrada não existe mais.", tone: "danger" });
          navegar({ view: "notas" }, { substituir: true });
          return;
        }
        setErro(true);
        falha("ENTRADA_LEITURA_FALHOU", "Não foi possível abrir a entrada.", e);
      });
    return () => {
      vivo = false;
    };
    // Só o id (e o "tentar de novo") disparam: toast, falha e navegar são estáveis, e o resumo é
    // lido do ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tentativa]);

  // Saiu da edição (salvou ou cancelou): o foco volta para o Editar, e não para o topo da página.
  useEffect(() => {
    if (editando || !devolverFoco.current) return;
    devolverFoco.current = false;
    editarRef.current?.focus({ preventScroll: true });
  }, [editando]);

  // Otimista: o pino muda na hora, na página e na lista; se o PATCH falhar, volta e o toast diz.
  async function fixar() {
    const atual = entradaRef.current;
    if (!atual || fixandoRef.current === atual.id) return;
    const pinned = !atual.pinned;
    const aplicar = (valor) => {
      setEntrada((e) => (e && e.id === atual.id ? { ...e, pinned: valor } : e));
      onAtualizada({ id: atual.id, pinned: valor });
    };
    fixandoRef.current = atual.id;
    aplicar(pinned);
    try {
      await api.updateEntry(atual.id, { pinned });
    } catch (e) {
      aplicar(!pinned);
      falha("ENTRADA_FIXAR_FALHOU", pinned ? "Não foi possível fixar a entrada." : "Não foi possível desafixar a entrada.", e);
      return;
    } finally {
      if (fixandoRef.current === atual.id) fixandoRef.current = null;
    }
    // A lista ordena por pinned e tem o filtro "Fixados": relê para a linha ir para o lugar certo.
    onRecarregar();
  }

  function apagar() {
    const alvo = entradaRef.current;
    if (!alvo) return;
    excluir({
      entidade: "ENTRADA",
      mensagem: "Entrada excluída",
      tirar: () => {
        onTirar(alvo.id);
        // substituir: o voltar do navegador não deve reabrir uma entrada excluída.
        navegar({ view: "notas" }, { substituir: true });
      },
      devolver: () => {
        onRecarregar();
        navegar({ view: "notas", id: alvo.id });
      },
      apagar: () => api.deleteEntry(alvo.id),
      restaurar: () => api.restaurarEntry(alvo.id),
      aposRestaurar: () => onRecarregar(),
    });
  }

  function aoSalvar(atualizada) {
    onAtualizada(atualizada);
    onRecarregar();
    toast.show({ message: "Entrada atualizada", tone: "success" });
    // O PATCH voltou depois de o Carlos ir para outra entrada: a lista recebe, a página não.
    if (atualizada?.id !== idRef.current) return;
    setEntrada(atualizada);
    devolverFoco.current = true;
    setEditando(false);
  }

  function aoCancelar() {
    devolverFoco.current = true;
    setEditando(false);
  }

  // O fio de anotações devolve o array legado com o id da entrada a que ele pertence (EntryView).
  function aoMudarAnotacoes(entradaId, threads) {
    setEntrada((e) => (e && e.id === entradaId ? { ...e, threads } : e));
    onAtualizada({ id: entradaId, threads });
  }

  let corpo;
  if (!entrada && erro) {
    corpo = (
      <EmptyState
        icon="alert"
        title="Não foi possível abrir a entrada"
        description="A conexão pode ter caído. Nada foi alterado."
        action={
          <Button variant="secondary" onClick={() => setTentativa((t) => t + 1)}>
            Tentar de novo
          </Button>
        }
      />
    );
  } else if (!entrada) {
    corpo = (
      <div className={css.carregando}>
        <Spinner size={20} label="Carregando entrada" />
      </div>
    );
  } else if (editando) {
    corpo = <EditForm key={entrada.id} entry={entrada} onSave={aoSalvar} onCancel={aoCancelar} />;
  } else {
    corpo = (
      <EntryView
        entry={entrada}
        related={relacionadas}
        editarRef={editarRef}
        onEdit={() => setEditando(true)}
        onPin={fixar}
        onDelete={apagar}
        onThreadsChange={aoMudarAnotacoes}
        onOpenRelated={(r) => navegar({ view: "notas", id: r.id })}
      />
    );
  }

  return <div className={css.pagina}>{corpo}</div>;
}
