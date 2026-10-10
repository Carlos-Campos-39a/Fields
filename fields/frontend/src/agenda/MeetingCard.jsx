import { useId, useState } from "react";
import { CommentThread } from "../components/CommentThread.jsx";
import { Icon, IconButton } from "../ui/index.js";
import { useEhMobile } from "../lib/useEhMobile.js";
import styles from "./MeetingCard.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");

// "14:00" ou "14:00:00" → "14:00". Outro formato volta como veio: é dado do Carlos.
const hora = (t) => (/^\d{2}:\d{2}/.test(t ?? "") ? t.slice(0, 5) : t || "");

function horario({ startTime, endTime }) {
  const ini = hora(startTime);
  const fim = hora(endTime);
  if (ini && fim) return `${ini} – ${fim}`;
  if (ini) return ini;
  if (fim) return `até ${fim}`;
  return "";
}

/**
 * Uma reunião na coluna do dia: o cabeçalho abre e fecha; aberta, mostra as notas (um
 * CommentThread REUNIAO POR REUNIÃO — no monólito um único commentRef servia a todas, e o campo de
 * uma reunião aberta escrevia no estado de outra) e o Must.
 *
 * O Must tem UM onBlur (o monólito declarava dois na mesma textarea; o segundo calava o primeiro).
 * `onSalvarMust(texto)` devolve uma promessa de true/false: se falhar, o pai já devolveu o Must
 * antigo à reunião (rollback + toast) e o texto digitado volta para a caixa, para não se perder.
 */
export function MeetingCard({ meeting, hoje, expandida, onAlternar, onExcluir, onComentarios, onSalvarMust }) {
  const [mustDraft, setMustDraft] = useState(null); // null = sem edição em curso
  const mustVal = mustDraft ?? meeting.must ?? "";
  const tamanho = useEhMobile() ? "md" : "sm";
  const base = useId();
  const tituloId = `${base}-titulo`;
  const painelId = `${base}-painel`;
  const mustId = `${base}-must`;

  const quando = horario(meeting);
  const temMust = Boolean(meeting.must?.trim());
  const nNotas = Array.isArray(meeting.comments) ? meeting.comments.length : 0;

  async function salvarMust() {
    if (mustDraft === null) return;
    const val = mustDraft;
    setMustDraft(null);
    if (val === (meeting.must || "")) return;
    const ok = await onSalvarMust(val);
    // Se o Carlos já voltou a digitar, o rascunho novo é o que vale.
    if (!ok) setMustDraft((atual) => atual ?? val);
  }

  return (
    <article className={cx(styles.cartao, expandida && styles.aberto)} aria-labelledby={tituloId}>
      <div className={styles.cabecalho}>
        <button
          type="button"
          className={styles.alternar}
          onClick={onAlternar}
          aria-expanded={expandida}
          aria-controls={painelId}
        >
          {quando && <span className={cx(styles.horario, hoje && styles.horarioHoje)}>{quando}</span>}
          <span id={tituloId} className={styles.titulo}>
            {meeting.title}
          </span>
          {!expandida && temMust && (
            <span className={styles.mustPrevia}>
              <Icon name="flag" size={12} className={styles.iconeMust} />
              <span className="sr-only">Must: </span>
              <span className={styles.mustTexto}>{meeting.must}</span>
            </span>
          )}
          {!expandida && nNotas > 0 && (
            <span className={styles.metaItem}>
              <Icon name="message" size={12} />
              {nNotas}
              <span className="sr-only"> {nNotas === 1 ? "nota" : "notas"}</span>
            </span>
          )}
        </button>
        <IconButton size={tamanho} tone="danger" aria-label={`Excluir a reunião “${meeting.title}”`} title="Excluir reunião" onClick={onExcluir}>
          <Icon name="trash" />
        </IconButton>
      </div>

      {expandida && (
        <div id={painelId} className={styles.painel}>
          <div className={styles.secaoNotas}>
            <CommentThread
              alvo={{ tipo: "REUNIAO", id: meeting.id }}
              legado={meeting.comments}
              onChange={onComentarios}
              compacto
              nivelTitulo={4}
              titulo="Notas"
              vazio="Nenhuma nota ainda."
              placeholder="Adicionar nota… (Enter envia)"
              rotuloCampo="Nova nota da reunião"
            />
          </div>

          <div className={styles.secaoMust}>
            <label htmlFor={mustId} className={styles.rotuloMust}>
              <Icon name="flag" size={12} className={styles.iconeMust} />
              Must
            </label>
            <textarea
              id={mustId}
              className={styles.campoMust}
              value={mustVal}
              onChange={(e) => setMustDraft(e.target.value)}
              onBlur={salvarMust}
              placeholder="O que é essencial nessa reunião…"
              rows={3}
            />
          </div>
        </div>
      )}
    </article>
  );
}
