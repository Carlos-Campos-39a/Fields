import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Button, EmptyState, Icon, IconButton, Spinner, useToast } from "../ui/index.js";
import { ehConcluido } from "../lib/ontologia.js";
import { useExclusao } from "../lib/useExclusao.js";
import { useFalha } from "../lib/useFalha.js";
import { DateCell } from "./DateCell.jsx";
import { EditableCell } from "./EditableCell.jsx";
import { HolderToggle } from "./HolderToggle.jsx";
import { StatusPicker } from "./StatusPicker.jsx";
import { TaskComments } from "./TaskComments.jsx";
import { ehEnter, ehEscape } from "./teclas.js";
import styles from "./ProjectsView.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");
const COLUNAS = 7; // nome, ação, status, stakeholder, deadline, holder, excluir

function inserirEm(lista, indice, item) {
  const i = indice < 0 || indice > lista.length ? lista.length : indice;
  return [...lista.slice(0, i), item, ...lista.slice(i)];
}

// Os valores atuais das chaves de `patch` — o que o rollback devolve se a gravação falhar.
const anteriores = (obj, patch) => Object.fromEntries(Object.keys(patch).map((k) => [k, obj?.[k]]));

const contarOcultas = (n) => (n === 1 ? "1 concluída oculta" : `${n} concluídas ocultas`);

/**
 * Rota #/projetos — projeto → frente → tarefa numa tabela editável (cartões abaixo de 768px; o
 * arranjo é só CSS, ver ProjectsView.module.css).
 * Toda edição é otimista COM rollback: falhou, o valor volta e o toast diz (no monólito o await
 * sem catch deixava a tela mentindo). Excluir é soft-delete com "Desfazer" — sem a caixa de confirmação do navegador.
 */
