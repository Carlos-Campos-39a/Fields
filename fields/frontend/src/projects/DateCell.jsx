import { useEffect, useRef, useState } from "react";
import { useToast } from "../ui/index.js";
import { dataCurta, ehDataISO, formatDate } from "../lib/dates.js";
import { avisar } from "../lib/log.js";
import { ehAtivar, ehEnter, ehEscape } from "./teclas.js";
import styles from "./Celulas.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");

/**
 * Célula de prazo: um <input type="date"> no clique (no monólito era texto livre). O valor gravado
 * é "YYYY-MM-DD" ou null.
 *
 * Prazo LEGADO em texto ("sexta", "fim do mês") continua aparecendo como veio, e só é trocado se o
 * Carlos escolher uma data: o campo abre vazio, e fechar sem escolher não grava nada — apagar à
 * revelia um texto que ele escreveu seria perder dado.
 *
 * Data digitada pela metade (só o dia, por exemplo) também não grava: o navegador devolve "" com
 * validity.badInput, e tratar esse "" como "sem prazo" APAGAVA o prazo que estava ali.
 */
export function DateCell({ value, onSave, placeholder = "—", label = "Prazo" }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const fechando = useRef(false);
  const voltarFoco = useRef(false);
  const exibicaoRef = useRef(null);
  const legado = Boolean(value) && !ehDataISO(value);
  const inicial = ehDataISO(value) ? value : "";

  useEffect(() => {
    if (!editing && voltarFoco.current) {
      voltarFoco.current = false;
      exibicaoRef.current?.focus();
    }
  }, [editing]);

  function abrir() {
    fechando.current = false;
    setEditing(true);
  }

  function fechar() {
    fechando.current = true;
    setEditing(false);
  }

  function commit(campo) {
    if (fechando.current) return;
    fechar();
    if (campo.validity?.badInput) {
      avisar("PROJETOS_PRAZO_INCOMPLETO", "data incompleta no campo; o prazo não mudou", { campo: label });
      toast.show({ message: "Data incompleta. O prazo não mudou." });
      return;
    }
    const v = campo.value;
    if (v !== inicial && (v || !legado)) onSave(v || null);
  }

  if (editing) return (
    <input
      type="date"
      autoFocus
      defaultValue={inicial}
      aria-label={label}
      className={cx(styles.campo, styles.campoData)}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (ehEnter(e)) {
          e.preventDefault();
          voltarFoco.current = true;
          commit(e.currentTarget);
        } else if (ehEscape(e)) {
          voltarFoco.current = true;
          fechar();
        }
      }}
    />
  );

  // Por extenso para o leitor de tela e a dica ("20 de out. de 2026"); texto legado volta como veio.
  const porExtenso = formatDate(value);
  return (
    <span
      ref={exibicaoRef}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${value ? porExtenso : "sem data"}`}
      title={legado ? "Prazo em texto livre (anterior ao campo de data)" : value ? porExtenso : undefined}
      className={cx(styles.exibicao, styles.texto, styles.prazo, !value && styles.vazio, legado && styles.legado)}
      onClick={abrir}
      onKeyDown={(e) => {
        if (ehAtivar(e)) {
          e.preventDefault();
          abrir();
        }
      }}
    >
      {value ? dataCurta(value) : placeholder}
    </span>
  );
}
