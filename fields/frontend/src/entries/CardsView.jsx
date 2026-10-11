import { Badge, EmptyState, Icon, SectionLabel, Spinner } from "../ui/index.js";
import { TipoBadge } from "../components/TipoBadge.jsx";
import { ehDataISO } from "../lib/dates.js";
import { dataRelativa } from "./datas.js";
import { EntradaLink } from "./EntradaLink.jsx";
import css from "./CardsView.module.css";

function tagsDe(entry) {
  return Array.isArray(entry.tags) ? entry.tags.filter((t) => t != null && t !== "") : [];
}

// Um cartão. O link é só o TÍTULO (o nome acessível fica curto: "Reunião com a banca", e não o
// cartão inteiro lido de uma vez); um ::after estica a área clicável sobre o cartão todo, e o anel
// de foco é desenhado nele. Hover é CSS.
function Cartao({ entry, onOpen }) {
  const tags = tagsDe(entry);
  const anotacoes = Array.isArray(entry.threads) ? entry.threads.length : 0;
  const quando = dataRelativa(entry.date);
  return (
    <li className={css.cartao}>
      <div className={css.topo}>
        <TipoBadge tipo={entry.type} />
        {entry.pinned && <Icon name="pin" size={14} title="Fixada" className={css.pino} />}
      </div>

      <h2 className={css.titulo}>
        <EntradaLink entrada={entry} onOpen={onOpen} className={css.link}>
          {entry.title || "Sem título"}
        </EntradaLink>
      </h2>

      {entry.content && <p className={css.previa}>{entry.content}</p>}

      {tags.length > 0 && (
        <ul className={css.tags} aria-label="Tags">
          {tags.map((t, i) => (
            <li key={`${i}:${t}`}>
              <Badge tone="neutral">#{t}</Badge>
            </li>
          ))}
        </ul>
      )}

      {(quando || anotacoes > 0) && (
        <div className={css.rodape}>
          {quando && <time dateTime={ehDataISO(entry.date) ? entry.date : undefined}>{quando}</time>}
          {anotacoes > 0 && (
            <span className={css.anotacoes}>
              <Icon name="message" size={12} />
              {anotacoes}
              <span className="sr-only">{anotacoes === 1 ? " anotação" : " anotações"}</span>
            </span>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * As entradas em cartões, numa grade em ordem de leitura (linha a linha, como a lista). Rota
 * #/cards. `carregando` (opcional) evita o "nenhuma entrada" piscar antes da primeira carga.
 */
export function CardsView({ entries, onOpen, carregando = false }) {
  if (entries.length === 0) {
    return (
      <div className={css.pagina}>
        {carregando ? (
          <div className={css.carregando}>
            <Spinner size={20} label="Carregando entradas" />
          </div>
        ) : (
          <EmptyState
            icon="grid"
            title="Nenhuma entrada para exibir"
            description="O filtro e a busca da lista de notas também valem aqui."
          />
        )}
      </div>
    );
  }

  return (
    <div className={css.pagina}>
      <SectionLabel as="h1" className={css.cabecalho}>
        {entries.length} {entries.length === 1 ? "entrada" : "entradas"}
      </SectionLabel>
      <ul className={css.grade}>
        {entries.map((entry) => (
          <Cartao key={entry.id} entry={entry} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
}
