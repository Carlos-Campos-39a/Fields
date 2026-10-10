import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { ConfirmDialog, useToast } from "./ui/index.js";
import { useOntologia } from "./lib/ontologia.js";
import { useEhMobile } from "./lib/useEhMobile.js";
import { useFalha } from "./lib/useFalha.js";
import { useHashRoute } from "./lib/useHashRoute.js";
import { AgendaView } from "./agenda/AgendaView.jsx";
import { CardsView } from "./entries/CardsView.jsx";
import { EntryEmpty } from "./entries/EntryEmpty.jsx";
import { EntryPage } from "./entries/EntryPage.jsx";
import { HomePage } from "./home/HomePage.jsx";
import { InputBar } from "./home/InputBar.jsx";
import { KanbanView } from "./kanban/KanbanView.jsx";
import { MobileNav } from "./layout/MobileNav.jsx";
import { Sidebar } from "./layout/Sidebar.jsx";
import { TopBar } from "./layout/TopBar.jsx";
import { ProjectsView } from "./projects/ProjectsView.jsx";
import styles from "./App.module.css";

/**
 * A casca do Fields'. Guarda só o que é de verdade global — a lista de entradas com o filtro e a
 * busca (a barra lateral, os cartões, a home e o anterior/próxima leem dela) — e escolhe a tela
 * pela rota (lib/useHashRoute.js). Cada tela mora na sua pasta e cuida do próprio estado.
 *
 *   desktop  barra lateral + painel (topo, conteúdo da rota, caixa de captura em #/notas)
 *   celular  UMA coisa por vez + a MobileNav embaixo: #/notas é a lista (a barra lateral em
 *            largura cheia), #/notas/:id e as outras vistas são o painel. Toda vista é alcançável.
 *   #/       a home ocupa a tela toda (sem barra lateral), nos dois.
 *
 * Toda troca de rota passa pela guarda de saída (useHashRoute): com uma edição não salva aberta,
 * o diálogo daqui pergunta antes — a lista, o topo e a barra inferior não precisam saber disso.
 */
export default function App() {
  const { rota, navegar, saidaPendente, confirmarSaida, ficar } = useHashRoute();
  const ehMobile = useEhMobile();
  const toast = useToast();
  const falha = useFalha();
  const { rotulo } = useOntologia();
  const [entries, setEntries]       = useState([]);
  const [filtro, setFiltro]         = useState("all");
  const [busca, setBusca]           = useState("");
  const [carregando, setCarregando] = useState(true);
  const consulta = useRef({ filtro, busca });
  consulta.current = { filtro, busca };
  const seq = useRef(0);
  const jaCarregou = useRef(false);
  const conteudoRef = useRef(null);

  // A lista de entradas com o filtro e a busca correntes. Só a resposta da ÚLTIMA ida pinta a
  // lista: uma busca lenta que voltasse depois da seguinte mostraria o resultado errado.
  const carregar = useCallback(async () => {
    const minha = ++seq.current;
    const { filtro: type, busca: search } = consulta.current;
    try {
      const { entries: e } = await api.getEntries({ type, search });
      if (minha === seq.current) setEntries(e ?? []);
    } catch (err) {
      if (minha === seq.current) falha("ENTRADAS_LEITURA_FALHOU", "Não foi possível carregar as entradas.", err);
    } finally {
      jaCarregou.current = true;
      if (minha === seq.current) setCarregando(false);
    }
  }, [falha]);

  // Filtro e busca recarregam com 250 ms de folga (uma ida por pausa, não por tecla). A primeira
  // carga vai na hora — no monólito eram duas idas no boot (loadAll() e o debounce).
  useEffect(() => {
    const t = setTimeout(carregar, jaCarregou.current ? 250 : 0);
    return () => clearTimeout(t);
  }, [filtro, busca, carregar]);

  // Trocou de tela: o conteúdo começa do topo.
  useEffect(() => {
    if (conteudoRef.current) conteudoRef.current.scrollTop = 0;
  }, [rota.view, rota.id]);

  function aoCriar(entry) {
    setEntries((prev) => [entry, ...prev]);
    toast.show({ message: `Salvo como ${rotulo("tipo_entrada", entry.type, { capitalizar: false }) || "entrada"}`, tone: "success" });
    carregar();
  }

  const aoAtualizar = useCallback((entry) => {
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, ...entry } : e)));
  }, []);

  const tirarEntrada = useCallback((id) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const abrirEntrada = useCallback((entry) => navegar({ view: "notas", id: entry.id }), [navegar]);

  const { view, id } = rota;
  const idx = id ? entries.findIndex((e) => e.id === id) : -1;
  const entradaDaLista = idx >= 0 ? entries[idx] : null;

  const mostrarSidebar = view !== "home" && (!ehMobile || (view === "notas" && !id));
  const mostrarPainel = view === "home" || !ehMobile || view !== "notas" || Boolean(id);
  const mostrarCaptura = view === "notas" && (!ehMobile || Boolean(id));

  let conteudo = null;
  if (view === "home") {
    conteudo = (
      <HomePage
        onClose={() => navegar({ view: "notas" })}
        onCreated={aoCriar}
        recentEntries={entries}
        onOpenEntry={abrirEntrada}
      />
    );
  } else if (view === "notas") {
    conteudo = id ? (
      <EntryPage
        id={id}
        resumo={entradaDaLista}
        onAtualizada={aoAtualizar}
        onTirar={tirarEntrada}
        onRecarregar={carregar}
        navegar={navegar}
      />
    ) : (
      <EntryEmpty />
    );
  } else if (view === "cards") {
    conteudo = <CardsView entries={entries} onOpen={abrirEntrada} carregando={carregando} />;
  } else if (view === "projetos") {
    conteudo = <ProjectsView />;
  } else if (view === "kanban") {
    conteudo = <KanbanView />;
  } else if (view === "agenda") {
    conteudo = <AgendaView />;
  }

  return (
    <div className={styles.casca}>
      <div className={styles.area}>
        {mostrarSidebar && (
          <Sidebar
            ehMobile={ehMobile}
            rota={rota}
            navegar={navegar}
            busca={busca}
            onBusca={setBusca}
            filtro={filtro}
            onFiltro={setFiltro}
            entries={entries}
            carregando={carregando}
          />
        )}

        {mostrarPainel && (
          <main className={styles.painel}>
            {view !== "home" && (
              <TopBar
                ehMobile={ehMobile}
                rota={rota}
                navegar={navegar}
                entrada={entradaDaLista}
                anteriorId={idx > 0 ? entries[idx - 1].id : null}
                proximaId={idx >= 0 && idx < entries.length - 1 ? entries[idx + 1].id : null}
              />
            )}
            <div ref={conteudoRef} className={styles.conteudo}>
              {conteudo}
            </div>
            {mostrarCaptura && <InputBar onCreated={aoCriar} bordered />}
          </main>
        )}
      </div>

      {ehMobile && <MobileNav rota={rota} navegar={navegar} />}

      {/* O mesmo texto do Cancelar do EditForm: é a mesma perda, por outra porta. */}
      <ConfirmDialog
        open={saidaPendente}
        tone="danger"
        title="Descartar as alterações?"
        description="O que você mudou nesta entrada ainda não foi salvo."
        confirmLabel="Descartar"
        cancelLabel="Continuar editando"
        onConfirm={confirmarSaida}
        onCancel={ficar}
      />
    </div>
  );
}