export function ProjectsView() {
  const falha = useFalha();
  const excluir = useExclusao();
  const toast = useToast();
  const [projects, setProjects]   = useState([]);
  const [collapsed, setCollapsed] = useState({});
  const [loading, setLoading]     = useState(true);
  const [erro, setErro]           = useState(false); // a leitura falhou: o vazio NÃO é "nenhum projeto"
  const [adding, setAdding]       = useState(null); // { type, parentId }
  const [addVal, setAddVal]       = useState("");
  const [showLog, setShowLog]     = useState(false); // false = só pendentes, true = tudo
  const fechado = useRef(true);
  const projetosRef = useRef(projects);
  projetosRef.current = projects;

  useEffect(() => { load(); }, []);

  // `silencioso` é a releitura depois do Desfazer: não troca a tabela pelo "Carregando…" e, se
  // falhar, não troca os projetos que estão na tela pela caixa de erro (o toast já avisa).
  async function load({ silencioso = false } = {}) {
    if (!silencioso) setLoading(true);
    try {
      const { projects: p } = await api.getProjects();
      setProjects(p ?? []);
      setErro(false);
    } catch (e) {
      if (!silencioso) setErro(true);
      falha("PROJETOS_LEITURA_FALHOU", "Não foi possível carregar os projetos.", e, { silencioso });
    } finally {
      if (!silencioso) setLoading(false);
    }
  }

  function toggle(id) { setCollapsed(prev => ({ ...prev, [id]: !prev[id] })); }

  // ── Optimistic updaters ──
  function updProj(id, patch) { setProjects(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p)); }
  function updFrente(pid, fid, patch) { setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: p.frentes.map(f => f.id === fid ? { ...f, ...patch } : f) } : p)); }
  function updTask(pid, fid, tid, patch) {
    setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: p.frentes.map(f => f.id === fid ? { ...f, tasks: f.tasks.map(t => t.id === tid ? { ...t, ...patch } : t) } : f) } : p));
  }
  const acharProj = (pid) => projetosRef.current.find(p => p.id === pid);
  const acharFrente = (pid, fid) => acharProj(pid)?.frentes.find(f => f.id === fid);
  const acharTask = (pid, fid, tid) => acharFrente(pid, fid)?.tasks.find(t => t.id === tid);

  async function saveProject(id, patch) {
    const antes = anteriores(acharProj(id), patch);
    updProj(id, patch);
    try { await api.updateProject(id, patch); }
    catch (e) { updProj(id, antes); falha("PROJETO_SALVAR_FALHOU", "Não foi possível salvar o projeto.", e, { campos: Object.keys(patch) }); }
  }
  async function saveFrente(pid, fid, patch) {
    const antes = anteriores(acharFrente(pid, fid), patch);
    updFrente(pid, fid, patch);
    try { await api.updateFrente(fid, patch); }
    catch (e) { updFrente(pid, fid, antes); falha("FRENTE_SALVAR_FALHOU", "Não foi possível salvar a frente.", e, { campos: Object.keys(patch) }); }
  }
  /** true se gravou; false se falhou (o valor anterior já voltou e o toast já disse). */
  async function saveTask(pid, fid, tid, patch) {
    const antes = anteriores(acharTask(pid, fid, tid), patch);
    updTask(pid, fid, tid, patch);
    try { await api.updateTask(tid, patch); return true; }
    catch (e) { updTask(pid, fid, tid, antes); falha("TAREFA_SALVAR_FALHOU", "Não foi possível salvar a tarefa.", e, { campos: Object.keys(patch) }); return false; }
  }

  // Com o Log desligado, a tarefa que vira "Concluído" sai da tabela no mesmo clique. Sem aviso, a
  // linha simplesmente sumia; o toast diz para onde ela foi e oferece a volta.
  async function mudarStatusTarefa(pid, fid, task, status) {
    const antes = task.status;
    const vaiSumir = !showLog && ehConcluido(status) && !ehConcluido(antes);
    const gravou = await saveTask(pid, fid, task.id, { status });
    if (gravou && vaiSumir) {
      toast.show({
        message: "Tarefa concluída. O Log mostra as concluídas.",
        action: { label: "Desfazer", onClick: () => saveTask(pid, fid, task.id, { status: antes }) },
      });
    }
  }

  function delProject(id) {
    const indice = projetosRef.current.findIndex(p => p.id === id);
    const item = projetosRef.current[indice];
    excluir({
      entidade: "PROJETO", mensagem: "Projeto excluído",
      tirar: () => setProjects(prev => prev.filter(p => p.id !== id)),
      devolver: () => setProjects(prev => inserirEm(prev, indice, item)),
      apagar: () => api.deleteProject(id),
      restaurar: () => api.restaurarProject(id),
      aposRestaurar: () => load({ silencioso: true }),
    });
  }
  function delFrente(pid, fid) {
    const proj = acharProj(pid);
    const indice = proj?.frentes.findIndex(f => f.id === fid) ?? -1;
    const item = proj?.frentes[indice];
    excluir({
      entidade: "FRENTE", mensagem: "Frente excluída",
      tirar: () => setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: p.frentes.filter(f => f.id !== fid) } : p)),
      devolver: () => setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: inserirEm(p.frentes, indice, item) } : p)),
      apagar: () => api.deleteFrente(fid),
      restaurar: () => api.restaurarFrente(fid),
      aposRestaurar: () => load({ silencioso: true }),
    });
  }
  function delTask(pid, fid, tid) {
    const frente = acharFrente(pid, fid);
    const indice = frente?.tasks.findIndex(t => t.id === tid) ?? -1;
    const item = frente?.tasks[indice];
    const mapear = (fn) => setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: p.frentes.map(f => f.id === fid ? { ...f, tasks: fn(f.tasks) } : f) } : p));
    excluir({
      entidade: "TAREFA", mensagem: "Tarefa excluída",
      tirar: () => mapear(ts => ts.filter(t => t.id !== tid)),
      devolver: () => mapear(ts => inserirEm(ts, indice, item)),
      apagar: () => api.deleteTask(tid),
      restaurar: () => api.restaurarTask(tid),
      aposRestaurar: () => load({ silencioso: true }),
    });
  }

  // Enter, blur e Escape passam por aqui. `fechado` garante UM POST por campo: o Enter fecha o
  // campo já, e o blur que o navegador dispara ao desmontá-lo (com o POST ainda em voo) encontra a
  // trava — no monólito ele criava o item de novo, e o Escape seguido do blur criava o que o
  // Carlos tinha acabado de descartar. Se o POST falhar, o campo reabre com o texto.
  function abrirAdd(alvo) { fechado.current = false; setAdding(alvo); setAddVal(""); }
  function cancelarAdd() { fechado.current = true; setAdding(null); setAddVal(""); }

  async function commitAdd() {
    if (fechado.current || !adding) return;
    const alvo = adding;
    const name = addVal.trim();
    cancelarAdd();
    if (!name) return;
    try {
      if (alvo.type === "project") {
        const { project } = await api.createProject({ name });
        setProjects(prev => [...prev, { frentes: [], ...project }]);
      } else if (alvo.type === "frente") {
        const { frente } = await api.createFrente(alvo.parentId, { name });
        setProjects(prev => prev.map(p => p.id === alvo.parentId ? { ...p, frentes: [...(p.frentes ?? []), { tasks: [], ...frente }] } : p));
        setCollapsed(prev => ({ ...prev, [alvo.parentId]: false }));
      } else if (alvo.type === "task") {
        const { task } = await api.createTask(alvo.parentId, { name });
        setProjects(prev => prev.map(p => ({ ...p, frentes: (p.frentes ?? []).map(f => f.id === alvo.parentId ? { ...f, tasks: [...(f.tasks ?? []), task] } : f) })));
      }
    } catch (e) {
      fechado.current = false;
      setAdding(alvo); setAddVal(name);
      falha("PROJETOS_CRIAR_FALHOU", "Não foi possível criar. O nome continua no campo.", e, { tipo: alvo.type });
    }
  }

  const teclasDoAdd = (e) => {
    if (ehEnter(e)) { e.preventDefault(); commitAdd(); }
    else if (ehEscape(e)) cancelarAdd();
  };

  // O campo de criação monta já com o foco (autoFocus): no monólito era um setTimeout de 40 ms.
  const campoNovo = (rotulo, dica) => (
    <input
      autoFocus
      className={styles.campoNovo}
      value={addVal}
      onChange={e => setAddVal(e.target.value)}
      aria-label={rotulo}
      placeholder={dica}
      onKeyDown={teclasDoAdd}
      onBlur={commitAdd}
    />
  );

  const botaoExcluir = (rotulo, onClick) => (
    <IconButton size="sm" tone="danger" className={styles.excluir} aria-label={rotulo} onClick={onClick}>
      <Icon name="trash" />
    </IconButton>
  );

  const semProjetos = projects.length === 0;
  // Sem a lista (carregando ou falhou), criar não: um projeto novo numa tabela que não mostra os
  // outros é o caminho para o Carlos recriar um que já existe.
  const podeCriar = !loading && !erro;

  let corpo;
  if (loading) {
    corpo = (
      <div role="status" className={styles.carregando}>
        <Spinner /> Carregando projetos…
      </div>
    );
  } else if (erro) {
    corpo = (
      <div className={styles.caixaVazia}>
        <EmptyState
          icon="alert"
          title="Os projetos não carregaram"
          description="Pode ser a conexão ou o servidor. Nada foi apagado."
          action={<Button size="sm" onClick={() => load()}>Tentar de novo</Button>}
        />
      </div>
    );
  } else if (semProjetos && !adding) {
    corpo = (
      <div className={styles.caixaVazia}>
        <EmptyState
          icon="folder"
          title="Nenhum projeto ainda"
          description="Um projeto se divide em frentes, e cada frente em tarefas."
          action={<Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={() => abrirAdd({ type: "project" })}>Novo projeto</Button>}
        />
      </div>
    );
  } else {
    corpo = (
      <div className={styles.moldura}>
        <table className={styles.tabela}>
          <colgroup>
            <col className={styles.colNome} />
            <col className={styles.colAcao} />
            <col className={styles.colStatus} />
            <col className={styles.colStake} />
            <col className={styles.colPrazo} />
            <col className={styles.colHolder} />
            <col className={styles.colAcoes} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Projeto / Frente / Tarefa</th>
              <th scope="col">Ação</th>
              <th scope="col">Status</th>
              <th scope="col">Stakeholder</th>
              <th scope="col">Deadline</th>
              <th scope="col">Holder</th>
              <th scope="col"><span className="sr-only">Excluir</span></th>
            </tr>
          </thead>

          {projects.map(proj => {
            const recolhido = Boolean(collapsed[proj.id]);
            const nomeProj = proj.name || "sem nome";
            return (
              <tbody key={proj.id} className={styles.grupo}>
                {/* ── Projeto ── */}
                <tr className={styles.linhaProjeto}>
                  <td className={cx(styles.celula, styles.cNome)}>
                    <div className={styles.nomeLinha}>
                      <IconButton size="sm" onClick={() => toggle(proj.id)} aria-expanded={!recolhido}
                        aria-label={`Frentes do projeto ${nomeProj}`} title={recolhido ? "Expandir" : "Recolher"}>
                        <Icon name={recolhido ? "chevron-right" : "chevron-down"} />
                      </IconButton>
                      <div className={styles.nome}>
                        <EditableCell value={proj.name} variante="projeto" obrigatorio label="Nome do projeto" placeholder="Projeto"
                          onSave={v => saveProject(proj.id, { name: v })} />
                      </div>
                    </div>
                  </td>
                  <td className={cx(styles.celula, styles.cAcao, styles.vazia)} />
                  <td className={cx(styles.celula, styles.cStatus)} data-rotulo="Status">
                    <StatusPicker value={proj.status} label="Status do projeto" onChange={v => saveProject(proj.id, { status: v })} />
                  </td>
                  <td className={cx(styles.celula, styles.cStake, styles.vazia)} />
                  <td className={cx(styles.celula, styles.cPrazo, styles.vazia)} />
                  <td className={cx(styles.celula, styles.cHolder)} data-rotulo="Holder">
                    <HolderToggle value={proj.holder} onChange={v => saveProject(proj.id, { holder: v })} />
                  </td>
                  <td className={cx(styles.celula, styles.cAcoes)}>
                    {botaoExcluir(`Excluir projeto ${nomeProj}`, () => delProject(proj.id))}
                  </td>
                </tr>

                {/* ── Frentes + tarefas ── */}
                {!recolhido && (proj.frentes ?? []).map(frente => {
                  const tarefas = frente.tasks ?? [];
                  const visiveis = showLog ? tarefas : tarefas.filter(t => !ehConcluido(t.status));
                  const ocultas = tarefas.length - visiveis.length;
                  const nomeFrente = frente.name || "sem nome";
                  return (
                    <Fragment key={frente.id}>
                      <tr className={styles.linhaFrente}>
                        <td colSpan={COLUNAS - 1} className={cx(styles.celula, styles.cFrente)}>
                          <div className={styles.nomeLinha}>
                            <div className={styles.nome}>
                              <EditableCell value={frente.name} variante="frente" obrigatorio label="Nome da frente" placeholder="Frente"
                                onSave={v => saveFrente(proj.id, frente.id, { name: v })} />
                            </div>
                            {ocultas > 0 && <span className={styles.ocultas}>{contarOcultas(ocultas)}</span>}
                            <Button variant="ghost" size="sm" icon={<Icon name="plus" />}
                              aria-label={`Nova tarefa na frente ${nomeFrente}`}
                              onClick={() => abrirAdd({ type: "task", parentId: frente.id })}>Tarefa</Button>
                          </div>
                        </td>
                        <td className={cx(styles.celula, styles.cAcoes)}>
                          {botaoExcluir(`Excluir frente ${nomeFrente}`, () => delFrente(proj.id, frente.id))}
                        </td>
                      </tr>

                      {visiveis.map(task => {
                        const feita = ehConcluido(task.status);
                        return (
                          <tr key={task.id} className={styles.linhaTarefa}>
                            <td className={cx(styles.celula, styles.cNome)}>
                              <div className={styles.nomeLinha}>
                                <span className={styles.marca} aria-hidden="true">
                                  {feita ? <Icon name="check" size={14} className={styles.marcaFeita} /> : <span className={styles.marcaPendente} />}
                                </span>
                                <div className={styles.nome}>
                                  <EditableCell value={task.name} obrigatorio riscado={feita} label="Nome da tarefa" placeholder="Tarefa"
                                    onSave={v => saveTask(proj.id, frente.id, task.id, { name: v })} />
                                </div>
                                <TaskComments task={task} onChange={comments => updTask(proj.id, frente.id, task.id, { comments })} />
                              </div>
                            </td>
                            <td className={cx(styles.celula, styles.cAcao)} data-rotulo="Ação">
                              <EditableCell value={task.acao} label="Ação" onSave={v => saveTask(proj.id, frente.id, task.id, { acao: v })} />
                            </td>
                            <td className={cx(styles.celula, styles.cStatus)} data-rotulo="Status">
                              <StatusPicker value={task.status} label="Status da tarefa" onChange={v => mudarStatusTarefa(proj.id, frente.id, task, v)} />
                            </td>
                            <td className={cx(styles.celula, styles.cStake)} data-rotulo="Stakeholder">
                              <EditableCell value={task.stakeholder} label="Stakeholder" onSave={v => saveTask(proj.id, frente.id, task.id, { stakeholder: v })} />
                            </td>
                            <td className={cx(styles.celula, styles.cPrazo)} data-rotulo="Deadline">
                              <DateCell value={task.deadline} label="Deadline" onSave={v => saveTask(proj.id, frente.id, task.id, { deadline: v })} />
                            </td>
                            <td className={cx(styles.celula, styles.cHolder)} data-rotulo="Holder">
                              <HolderToggle value={task.holder} onChange={v => saveTask(proj.id, frente.id, task.id, { holder: v })} />
                            </td>
                            <td className={cx(styles.celula, styles.cAcoes)}>
                              {botaoExcluir(`Excluir tarefa ${task.name || "sem nome"}`, () => delTask(proj.id, frente.id, task.id))}
                            </td>
                          </tr>
                        );
                      })}

                      {adding?.type === "task" && adding.parentId === frente.id && (
                        <tr className={styles.linhaAdicionar}>
                          <td colSpan={COLUNAS} className={cx(styles.celula, styles.adicionarTarefa)}>
                            {campoNovo("Nome da nova tarefa", "Nome da tarefa… (Enter salva, Esc cancela)")}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}

                {/* ── Nova frente ── */}
                {!recolhido && (
                  <tr className={styles.linhaAdicionar}>
                    <td colSpan={COLUNAS} className={cx(styles.celula, styles.adicionarFrente)}>
                      {adding?.type === "frente" && adding.parentId === proj.id
                        ? campoNovo("Nome da nova frente", "Nome da frente… (Enter salva, Esc cancela)")
                        : (
                          <Button variant="ghost" size="sm" className={styles.botaoRecuado} icon={<Icon name="plus" />}
                            aria-label={`Nova frente no projeto ${nomeProj}`}
                            onClick={() => abrirAdd({ type: "frente", parentId: proj.id })}>Frente</Button>
                        )}
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}

          {/* ── Novo projeto ── */}
          {adding?.type === "project" && (
            <tbody className={styles.grupo}>
              <tr className={styles.linhaAdicionar}>
                <td colSpan={COLUNAS} className={cx(styles.celula, styles.adicionarProjeto)}>
                  {campoNovo("Nome do novo projeto", "Nome do projeto… (Enter salva, Esc cancela)")}
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    );
  }

  return (
    <div className={styles.pagina}>
      <header className={styles.cabecalho}>
        <div>
          <h1 className={styles.titulo}>Acompanhamento de Projetos</h1>
          <p className={styles.subtitulo}>Status, prazo e responsável por frente de trabalho</p>
        </div>
        <div className={styles.acoesTopo}>
          <Button size="sm" aria-pressed={showLog}
            icon={showLog ? <Icon name="check" /> : null}
            title="Mostrar também as tarefas concluídas"
            onClick={() => setShowLog(v => !v)}>Log</Button>
          <Button variant="primary" size="sm" icon={<Icon name="plus" />} disabled={!podeCriar}
            onClick={() => abrirAdd({ type: "project" })}>
            Novo projeto
          </Button>
        </div>
      </header>
      {corpo}
    </div>
  );
}
