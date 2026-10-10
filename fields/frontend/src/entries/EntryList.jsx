import { Icon, Spinner } from "../ui/index.js";
import { useOntologia } from "../lib/ontologia.js";
import { ehDataISO } from "../lib/dates.js";
import { dataRelativa } from "./datas.js";
import { EntradaLink } from "./EntradaLink.jsx";
import { IconeDoTipo } from "./IconeDoTipo.jsx";
import css from "./EntryList.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");

// A prévia é uma linha com reticências pelo CSS; o corte aqui só evita pôr no DOM a nota inteira
// de cada linha da lista.
const TAMANHO_DA_PREVIA = 120;

function previa(conteudo) {
  return String(conteudo ?? "").slice(0, TAMANHO_DA_PREVIA).replace(/\s+/g, " ").trim();
}

// A lista de entradas da barra lateral (era o SidebarItem do App.jsx). O Sidebar (layout/) a
// monta; o estilo é da pasta entries/. Hover e ativa são CSS, sem handler de mouse.
function EntryItem({ entry, active, onOpen }) {
  const { rotulo } = useOntologia();
  const quando = dataRelativa(entry.date);
  return (
    <li>
      <EntradaLink
        entrada={entry}
        onOpen={onOpen}
        aria-current={active ? "page" : undefined}
        className={cx(css.link, active && css.ativa)}
      >
        <span className={css.linha}>
          <IconeDoTipo tipo={entry.type} size={14} className={css.icone} />
          <span className="sr-only">{rotulo("tipo_entrada", entry.type) || "Entrada"}: </span>
          <span className={cx(css.titulo, !entry.title && css.semTitulo)}>{entry.title || "Sem título"}</span>
          {entry.pinned && <Icon name="pin" size={12} title="Fixada" className={css.pino} />}
        </span>
        <span className={css.detalhe}>
          <span className={css.previa}>{previa(entry.content)}</span>
          {quando && (
            <time className={css.data} dateTime={ehDataISO(entry.date) ? entry.date : undefined}>
              {quando}
            </time>
          )}
        </span>
      </EntradaLink>
    </li>
  );
}

/** entries = a lista já filtrada (shell); ativaId = a entrada aberta na rota; onOpen(entry). */
export function EntryList({ entries, carregando, ativaId, onOpen }) {
  const vazia = entries.length === 0;
  return (
    <div className={css.lista}>
      {carregando && vazia && (
        <div className={css.estado}>
          <Spinner size={16} label="Carregando entradas" />
        </div>
      )}
      {!carregando && vazia && (
        <p className={css.estado}>Nenhuma entrada encontrada.</p>
      )}
      {!vazia && (
        <ul className={css.itens} aria-label="Entradas">
          {entries.map((e) => (
            <EntryItem key={e.id} entry={e} active={ativaId === e.id} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}
