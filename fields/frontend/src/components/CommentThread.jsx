import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../api.js";
import { Button, Icon, IconButton, Spinner, useToast } from "../ui/index.js";
import { formatDateTime } from "../lib/dates.js";
import { avisar, avisarUmaVez, camposDoErro } from "../lib/log.js";
import { jaFeito } from "../lib/exclusao.js";
import { comentar, deApi, ehIndisponivel, listaDeLegado, novoItem, paraLegado, patchLegado } from "../lib/comentarios.js";
import { TaskPicker } from "./TaskPicker.jsx";
import styles from "./CommentThread.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");

function inserirEm(lista, indice, item) {
  const i = indice < 0 || indice > lista.length ? lista.length : indice;
  return [...lista.slice(0, i), item, ...lista.slice(i)];
}

// Ordem do servidor: criado_em, depois id (servicos/comentarios.js: ORDER BY criado_em, id).
function inserirOrdenado(lista, item) {
  const chave = (c) => `${c.criado_em ?? ""}\u0000${c.id}`;
  const i = lista.findIndex((c) => !c.pendente && chave(c) > chave(item));
  return inserirEm(lista, i, item);
}

const NIVEIS_DE_TITULO = [2, 3, 4, 5, 6];

/**
 * O fio de comentários de UM alvo — o ÚNICO do Fields'. Substitui as três listas do monólito
 * (ThreadSection da entrada, TaskCommentBubble da tarefa, comentários da reunião na Agenda), que
 * reescreviam o array inteiro a cada gesto.
 *
 *   <CommentThread alvo={{ tipo: "TAREFA", id: tarefa.id }} legado={tarefa.comments}
 *     onChange={(comments) => atualizarTarefa({ comments })} />
 *
 * - Lê e escreve por /api/comentarios (POST, DELETE, /restaurar). Excluir mostra o toast
 *   "Comentário excluído · Desfazer".
 * - `legado` é o array que a entidade já trouxe (entry.threads, task.comments, meeting.comments):
 *   pinta a lista na hora, antes do GET, e é a base do caminho de reserva.
 * - Só com 503 COMENTARIOS_INDISPONIVEIS (migração da A1 falhada) cai no PATCH do array legado.
 * - `onChange(arrayLegado)` devolve ao pai a lista confirmada, no formato do alvo — é o que mantém
 *   as contagens (💬 n) do pai certas sem recarregar.
 * - `vincularTarefa` (entradas): cada anotação nova também vira comentário da tarefa escolhida no
 *   TaskPicker, por POST — não por PATCH sobre o retrato que o seletor carregou.
 * - `inputRef`: ref do textarea, para quem precisa dar o foco (o Popover da tarefa).
 * - `nivelTitulo` (2–6, padrão 3): o nível do <h*> do título. O fio mora em lugares de
 *   profundidades diferentes — sob o <h1> da entrada, sob o <h3> do dia na Agenda — e um <h3>
 *   fixo ficava no mesmo nível do dia que o contém, achatando o sumário do leitor de tela.
 */
