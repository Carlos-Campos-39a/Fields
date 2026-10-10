import { useId, useRef, useState } from "react";
import { Popover, PopoverItem, StatusBadge } from "../ui/index.js";
import { useOntologia } from "../lib/ontologia.js";
import styles from "./Celulas.module.css";

/**
 * O status (andamento) de projeto ou tarefa: o StatusBadge de src/ui (só exibe) + o Popover único
 * com a lista da ontologia (enums.status). Substitui o StatusBadge legado do App.jsx, que tinha o
 * próprio portal, o próprio "clique fora" e a lista PROJ_STATUS_LIST copiada à mão.
 *
 * O badge É o gatilho (sem chevron: na coluna de 16% ele não caberia ao lado de "Em definição");
 * o :hover e o aberto desenham um anel em volta da pílula.
 */
export function StatusPicker({ value, onChange, label = "Status" }) {
  const { enums, rotulo } = useOntologia();
  const [aberto, setAberto] = useState(false);
  const ancora = useRef(null);
  const id = useId();
  const textoAtual = value ? rotulo("status", value) : "";

  return (
    <>
      <button
        ref={ancora}
        type="button"
        className={styles.gatilhoStatus}
        aria-haspopup="dialog"
        aria-expanded={aberto}
        aria-controls={aberto ? id : undefined}
        aria-label={`${label}: ${textoAtual || "sem status"}`}
        title={`Mudar ${label.toLowerCase()}`}
        onClick={(e) => {
          e.stopPropagation();
          setAberto((v) => !v);
        }}
      >
        <StatusBadge value={value} label={textoAtual || "—"} />
      </button>
      <Popover id={id} open={aberto} onClose={() => setAberto(false)} anchorRef={ancora} label={`Mudar ${label.toLowerCase()}`}>
        {enums.status.map((s) => (
          <PopoverItem
            key={s}
            selected={s === value}
            onClick={() => {
              setAberto(false);
              if (s !== value) onChange(s);
            }}
          >
            <StatusBadge value={s} label={rotulo("status", s)} />
          </PopoverItem>
        ))}
      </Popover>
    </>
  );
}
