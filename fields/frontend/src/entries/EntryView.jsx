import { useId } from "react";
import { CommentThread } from "../components/CommentThread.jsx";
import { TipoBadge } from "../components/TipoBadge.jsx";
import { dataCurta, ehDataISO } from "../lib/dates.js";
import { useEhMobile } from "../lib/useEhMobile.js";
import { useOntologia } from "../lib/ontologia.js";
import { Badge, Button, Icon, SectionLabel } from "../ui/index.js";
import { descreverData } from "./datas.js";
import { EntradaLink } from "./EntradaLink.jsx";
import { IconeDoTipo } from "./IconeDoTipo.jsx";
import css from "./EntryView.module.css";

function tagsDe(entry) {
  return Array.isArray(entry.tags) ? entry.tags.filter((t) => t != null && t !== "") : [];
}

/**
 * Uma entrada aberta, para LER: título e corpo em Lora, a data em dd/mm (São Paulo), as tags, as
 * relacionadas (links — no monólito eram texto morto) e as anotações.
 *
 * As anotações são um CommentThread (ENTRADA) com "vincular à tarefa" — cada anotação vinculada
 * vira um POST de comentário na tarefa, não um PATCH do array dela. O `key` remonta o fio a cada
 * entrada: um POST ainda em voo da entrada anterior responde ao fio (e ao id) dela, nunca a esta.
 *
 *   onThreadsChange(id, threads)  o array legado confirmado, com o id da entrada a que pertence
 *   onOpenRelated(entrada)        abrir uma relacionada
 *   editarRef                     o botão Editar, para a página devolver o foco ao sair da edição
 */
export function EntryView({ entry, related, editarRef, onEdit, onPin, onDelete, onThreadsChange, onOpenRelated }) {
  const { rotulo } = useOntologia();
  // No celular os botões sobem para md (36px): o sm (28px) fica pequeno demais para o dedo.
  const tamanho = useEhMobile() ? "md" : "sm";
  const relacionadasId = useId();
  const tags = tagsDe(entry);
  const quando = descreverData(entry.date, entry.time);
  const relacionadas = Array.isArray(related) ? related : [];

  return (
    <article className={css.pagina}>
      <div className={css.cabecalho}>
        <div className={css.tipo}>
          <TipoBadge tipo={entry.type} />
          {entry.pinned && <Icon name="pin" size={14} title="Fixada" className={css.pino} />}
        </div>
        <div className={css.acoes}>
          <Button ref={editarRef} variant="ghost" size={tamanho} icon={<Icon name="pencil" size={14} />} onClick={onEdit}>
            Editar
          </Button>
          <Button
            variant="ghost"
            size={tamanho}
            icon={<Icon name="pin" size={14} />}
            aria-pressed={Boolean(entry.pinned)}
            className={css.fixar}
            onClick={onPin}
          >
            Fixar
          </Button>
          <Button variant="ghost" size={tamanho} icon={<Icon name="trash" size={14} />} className={css.excluir} onClick={onDelete}>
            Excluir
          </Button>
        </div>
      </div>

      <h1 className={entry.title ? css.titulo : `${css.titulo} ${css.semTitulo}`}>{entry.title || "Sem título"}</h1>

      {quando && (
        <p className={css.meta}>
          {ehDataISO(entry.date) ? <time dateTime={entry.date}>{quando}</time> : quando}
        </p>
      )}

      {entry.content && <div className={css.corpo}>{entry.content}</div>}

      {tags.length > 0 && (
        <ul className={css.tags} aria-label="Tags">
          {tags.map((t, i) => (
            <li key={`${i}:${t}`}>
              <Badge tone="neutral">#{t}</Badge>
            </li>
          ))}
        </ul>
      )}

      {relacionadas.length > 0 && (
        <section className={css.relacionadas} aria-labelledby={relacionadasId}>
          <SectionLabel id={relacionadasId}>Relacionadas por tags</SectionLabel>
          <ul className={css.listaRelacionadas}>
            {relacionadas.map((r) => (
              <li key={r.id}>
                <EntradaLink entrada={r} onOpen={onOpenRelated} className={css.relacionada}>
                  <IconeDoTipo tipo={r.type} size={14} className={css.relacionadaIcone} />
                  <span className="sr-only">{rotulo("tipo_entrada", r.type) || "Entrada"}: </span>
                  <span className={css.relacionadaTitulo}>{r.title || "Sem título"}</span>
                  {r.date && (
                    <time className={css.relacionadaData} dateTime={ehDataISO(r.date) ? r.date : undefined}>
                      {dataCurta(r.date)}
                    </time>
                  )}
                </EntradaLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={css.anotacoes}>
        <CommentThread
          key={entry.id}
          alvo={{ tipo: "ENTRADA", id: entry.id }}
          legado={entry.threads}
          onChange={(threads) => onThreadsChange(entry.id, threads)}
          vincularTarefa
          nivelTitulo={2}
          titulo="Anotações"
          rotuloCampo="Nova anotação"
          vazio="Nenhuma anotação ainda. Adicione pensamentos, atualizações ou contexto abaixo."
          placeholder="Adicionar anotação… (Enter envia, Shift+Enter quebra linha)"
        />
      </div>
    </article>
  );
}