export function CommentThread({
  alvo,
  legado,
  onChange,
  vincularTarefa = false,
  compacto = false,
  nivelTitulo = 3,
  titulo = "Comentários",
  vazio = "Nenhum comentário ainda.",
  placeholder = "Adicionar comentário… (Enter envia, Shift+Enter quebra linha)",
  rotuloCampo = "Novo comentário",
  inputRef,
  className,
}) {
  const { tipo, id } = alvo;
  const toast = useToast();
  const [itens, setItens] = useState(() => listaDeLegado(tipo, legado));
  const [modo, setModo] = useState("carregando"); // carregando | novo | legado | erro
  const [rascunho, setRascunho] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [vinculo, setVinculo] = useState(null); // {tarefa, frente, projeto}
  const [seletorAberto, setSeletorAberto] = useState(false);
  const [recarga, setRecarga] = useState(0);

  const itensRef = useRef(itens);
  const modoRef = useRef(modo);
  const chaveRef = useRef(`${tipo}:${id}`);
  const legadoRef = useRef(legado);
  legadoRef.current = legado;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const seq = useRef(0);
  const seletorRef = useRef(null);
  const textoInterno = useRef(null);
  const textoRef = inputRef ?? textoInterno;
  const tituloId = useId();

  // Toda mudança da lista passa por aqui: o ref fica certo no mesmo tique (os awaits leem dele).
  const aplicar = useCallback((fn) => {
    const proxima = fn(itensRef.current);
    itensRef.current = proxima;
    setItens(proxima);
    return proxima;
  }, []);

  const definirModo = useCallback((m) => {
    modoRef.current = m;
    setModo(m);
  }, []);

  const publicar = useCallback(() => {
    onChangeRef.current?.(itensRef.current.filter((i) => !i.pendente).map((i) => paraLegado(tipo, i)));
  }, [tipo]);

  // Troca de alvo: rascunho e vínculo eram do alvo anterior.
  useEffect(() => {
    chaveRef.current = `${tipo}:${id}`;
    setRascunho("");
    setVinculo(null);
    setSeletorAberto(false);
  }, [tipo, id]);

  // Leitura: pinta o legado na hora e troca pelo GET quando ele volta.
  useEffect(() => {
    const minha = ++seq.current;
    aplicar(() => listaDeLegado(tipo, legadoRef.current));
    definirModo("carregando");
    api
      .getComentarios(tipo, id)
      .then(({ comentarios }) => {
        if (minha !== seq.current) return;
        // O que está em voo (digitado antes de o GET voltar) fica no fim; o POST o confirma.
        const doServidor = (Array.isArray(comentarios) ? comentarios : []).map(deApi);
        aplicar((l) => [...doServidor, ...l.filter((i) => i.pendente)]);
        definirModo("novo");
        publicar();
      })
      .catch((e) => {
        if (minha !== seq.current) return;
        if (ehIndisponivel(e)) {
          avisar("COMENTARIOS_MODO_LEGADO", "API de comentários indisponível; usando o array da entidade", {
            alvo_tipo: tipo,
          });
          definirModo("legado");
          return;
        }
        avisar("COMENTARIOS_LEITURA_FALHOU", "não deu para ler os comentários; mostrando os da entidade", {
          alvo_tipo: tipo,
          ...camposDoErro(e),
        });
        definirModo("erro");
      });
  }, [tipo, id, recarga, aplicar, definirModo, publicar]);

  const falhar = (evento, mensagem, e) => {
    avisar(evento, mensagem, { alvo_tipo: tipo, ...camposDoErro(e) });
    toast.show({ message: mensagem, tone: "danger" });
  };

  async function gravarNovo(texto, chave) {
    if (modoRef.current !== "legado") {
      try {
        const { comentario } = await api.createComentario({ alvo_tipo: tipo, alvo_id: id, texto });
        return deApi(comentario);
      } catch (e) {
        if (!ehIndisponivel(e)) throw e;
        definirModo("legado");
      }
    }
    exigirMesmoAlvo(chave);
    const item = novoItem(texto);
    await patchLegado(tipo, id, [...itensRef.current.filter((i) => !i.pendente), item]);
    return item;
  }

  async function vincular(escolha, texto) {
    try {
      const { item, modo: modoTarefa } = await comentar({ tipo: "TAREFA", id: escolha.tarefa.id }, texto, escolha.tarefa.comments);
      // No modo legado o PATCH seguinte precisa do array com este item, senão o apagaria.
      if (modoTarefa === "legado") {
        setVinculo((v) =>
          v && v.tarefa.id === escolha.tarefa.id
            ? { ...v, tarefa: { ...v.tarefa, comments: [...(v.tarefa.comments ?? []), paraLegado("TAREFA", item)] } }
            : v,
        );
      }
    } catch (e) {
      falhar("VINCULO_TAREFA_FALHOU", "A anotação foi salva, mas não chegou à tarefa.", e);
    }
  }

  async function adicionar() {
    const texto = rascunho.trim();
    if (!texto || enviando) return;
    const chave = chaveRef.current;
    const escolha = vinculo;
    setEnviando(true);
    setRascunho("");
    const pendente = { ...novoItem(texto), id: `pendente-${Date.now()}`, pendente: true };
    aplicar((l) => [...l, pendente]);

    let salvo;
    try {
      salvo = await gravarNovo(texto, chave);
    } catch (e) {
      if (chave === chaveRef.current) {
        aplicar((l) => l.filter((i) => i.id !== pendente.id));
        setRascunho((r) => r || texto); // o texto volta para a caixa: nada se perde
      }
      setEnviando(false);
      falhar("COMENTARIO_FALHOU", "Não foi possível salvar o comentário.", e);
      return;
    }
    if (chave === chaveRef.current) {
      aplicar((l) => {
        if (l.some((i) => i.id === pendente.id)) return l.map((i) => (i.id === pendente.id ? salvo : i));
        return l.some((i) => i.id === salvo.id) ? l : [...l, salvo];
      });
      publicar();
    }
    setEnviando(false);
    if (escolha) await vincular(escolha, texto);
  }

  // No modo legado o PATCH leva a lista INTEIRA do alvo: se a tela já trocou de alvo, a lista em
  // memória é de outro, e gravá-la apagaria comentários alheios. Recusa em vez de arriscar.
  function exigirMesmoAlvo(chave) {
    if (chave !== chaveRef.current) throw Object.assign(new Error("ALVO_TROCADO"), { name: "ALVO_TROCADO" });
  }

  async function apagarNoServidor(item, chave) {
    if (modoRef.current !== "legado") {
      try {
        await api.deleteComentario(item.id);
        return;
      } catch (e) {
        if (!ehIndisponivel(e)) throw e;
        definirModo("legado");
      }
    }
    exigirMesmoAlvo(chave);
    await patchLegado(tipo, id, itensRef.current.filter((i) => !i.pendente));
  }

  // 404 no DELETE ou no /restaurar: a lista em memória é que está velha — outra aba, o MCP ou o
  // agente chegou antes. E aqui o 404 cobre também "alvo escondido" (alvoDoComentarioVisivel no
  // backend): a tarefa ou a entrada saiu em outro lugar. Reinserir às cegas deixava na tela um
  // fantasma — cada nova tentativa dava o mesmo 404, e ele só sumia com F5 —, e afirmar que o
  // /restaurar falhou era falso; reler mostra o que o servidor tem. O
  // publicar() vem antes para o pai já ter a lista sem o item quando o recarregamento pintar o
  // legado (senão o item piscaria de volta até o GET responder).
  function ressincronizar(evento, mensagem, chave, e) {
    avisar(evento, mensagem, { entidade: "COMENTARIO", alvo_tipo: tipo, ...camposDoErro(e) });
    if (chave !== chaveRef.current) return; // trocou de alvo: a lista deste já foi embora
    publicar();
    setRecarga((v) => v + 1);
  }

  async function restaurar(item, indice, chave) {
    // Lido antes: no modo legado o 404 é do PATCH do array, e quer dizer que o ALVO sumiu — aí não
    // há "já restaurado" a afirmar.
    const viaApi = modoRef.current !== "legado";
    try {
      if (!viaApi) {
        exigirMesmoAlvo(chave);
        const lista = inserirEm(itensRef.current.filter((i) => !i.pendente), indice, item);
        await patchLegado(tipo, id, lista);
        if (chave === chaveRef.current) aplicar(() => lista);
      } else {
        await api.restaurarComentario(item.id);
        if (chave === chaveRef.current) aplicar((l) => inserirOrdenado(l, item));
      }
    } catch (e) {
      if (viaApi && jaFeito(e)) {
        ressincronizar("RESTAURACAO_JA_FEITA", "o /restaurar respondeu 404; relendo o fio", chave, e);
        toast.show({ message: "O comentário já tinha sido restaurado.", tone: "neutral" });
        return;
      }
      falhar("COMENTARIO_RESTAURACAO_FALHOU", "Não foi possível restaurar o comentário.", e);
      return;
    }
    if (chave === chaveRef.current) publicar();
    toast.show({ message: "Comentário restaurado", tone: "success" });
  }

  async function excluir(item) {
    const chave = chaveRef.current;
    const indice = itensRef.current.findIndex((i) => i.id === item.id);
    aplicar((l) => l.filter((i) => i.id !== item.id));
    try {
      await apagarNoServidor(item, chave);
    } catch (e) {
      // Sem Desfazer: não houve exclusão NOSSA para desfazer.
      if (jaFeito(e)) {
        ressincronizar("EXCLUSAO_JA_FEITA", "o DELETE respondeu 404; relendo o fio em vez de devolver o item", chave, e);
        toast.show({ message: "O comentário já tinha sido excluído.", tone: "neutral" });
        return;
      }
      if (chave === chaveRef.current) aplicar((l) => inserirEm(l, indice, item));
      falhar("COMENTARIO_EXCLUSAO_FALHOU", "Não foi possível excluir o comentário.", e);
      return;
    }
    publicar();
    toast.show({
      message: "Comentário excluído",
      action: { label: "Desfazer", onClick: () => restaurar(item, indice, chave) },
    });
  }

  function aoTeclar(e) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent?.isComposing) return;
    e.preventDefault();
    adicionar();
  }

  const n = itens.filter((i) => !i.pendente).length;

  if (!NIVEIS_DE_TITULO.includes(nivelTitulo)) {
    avisarUmaVez("COMENTARIOS_NIVEL_TITULO_INVALIDO", "nível de título fora de 2–6; usando 3", {
      nivel: nivelTitulo ?? null,
    });
  }
  const Titulo = `h${NIVEIS_DE_TITULO.includes(nivelTitulo) ? nivelTitulo : 3}`;

  return (
    <section className={cx(styles.fio, compacto && styles.compacto, className)} aria-labelledby={tituloId}>
      <Titulo id={tituloId} className={styles.titulo}>
        {titulo} · {n}
        {modo === "carregando" && <Spinner size={12} className={styles.carregando} />}
      </Titulo>

      {modo === "erro" && (
        <div className={styles.alerta} role="alert">
          <span>Não foi possível atualizar os comentários.</span>
          <Button size="sm" variant="ghost" onClick={() => setRecarga((v) => v + 1)}>
            Tentar de novo
          </Button>
        </div>
      )}

      {itens.length === 0 && modo !== "carregando" ? (
        <p className={styles.vazio}>{vazio}</p>
      ) : (
        <ul className={styles.lista}>
          {itens.map((c) => (
            <li key={c.id} className={cx(styles.item, c.pendente && styles.pendente)}>
              <p className={styles.texto}>{c.texto}</p>
              <div className={styles.rodape}>
                <time className={styles.data} dateTime={c.criado_em ?? undefined}>
                  {c.pendente ? "Enviando…" : formatDateTime(c.criado_em)}
                </time>
                {!c.pendente && (
                  <IconButton
                    size="sm"
                    tone="danger"
                    className={styles.alvoDeToque}
                    aria-label="Excluir comentário"
                    onClick={() => excluir(c)}
                  >
                    <Icon name="trash" />
                  </IconButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {vinculo && (
        <div className={styles.vinculo}>
          <Icon name="link" size={12} />
          <span className={styles.caminho}>
            {vinculo.projeto.name} › {vinculo.frente.name} › <strong>{vinculo.tarefa.name || "—"}</strong>
          </span>
          <IconButton size="sm" className={styles.alvoDeToque} aria-label="Desvincular a tarefa" onClick={() => setVinculo(null)}>
            <Icon name="x" />
          </IconButton>
        </div>
      )}

      <div className={styles.composer}>
        <textarea
          ref={textoRef}
          className={styles.campo}
          value={rascunho}
          onChange={(e) => setRascunho(e.target.value)}
          onKeyDown={aoTeclar}
          rows={2}
          placeholder={placeholder}
          aria-label={rotuloCampo}
        />
        <div className={styles.acoes}>
          {vincularTarefa && (
            <IconButton
              ref={seletorRef}
              aria-label={vinculo ? "Trocar a tarefa vinculada" : "Vincular a uma tarefa"}
              aria-haspopup="dialog"
              aria-expanded={seletorAberto}
              active={Boolean(vinculo)}
              onClick={() => setSeletorAberto((v) => !v)}
            >
              <Icon name="link" />
            </IconButton>
          )}
          <IconButton
            variant="secondary"
            aria-label="Enviar"
            disabled={!rascunho.trim() || enviando}
            onClick={adicionar}
          >
            <Icon name="arrow-up" />
          </IconButton>
        </div>
      </div>

      {vincularTarefa && (
        <TaskPicker
          open={seletorAberto}
          onClose={() => setSeletorAberto(false)}
          anchorRef={seletorRef}
          selecionadaId={vinculo?.tarefa.id}
          onSelect={(escolha) => {
            setVinculo(escolha);
            textoRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}
