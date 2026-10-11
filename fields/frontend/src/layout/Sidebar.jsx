import { useState } from "react";
import { Button, Icon, IconButton, Logo } from "../ui/index.js";
import { EntryList } from "../entries/EntryList.jsx";
import { ehLingua } from "../components/tipoEntrada.js";
import { useOntologia } from "../lib/ontologia.js";
import { formatHash } from "../lib/useHashRoute.js";
import { VISTAS, vistaAtiva } from "./vistas.js";
import styles from "./Sidebar.module.css";

/**
 * Barra lateral: marca, as vistas (desktop), busca, filtros de tipo e a lista de entradas. No
 * celular ela É a tela de #/notas (largura cheia) e as vistas ficam na MobileNav. Os filtros de
 * tipo vêm da ontologia (enums.tipo_entrada): os de língua (lang_*) formam o submenu "Línguas".
 * "all" e "pinned" são parâmetros do GET /api/entries, não valores de enum.
 *
 * As vistas são <a href="#/…">: navegação é link (abre em outra aba, o leitor de tela anuncia
 * "link, página atual"). A rota por hash (lib/useHashRoute.js) pega o hashchange.
 */
export function Sidebar({ ehMobile, rota, navegar, busca, onBusca, filtro, onFiltro, entries, carregando }) {
  const { enums, rotulo } = useOntologia();
  const [showLangMenu, setShowLangMenu] = useState(false);
  const linguas = enums.tipo_entrada.filter(ehLingua);
  const filtros = [
    { key: "all", label: "Tudo" },
    ...enums.tipo_entrada.filter((t) => !ehLingua(t)).map((t) => ({ key: t, label: rotulo("tipo_entrada", t) })),
    { key: "pinned", label: "Fixados", icone: "pin" },
  ];
  const isLang = linguas.includes(filtro);
  const linguasAbertas = showLangMenu || isLang;
  const ativaId = rota.view === "notas" ? rota.id : null;

  // Botão de filtro: o primitivo Button (ghost, sm) com aria-pressed; o "ligado" é do CSS.
  const filtroBtn = (key, label, aoClicar, icone) => (
    <Button
      key={key}
      variant="ghost"
      size="sm"
      aria-pressed={filtro === key}
      className={`${styles.chip} ${filtro === key ? styles.chipLigado : ""}`}
      icon={icone ? <Icon name={icone} size={12} /> : undefined}
      onClick={aoClicar}
    >
      {label}
    </Button>
  );

  const Raiz = ehMobile ? "section" : "aside";

  return (
    <Raiz className={`${styles.barra} ${ehMobile ? styles.cheia : ""}`} aria-label={ehMobile ? "Notas" : "Barra lateral"}>
      <div className={styles.marca}>
        <Logo size={20} className={styles.logo} />
        <span className={styles.nome}>Fields'</span>
        {ehMobile && (
          <IconButton aria-label="Ver as notas em cards" className={styles.marcaAcao} onClick={() => navegar({ view: "cards" })}>
            <Icon name="grid" />
          </IconButton>
        )}
      </div>

      {!ehMobile && (
        <nav aria-label="Vistas" className={styles.nav}>
          {VISTAS.map(({ view, icone, label }) => (
            <a
              key={view}
              href={formatHash({ view })}
              className={styles.link}
              aria-current={vistaAtiva(rota, view) ? "page" : undefined}
            >
              <Icon name={icone} className={styles.linkIcone} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
      )}

      <div className={styles.ferramentas}>
        <div className={styles.busca}>
          <Icon name="search" size={14} className={styles.lupa} />
          <input
            type="search"
            aria-label="Buscar entradas"
            value={busca}
            onChange={e => onBusca(e.target.value)}
            placeholder="Buscar…"
            className={styles.campoBusca}
          />
        </div>

        <div role="group" aria-label="Filtrar por tipo" className={styles.filtros}>
          {filtros.map(f => filtroBtn(f.key, f.label, () => { onFiltro(f.key); setShowLangMenu(false); }, f.icone))}
          {linguas.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={linguasAbertas}
              className={`${styles.chip} ${isLang ? styles.chipLigado : ""}`}
              iconRight={<Icon name="chevron-down" size={12} className={`${styles.seta} ${linguasAbertas ? styles.setaAberta : ""}`} />}
              onClick={() => { setShowLangMenu(v => !v); if (!isLang) onFiltro("all"); }}
            >
              Línguas
            </Button>
          )}
        </div>
        {linguasAbertas && (
          <div role="group" aria-label="Línguas" className={styles.filtros}>
            {linguas.map(l => filtroBtn(l, rotulo("tipo_entrada", l), () => { onFiltro(l); setShowLangMenu(true); }))}
          </div>
        )}
      </div>

      <EntryList
        entries={entries}
        carregando={carregando}
        ativaId={ativaId}
        onOpen={(e) => navegar({ view: "notas", id: e.id })}
      />
    </Raiz>
  );
}
