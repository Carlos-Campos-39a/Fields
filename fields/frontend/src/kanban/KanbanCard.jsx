import { useEffect, useId, useRef, useState } from "react";
import { Badge, Icon, IconButton, Popover, PopoverItem, SectionLabel, StatusBadge } from "../ui/index.js";
import { ehColunaFeita, useOntologia } from "../lib/ontologia.js";
import { useEhMobile } from "../lib/useEhMobile.js";
import { diferencaEmDias, ehDataISO, formatarDiaMes, hojeISO } from "../lib/dates.js";
import styles from "./KanbanCard.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");

// O <input type="date"> só aceita "YYYY-MM-DD". Um prazo legado em texto livre ("sexta") deixaria o
// campo vazio E faria o navegador reclamar no console a cada render; então o campo recebe "" e o
// texto aparece embaixo, como dica. Ele só é trocado se o Carlos escolher uma data.
const valorDoCampo = (v) => (ehDataISO(v) ? v : "");

/**
 * Um campo de data do cartão. Controlado com rascunho: o valor da TAREFA manda, e o rascunho só
 * existe durante a edição. Grava no blur (ou Enter), não no onChange — digitar o ano dígito a dígito
 * dispara um change por dígito ("0002", "0020"…), e cada um seria um PATCH com uma data absurda.
 * Se a gravação falhar, o pai devolve o valor antigo à tarefa e o campo, sem rascunho, mostra ele.
 */
function CampoData({ id, rotulo, valor, onSalvar }) {
  const [rascunho, setRascunho] = useState(null); // null = sem edição em curso
  const atual = valorDoCampo(valor);
  const legado = valor && !ehDataISO(valor) ? String(valor) : null;

  function confirmar() {
    if (rascunho === null) return;
    const novo = rascunho;
    setRascunho(null);
    if (novo !== atual) onSalvar(novo || null);
  }

  return (
    <div className={styles.campo}>
      <label htmlFor={id} className={styles.rotuloCampo}>
        {rotulo}
      </label>
      <input
        id={id}
        type="date"
        className={styles.data}
        value={rascunho ?? atual}
        onChange={(e) => setRascunho(e.target.value)}
        onBlur={confirmar}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {legado && <span className={styles.dica}>Hoje está como “{legado}”</span>}
    </div>
  );
}

/** As datas do rodapé em dd/mm (eram o ISO cru). Prazo vencido sai em --danger E com ícone e texto. */
function Datas({ inicio, prazo, vencido }) {
  if (!inicio && !prazo) return null;
  const textoPrazo = (
    <span className={cx(styles.prazo, vencido && styles.vencido)} title={vencido ? "Prazo vencido" : "Prazo"}>
      {vencido && <Icon name="alert" size={12} />}
      {formatarDiaMes(prazo)}
      {vencido && <span className="sr-only"> (vencido)</span>}
    </span>
  );
  return (
    <span className={styles.metaItem}>
      <Icon name="calendar" size={12} />
      {inicio && prazo ? (
        <>
          <span className="sr-only">Início </span>
          <span title="Início">{formatarDiaMes(inicio)}</span>
          <span aria-hidden="true">–</span>
          <span className="sr-only"> prazo </span>
          {textoPrazo}
        </>
      ) : inicio ? (
        <>
          <span className={styles.prefixo}>Início</span>
          <span>{formatarDiaMes(inicio)}</span>
        </>
      ) : (
        <>
          <span className={styles.prefixo}>Prazo</span>
          {textoPrazo}
        </>
      )}
    </span>
  );
}

/**
 * Cartão de tarefa no kanban.
 * - "Mover para" é um Popover (o mesmo do resto do app) aberto pelo botão ⋯: é o caminho sem
 *   arrastar — teclado e toque. O arrastar (HTML5) só existe no desktop: no celular ele brigaria com
 *   a rolagem horizontal das colunas, e o toque não o dispara mesmo.
 * - As datas abrem num editor dentro do cartão (botão de calendário). Os <input type="date">
 *   seguem o tema pelo color-scheme dos tokens: o esquema escuro forçado do monólito saiu.
 * - Hover, borda e cor são do CSS (KanbanCard.module.css), sem handler de mouse no JS.
 * - `focar`: o cartão acabou de chegar a outra coluna pelo menu. Ele remonta lá (outra lista), e o
 *   foco, que estava no menu do cartão antigo, ficaria órfão no <body>; aqui ele volta para o ⋯.
 */
