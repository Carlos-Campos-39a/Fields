import { Button, Icon, IconButton } from "../ui/index.js";
import { useSair } from "../auth/useSair.js";
import { ThemeToggle } from "./ThemeToggle.jsx";
import styles from "./TopBar.module.css";

// O nome de cada vista no topo. #/cards são as mesmas notas em outra exibição.
const TITULO = Object.freeze({ notas: "Notas", cards: "Notas", projetos: "Projetos", kanban: "Kanban", agenda: "Agenda" });

/**
 * Barra do topo do painel principal: o nome da vista (e, com uma entrada aberta, o título dela e
 * anterior/próxima na lista), o seletor Lista/Cards das notas, o tema e o Sair.
 * No celular: voltar à lista quando há entrada aberta; tema, Cards e Sair ficam no "Mais" da
 * MobileNav — repetir aqui espremia o título.
 * `entrada` é a linha da lista da entrada aberta (pode faltar: entrada fora do filtro atual).
 */
export function TopBar({ ehMobile, rota, navegar, entrada, anteriorId, proximaId }) {
  const { sair, saindo } = useSair();
  const entradaAberta = rota.view === "notas" && Boolean(rota.id);
  const emCards = rota.view === "cards";
  const mostrarExibicao = (rota.view === "notas" || emCards) && !(ehMobile && entradaAberta);
  const tituloDaEntrada = entrada?.title?.trim() || "";

  return (
    <header className={styles.barra}>
      {ehMobile && entradaAberta && (
        <IconButton aria-label="Voltar para a lista" onClick={() => navegar({ view: "notas" })}>
          <Icon name="chevron-left" />
        </IconButton>
      )}

      <div className={styles.titulo}>
        {ehMobile && entradaAberta ? (
          <span className={styles.vista}>{tituloDaEntrada || "Notas"}</span>
        ) : (
          <span className={styles.vista}>{TITULO[rota.view] ?? "Fields'"}</span>
        )}
        {!ehMobile && entradaAberta && tituloDaEntrada && (
          <>
            <Icon name="chevron-right" size={14} className={styles.separador} />
            <span className={styles.entrada}>{tituloDaEntrada}</span>
          </>
        )}
      </div>

      {mostrarExibicao && (
        <div role="group" aria-label="Exibição das notas" className={styles.exibicao}>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={!emCards}
            className={styles.opcao}
            icon={<Icon name="note" size={14} />}
            onClick={() => { if (emCards) navegar({ view: "notas" }); }}
          >
            Lista
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={emCards}
            className={styles.opcao}
            icon={<Icon name="grid" size={14} />}
            onClick={() => { if (!emCards) navegar({ view: "cards" }); }}
          >
            Cards
          </Button>
        </div>
      )}

      {entradaAberta && (
        <div className={styles.passos}>
          <IconButton
            aria-label="Entrada anterior"
            disabled={!anteriorId}
            onClick={() => anteriorId && navegar({ view: "notas", id: anteriorId })}
          >
            <Icon name="chevron-left" />
          </IconButton>
          <IconButton
            aria-label="Próxima entrada"
            disabled={!proximaId}
            onClick={() => proximaId && navegar({ view: "notas", id: proximaId })}
          >
            <Icon name="chevron-right" />
          </IconButton>
        </div>
      )}

      {!ehMobile && (
        <div className={styles.conta}>
          <ThemeToggle />
          <Button variant="ghost" size="sm" icon={<Icon name="log-out" size={14} />} loading={saindo} onClick={sair}>
            Sair
          </Button>
        </div>
      )}
    </header>
  );
}
