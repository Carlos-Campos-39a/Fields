import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../api.js";
import { Button, EmptyState, Spinner, StatusBadge, useToast } from "../ui/index.js";
import { useOntologia } from "../lib/ontologia.js";
import { avisar, avisarUmaVez } from "../lib/log.js";
import { useEhMobile } from "../lib/useEhMobile.js";
import { useFalha } from "../lib/useFalha.js";
import { formatHash } from "../lib/useHashRoute.js";
import { tomDaColuna } from "./colunas.js";
import { KanbanCard } from "./KanbanCard.jsx";
import styles from "./KanbanView.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");

const plural = (n, um, varios) => (n === 1 ? um : varios);

// Rolagem até a coluna: suave, salvo quando o sistema pede menos movimento. O CSS de base zera o
// scroll-behavior nesse caso, mas um scrollIntoView com behavior explícito passaria por cima dele.
function comportamentoDaRolagem() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  } catch {
    return "auto"; // sem matchMedia: rola sem animação, que é o seguro
  }
}

/**
 * Rota #/kanban — as tarefas de um projeto pelas colunas do FLUXO (enums.kanban da ontologia;
 * rótulo e tom pelo StatusBadge, com a contagem ao lado).
 * - Mover e trocar data são otimistas COM rollback: falhou, o cartão volta e o toast diz.
 * - Desktop: as colunas lado a lado, e o cartão se arrasta entre elas. Celular: uma coluna por vez,
 *   com rolagem horizontal que encaixa (scroll-snap), atalhos para cada coluna e o "Mover para" do
 *   cartão no lugar do arrastar. Mover pelo menu avisa com "Desfazer": no celular o cartão some da
 *   coluna que se está vendo, e o aviso é a única prova de que ele foi para o lugar certo.
 */
