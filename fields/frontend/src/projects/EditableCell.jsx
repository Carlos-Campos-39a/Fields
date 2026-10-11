import { useEffect, useRef, useState } from "react";
import { useToast } from "../ui/index.js";
import { avisar } from "../lib/log.js";
import { ehAtivar, ehEnter, ehEscape } from "./teclas.js";
import styles from "./Celulas.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");
const VARIANTES = ["projeto", "frente", "texto"];

/**
 * Célula de texto editável no clique. Enter ou blur confirmam; Escape desfaz. A trava `fechando`
 * impede o segundo commit: Enter fecha o campo e o blur que o navegador dispara ao desmontá-lo
 * gravava de novo.
 *
 * `variante`: projeto (14px/600) | frente (13px/500) | texto (13px/400) — o mesmo tamanho na
 * exibição e no campo, para o texto não pular ao abrir.
 * `obrigatorio`: apagar tudo NÃO grava "" (o PATCH aceitaria e o projeto ficaria sem nome); o valor
 * anterior volta e o toast diz por quê.
 * `riscado`: tarefa concluída — riscada e em --text-3 (no monólito era opacity 0,55, que derrubava
 * o contraste abaixo de AA).
 *
 * Fechado pelo teclado (Enter/Escape), o foco volta à célula: sem isso ele caía no <body> e o Tab
 * recomeçava do topo da página.
 */
export function EditableCell({ value, onSave, placeholder = "—", variante = "texto", obrigatorio = false, riscado = false, label }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || "");
  const inputRef = useRef(null);
  const exibicaoRef = useRef(null);
  const fechando = useRef(false);
  const voltarFoco = useRef(false);
  const tamanho = VARIANTES.includes(variante) ? styles[variante] : styles.texto;

  useEffect(() => {
    if (editing) {
      // O cursor no fim do texto: renomear quase sempre é acrescentar ou corrigir o final.
      const el = inputRef.current;
      el?.focus();
      const n = el?.value.length ?? 0;
      el?.setSelectionRange?.(n, n);
    } else if (voltarFoco.current) {
      voltarFoco.current = false;
      exibicaoRef.current?.focus();
    }
  }, [editing]);

  function abrir() {
    fechando.current = false;
    setVal(value || "");
    setEditing(true);
  }

  function commit() {
    if (fechando.current) return;
    fechando.current = true;
    setEditing(false);
    const trimmed = val.trim();
    if (trimmed === (value || "").trim()) return;
    if (obrigatorio && !trimmed) {
      setVal(value || "");
      avisar("PROJETOS_NOME_VAZIO_RECUSADO", "campo obrigatório apagado; o valor anterior foi mantido", {
        campo: label ?? null,
      });
      toast.show({ message: `${label ?? "O nome"} não pode ficar vazio. O anterior foi mantido.` });
      return;
    }
    onSave(trimmed);
  }

  function cancelar() {
    fechando.current = true;
    setVal(value || "");
    setEditing(false);
  }

  if (editing) return (
    <input
      ref={inputRef}
      className={cx(styles.campo, tamanho)}
      value={val}
      aria-label={label}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (ehEnter(e)) {
          e.preventDefault();
          voltarFoco.current = true;
          commit();
        } else if (ehEscape(e)) {
          voltarFoco.current = true;
          cancelar();
        }
      }}
    />
  );

  return (
    <span
      ref={exibicaoRef}
      role="button"
      tabIndex={0}
      aria-label={label ? `${label}: ${value || "vazio"}` : undefined}
      className={cx(styles.exibicao, tamanho, !value && styles.vazio, riscado && styles.riscado)}
      onClick={abrir}
      onKeyDown={(e) => {
        if (ehAtivar(e)) {
          e.preventDefault();
          abrir();
        }
      }}
    >
      {value || placeholder}
    </span>
  );
}
