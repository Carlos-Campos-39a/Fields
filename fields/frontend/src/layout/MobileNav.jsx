import { useId, useLayoutEffect, useRef, useState } from "react";
import { Icon, Popover, PopoverItem, SectionLabel } from "../ui/index.js";
import { useSair } from "../auth/useSair.js";
import { formatHash } from "../lib/useHashRoute.js";
import { useTema } from "../theme/useTema.js";
import { OpcoesDeTema } from "./ThemeToggle.jsx";
import { VISTAS, vistaAtiva } from "./vistas.js";
import styles from "./MobileNav.module.css";

// A variável que a região de toasts (ui/Toast) pode somar ao próprio `bottom` para não cobrir
// esta barra. Vale só enquanto a barra está montada; fora do celular ela não existe.
const VAR_ALTURA = "--altura-barra-inferior";

/**
 * Barra inferior do celular (< 768px): as cinco vistas a um toque, mais o "Mais" com Cards, tema
 * e Sair. No monólito o celular escondia Projetos, Agenda, Kanban, Cards, Home e Sair
 * (showSidebar/showMain): a barra lateral só aparecia sem entrada aberta, e o topo com os
 * botões só com uma. É o mínimo da R2; a barra de verdade (gestos, kanban com snap) é da R4.
 */
export function MobileNav({ rota, navegar }) {
  const { preferencia, setPreferencia } = useTema();
  const { sair, saindo } = useSair();
  const [maisAberto, setMaisAberto] = useState(false);
  const barraRef = useRef(null);
  const maisRef = useRef(null);
  const menuId = useId();

  // Publica a altura real (com a área segura do iPhone) para quem é fixo no rodapé.
  useLayoutEffect(() => {
    const barra = barraRef.current;
    if (!barra) return undefined;
    const raiz = document.documentElement;
    const publicar = () => raiz.style.setProperty(VAR_ALTURA, `${barra.offsetHeight}px`);
    publicar();
    const observador = typeof ResizeObserver !== "undefined" ? new ResizeObserver(publicar) : null;
    observador?.observe(barra);
    return () => {
      observador?.disconnect();
      raiz.style.removeProperty(VAR_ALTURA);
    };
  }, []);

  const fechar = () => setMaisAberto(false);

  return (
    <nav ref={barraRef} className={styles.barra} aria-label="Navegação principal">
      {VISTAS.map(({ view, icone, label }) => (
        <a
          key={view}
          href={formatHash({ view })}
          className={styles.item}
          aria-current={vistaAtiva(rota, view) ? "page" : undefined}
        >
          <Icon name={icone} size={20} className={styles.icone} />
          <span className={styles.rotulo}>{label}</span>
        </a>
      ))}

      <button
        ref={maisRef}
        type="button"
        className={styles.item}
        aria-haspopup="dialog"
        aria-expanded={maisAberto}
        aria-controls={menuId}
        onClick={() => setMaisAberto((v) => !v)}
      >
        <Icon name="more" size={20} className={styles.icone} />
        <span className={styles.rotulo}>Mais</span>
      </button>

      <Popover
        id={menuId}
        open={maisAberto}
        onClose={fechar}
        anchorRef={maisRef}
        side="top"
        align="end"
        label="Mais opções"
        width={220}
      >
        <PopoverItem
          icon={<Icon name="grid" />}
          selected={rota.view === "cards"}
          onClick={() => {
            fechar();
            navegar({ view: "cards" });
          }}
        >
          Notas em cards
        </PopoverItem>
        <hr className={styles.divisor} />
        <SectionLabel as="div" className={styles.secao}>Tema</SectionLabel>
        <OpcoesDeTema
          preferencia={preferencia}
          aoEscolher={(valor) => {
            setPreferencia(valor);
            fechar();
          }}
        />
        <hr className={styles.divisor} />
        <PopoverItem
          icon={<Icon name="log-out" />}
          disabled={saindo}
          onClick={() => {
            fechar();
            sair();
          }}
        >
          Sair
        </PopoverItem>
      </Popover>
    </nav>
  );
}