export function KanbanView() {
  const { enums, rotulo } = useOntologia();
  const falha = useFalha();
  const toast = useToast();
  const ehMobile = useEhMobile();
  const [projects, setProjects] = useState([]);
  const [selProjId, setSelProjId] = useState("");
  const [selFrenteId, setSelFrenteId] = useState("");
  const [loading, setLoading] = useState(true);
  const [erroLeitura, setErroLeitura] = useState(false);
  const [dragOver, setDragOver] = useState(null);
  const [arrastandoId, setArrastandoId] = useState(null);
  const [focoEm, setFocoEm] = useState(null);
  const dragId = useRef(null);
  const colunasRef = useRef(new Map());
  const projetosRef = useRef(projects);
  projetosRef.current = projects;
  const base = useId();

  useEffect(() => {
    load();
    // Uma leitura por montagem; o "Tentar de novo" chama load() de novo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setErroLeitura(false);
    try {
      const { projects: p } = await api.getProjects();
      const lista = Array.isArray(p) ? p : [];
      setProjects(lista);
      // Mantém o projeto escolhido se ele ainda existe; senão, o primeiro.
      setSelProjId((atual) => (lista.some((x) => x.id === atual) ? atual : (lista[0]?.id ?? "")));
    } catch (e) {
      setErroLeitura(true);
      falha("KANBAN_LEITURA_FALHOU", "Não foi possível carregar os projetos.", e);
    } finally {
      setLoading(false);
    }
  }

  const colunas = enums.kanban;
  const primeira = colunas[0];
  // Coluna fora da ontologia não pode sumir do quadro: cai na primeira, e o console diz qual era.
  const colunaDe = (t) => {
    const c = t.kanbanStatus || primeira;
    if (colunas.includes(c)) return c;
    avisarUmaVez("KANBAN_COLUNA_DESCONHECIDA", "tarefa numa coluna fora da ontologia; exibida na primeira", { coluna: c });
    return primeira;
  };

  const selProj    = projects.find((p) => p.id === selProjId) || null;
  const frentes    = selProj?.frentes || [];
  const visFrentes = selFrenteId ? frentes.filter((f) => f.id === selFrenteId) : frentes;
  const allTasks   = visFrentes.flatMap((f) => (f.tasks || []).map((t) => ({ ...t, frenteName: f.name })));
  const byCol      = Object.fromEntries(colunas.map((c) => [c, allTasks.filter((t) => colunaDe(t) === c)]));

  function patchTask(taskId, patch) {
    setProjects((prev) => prev.map((p) => ({ ...p, frentes: (p.frentes ?? []).map((f) => ({ ...f, tasks: (f.tasks ?? []).map((t) => (t.id === taskId ? { ...t, ...patch } : t)) })) })));
  }
  function acharTask(taskId) {
    for (const p of projetosRef.current) for (const f of p.frentes ?? []) for (const t of f.tasks ?? []) if (t.id === taskId) return t;
    return null;
  }

  async function moveTask(taskId, toCol, { viaMenu = false } = {}) {
    const tarefa = acharTask(taskId);
    if (!tarefa) {
      avisar("KANBAN_MOVER_SEM_TAREFA", "tarefa não está mais no quadro; nada foi movido", { coluna: toCol });
      return;
    }
    const de = colunaDe(tarefa);
    if (de === toCol) return;
    const antes = tarefa.kanbanStatus ?? null; // o valor CRU, para o rollback devolver exatamente ele
    patchTask(taskId, { kanbanStatus: toCol });
    if (viaMenu) setFocoEm(taskId);
    try {
      await api.updateTask(taskId, { kanban_status: toCol });
    } catch (e) {
      patchTask(taskId, { kanbanStatus: antes });
      falha("KANBAN_MOVER_FALHOU", "Não foi possível mover a tarefa.", e);
      return;
    }
    if (viaMenu) {
      toast.show({
        message: `Tarefa movida para ${rotulo("kanban", toCol)}`,
        action: { label: "Desfazer", onClick: () => moveTask(taskId, de) },
      });
    }
  }

  async function saveField(taskId, field, value) {
    const localKey = field === "start_date" ? "startDate" : field;
    const antes = acharTask(taskId)?.[localKey] ?? null;
    if (antes === (value ?? null)) return;
    patchTask(taskId, { [localKey]: value });
    try {
      await api.updateTask(taskId, { [field]: value });
    } catch (e) {
      patchTask(taskId, { [localKey]: antes });
      falha("KANBAN_DATA_FALHOU", "Não foi possível salvar a data.", e, { campo: field });
    }
  }

  const aoFocar = useCallback(() => setFocoEm(null), []);

  // ── Arrastar (só desktop) ──
  // Só aceita o que saiu de um cartão deste quadro: um texto arrastado de fora não vira PATCH.
  function onDragStart(e, taskId) {
    dragId.current = taskId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId); // sem dado o Firefox não começa o arrasto
    // Depois do quadro atual: o navegador fotografa o cartão para o "fantasma" do arrasto, e a
    // foto sairia esmaecida se a classe entrasse antes.
    setTimeout(() => setArrastandoId(taskId), 0);
  }
  function onDragOver(e, col) {
    if (!dragId.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOver !== col) setDragOver(col);
  }
  function onDragLeave(e, col) {
    // Sair para um filho da coluna (um cartão) não é sair da coluna.
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver((atual) => (atual === col ? null : atual));
  }
  function onDrop(e, col) {
    e.preventDefault();
    const id = dragId.current;
    dragId.current = null;
    setDragOver(null);
    setArrastandoId(null);
    if (id) moveTask(id, col);
  }
  function onDragEnd() {
    dragId.current = null;
    setDragOver(null);
    setArrastandoId(null);
  }

  function irParaColuna(col) {
    colunasRef.current.get(col)?.scrollIntoView({ behavior: comportamentoDaRolagem(), block: "nearest", inline: "start" });
  }

  if (loading) {
    return (
      <div className={styles.carregando} role="status">
        <Spinner size={20} />
        <span>Carregando os projetos…</span>
      </div>
    );
  }

  const contagem = (n) => (
    <span className={styles.contagem}>
      {n}
      <span className="sr-only"> {plural(n, "tarefa", "tarefas")}</span>
    </span>
  );

  let corpo;
  if (projects.length === 0 && erroLeitura) {
    corpo = (
      <EmptyState
        icon="alert"
        title="Não foi possível carregar os projetos"
        description="Confira a conexão e tente de novo."
        action={<Button size="sm" onClick={load}>Tentar de novo</Button>}
      />
    );
  } else if (projects.length === 0) {
    corpo = (
      <EmptyState
        icon="folder"
        title="Nenhum projeto ainda"
        description="Crie um projeto em Projetos: as tarefas dele aparecem aqui, separadas por etapa."
        action={
          <Button size="sm" onClick={() => { window.location.hash = formatHash({ view: "projetos" }); }}>
            Ir para Projetos
          </Button>
        }
      />
    );
  } else if (!selProj) {
    corpo = (
      <EmptyState
        icon="columns"
        title="Escolha um projeto"
        description="Selecione um projeto acima para ver as tarefas dele por etapa."
      />
    );
  } else {
    corpo = (
      <>
        {ehMobile && (
          <nav className={styles.atalhos} aria-label="Ir para a coluna">
            {colunas.map((col) => (
              <button key={col} type="button" className={styles.atalho} onClick={() => irParaColuna(col)}>
                <StatusBadge value={col} label={rotulo("kanban", col)} />
                {contagem(byCol[col].length)}
              </button>
            ))}
          </nav>
        )}

        <div className={styles.quadro}>
          {colunas.map((col, i) => {
            const tarefas = byCol[col];
            const tituloId = `${base}-coluna-${i}`;
            return (
              <section
                key={col}
                ref={(el) => {
                  if (el) colunasRef.current.set(col, el);
                  else colunasRef.current.delete(col);
                }}
                data-tom={tomDaColuna(col)}
                className={cx(styles.coluna, dragOver === col && styles.alvo)}
                aria-labelledby={tituloId}
                onDragOver={(e) => onDragOver(e, col)}
                onDragLeave={(e) => onDragLeave(e, col)}
                onDrop={(e) => onDrop(e, col)}
              >
                <h3 id={tituloId} className={styles.cabecalhoColuna}>
                  <StatusBadge value={col} label={rotulo("kanban", col)} />
                  {contagem(tarefas.length)}
                </h3>

                {tarefas.length > 0 ? (
                  <ul className={styles.lista}>
                    {tarefas.map((task) => (
                      <li key={task.id}>
                        <KanbanCard
                          task={task}
                          coluna={col}
                          arrastavel={!ehMobile}
                          arrastando={arrastandoId === task.id}
                          focar={focoEm === task.id}
                          onFocado={aoFocar}
                          onDragStart={(e) => onDragStart(e, task.id)}
                          onDragEnd={onDragEnd}
                          onMove={(toCol) => moveTask(task.id, toCol, { viaMenu: true })}
                          onSaveField={(field, value) => saveField(task.id, field, value)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.vazia}>Nenhuma tarefa</p>
                )}
              </section>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div className={styles.tela}>
      <header className={styles.cabecalho}>
        <div className={styles.titulos}>
          <h2 className={styles.tituloTela}>Kanban</h2>
          <p className={styles.subtitulo}>As tarefas do projeto por etapa de execução</p>
        </div>
        {projects.length > 0 && (
          <div className={styles.filtros}>
            <select
              aria-label="Projeto"
              className={styles.seletor}
              value={selProjId}
              onChange={(e) => { setSelProjId(e.target.value); setSelFrenteId(""); }}
            >
              <option value="">Escolha um projeto</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {selProj && frentes.length > 1 && (
              <select
                aria-label="Frente"
                className={styles.seletor}
                value={selFrenteId}
                onChange={(e) => setSelFrenteId(e.target.value)}
              >
                <option value="">Todas as frentes</option>
                {frentes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            )}
          </div>
        )}
      </header>

      {corpo}
    </div>
  );
}
