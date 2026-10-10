import { useId, useRef, useState } from "react";
import { Icon, Popover } from "../ui/index.js";
import { CommentThread } from "../components/CommentThread.jsx";
import styles from "./Celulas.module.css";

/**
 * O balão de comentários de uma tarefa (era o TaskCommentBubble): o contador abre o Popover único
 * com um CommentThread (TAREFA). `onChange(comments)` devolve o array legado atualizado, e o
 * contador da linha acompanha sem recarregar os projetos.
 */
export function TaskComments({ task, onChange }) {
  const [aberto, setAberto] = useState(false);
  const ancora = useRef(null);
  const campo = useRef(null);
  const id = useId();
  const count = task.comments?.length ?? 0;
  const rotulo = count === 0 ? "Comentários" : count === 1 ? "1 comentário" : `${count} comentários`;

  return (
    <>
      <button
        ref={ancora}
        type="button"
        className={styles.comentarios}
        data-tem={count > 0 ? "sim" : "nao"}
        aria-haspopup="dialog"
        aria-expanded={aberto}
        aria-controls={aberto ? id : undefined}
        aria-label={rotulo}
        title={rotulo}
        onClick={(e) => {
          e.stopPropagation();
          setAberto((v) => !v);
        }}
      >
        <Icon name="message" size={14} className={styles.comentariosIcone} />
        {count > 0 && <span aria-hidden="true">{count}</span>}
      </button>
      <Popover id={id} open={aberto} onClose={() => setAberto(false)} anchorRef={ancora}
        label={`Comentários da tarefa ${task.name || ""}`.trim()} width={320} initialFocus={campo}>
        <div className={styles.fioComentarios}>
          <CommentThread
            alvo={{ tipo: "TAREFA", id: task.id }}
            legado={task.comments}
            onChange={onChange}
            compacto
            inputRef={campo}
            placeholder="Adicionar comentário… (Enter)"
          />
        </div>
      </Popover>
    </>
  );
}
