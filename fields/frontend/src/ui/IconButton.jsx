import { forwardRef } from "react";
import styles from "./IconButton.module.css";
import { avisarUmaVez, cx } from "./util.js";

/**
 * Botão só de ícone. `aria-label` é OBRIGATÓRIO: sem ele o botão não tem nome para leitor de tela.
 * A falta não derruba a tela — loga UI_ICONBUTTON_SEM_ROTULO com o que foi recebido.
 * O mesmo rótulo vira `title` (dica no hover), salvo se vier um `title` próprio.
 *
 *   <IconButton aria-label="Excluir tarefa" onClick={...}><Icon name="trash" /></IconButton>
 *
 * `variant`: ghost (padrão) | secondary. `size`: sm (28px) | md (32px). `active` marca estado
 * ligado (com aria-pressed, se for alternância).
 */
export const IconButton = forwardRef(function IconButton(
  {
    "aria-label": ariaLabel,
    variant = "ghost",
    size = "md",
    active = false,
    type = "button",
    title,
    className,
    children,
    ...rest
  },
  ref,
) {
  const rotulo = typeof ariaLabel === "string" ? ariaLabel.trim() : "";
  if (!rotulo && !rest["aria-labelledby"]) {
    avisarUmaVez("UI_ICONBUTTON_SEM_ROTULO", "IconButton sem aria-label; o botão fica sem nome", {
      recebido: ariaLabel ?? null,
    });
  }
  return (
    <button
      ref={ref}
      type={type}
      aria-label={rotulo || undefined}
      title={title ?? (rotulo || undefined)}
      className={cx(
        styles.botao,
        styles[size] ?? styles.md,
        variant === "secondary" && styles.secondary,
        active && styles.ativo,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