export function KanbanCard({
  task,
  coluna,
  arrastavel = true,
  arrastando = false,
  focar = false,
  onFocado,
  onDragStart,
  onDragEnd,
  onMove,
  onSaveField,
}) {
  const { enums, rotulo } = useOntologia();
  const tamanho = useEhMobile() ? "md" : "sm"; // no celular, alvo maior para o dedo
  const [menuAberto, setMenuAberto] = useState(false);
  const [editando, setEditando] = useState(false);
  const menuRef = useRef(null);
  const base = useId();
  const tituloId = `${base}-titulo`;
  const menuId = `${base}-menu`;
  const editorId = `${base}-datas`;

  const feito = ehColunaFeita(coluna);
  const vencido = !feito && ehDataISO(task.deadline) && diferencaEmDias(hojeISO(), task.deadline) < 0;
  const nComentarios = Array.isArray(task.comments) ? task.comments.length : 0;
  // Com o editor de datas aberto o cartão deixa de ser arrastável: no Firefox um campo dentro de um
  // elemento draggable não recebe o clique que posiciona o cursor.
  const podeArrastar = arrastavel && !editando;

  useEffect(() => {
    if (!focar) return;
    menuRef.current?.focus({ preventScroll: true });
    onFocado?.();
  }, [focar, onFocado]);

  return (
    <article
      className={cx(styles.cartao, feito && styles.feito, arrastando && styles.arrastando)}
      aria-labelledby={tituloId}
      draggable={podeArrastar || undefined}
      onDragStart={podeArrastar ? onDragStart : undefined}
      onDragEnd={podeArrastar ? onDragEnd : undefined}
    >
      <h4 id={tituloId} className={styles.titulo}>
        {task.name || "Sem nome"}
        {feito && <span className="sr-only"> (feita)</span>}
      </h4>

      {(task.frenteName || task.stakeholder) && (
        <div className={styles.chips}>
          {task.frenteName && (
            <Badge className={styles.chip} title={`Frente: ${task.frenteName}`}>
              <span className={styles.chipTexto}>{task.frenteName}</span>
            </Badge>
          )}
          {task.stakeholder && (
            <Badge variant="outline" className={styles.chip} title={`Stakeholder: ${task.stakeholder}`}>
              <span className={styles.chipTexto}>{task.stakeholder}</span>
            </Badge>
          )}
        </div>
      )}

      <div className={styles.rodape}>
        <div className={styles.meta}>
          <Datas inicio={task.startDate} prazo={task.deadline} vencido={vencido} />
          {nComentarios > 0 && (
            <span className={styles.metaItem} title={`${nComentarios} ${nComentarios === 1 ? "comentário" : "comentários"}`}>
              <Icon name="message" size={12} />
              {nComentarios}
              <span className="sr-only"> {nComentarios === 1 ? "comentário" : "comentários"}</span>
            </span>
          )}
        </div>
        <div className={styles.acoes}>
          <IconButton
            size={tamanho}
            aria-label="Editar datas"
            aria-expanded={editando}
            aria-controls={editorId}
            active={editando}
            onClick={() => setEditando((v) => !v)}
          >
            <Icon name="calendar" />
          </IconButton>
          <IconButton
            ref={menuRef}
            size={tamanho}
            aria-label="Mover para…"
            aria-haspopup="dialog"
            aria-expanded={menuAberto}
            aria-controls={menuId}
            active={menuAberto}
            onClick={() => setMenuAberto((v) => !v)}
          >
            <Icon name="more" />
          </IconButton>
        </div>
      </div>

      {editando && (
        <div id={editorId} className={styles.editor}>
          <CampoData
            id={`${base}-inicio`}
            rotulo="Início"
            valor={task.startDate}
            onSalvar={(v) => onSaveField("start_date", v)}
          />
          <CampoData
            id={`${base}-prazo`}
            rotulo="Prazo"
            valor={task.deadline}
            onSalvar={(v) => onSaveField("deadline", v)}
          />
        </div>
      )}

      <Popover
        id={menuId}
        open={menuAberto}
        onClose={() => setMenuAberto(false)}
        anchorRef={menuRef}
        label="Mover para"
        align="end"
        className={styles.menu}
      >
        <SectionLabel as="p" className={styles.menuTitulo}>
          Mover para
        </SectionLabel>
        {enums.kanban.map((c) => (
          <PopoverItem
            key={c}
            className={styles.menuItem}
            selected={c === coluna}
            onClick={() => {
              setMenuAberto(false);
              if (c !== coluna) onMove(c);
            }}
          >
            <StatusBadge value={c} label={rotulo("kanban", c)} />
          </PopoverItem>
        ))}
      </Popover>
    </article>
  );
}
