import { forwardRef } from "react";
import styles from "./Button.module.css";
import { Spinner } from "./Spinner.jsx";
import { avisarUmaVez, cx } from "./util.js";

export const BUTTON_VARIANTS = ["primary", "secondary", "ghost", "danger"];
export const BUTTON_SIZES = ["sm", "md"];

/**
 * Botão de texto. `variant`: primary (tinta invertida) | secondary | ghost | danger.
 * `size`: sm (28px) | md (36px). `icon`/`iconRight` são nós (ex.: <Icon name="plus" />).
 * `loading` troca o ícone por um Spinner, desabilita e marca aria-busy.
 */
export const Button = forwardRef(function Button(
  {
    variant = "secondary",
    size = "md",
    type = "button",
    icon,
    iconRight,
    loading = false,
    disabled,
    className,
    children,
    ...rest
  },
  ref,
) {
  let v = variant;
  if (!BUTTON_VARIANTS.includes(v)) {
    avisarUmaVez("UI_BOTAO_VARIANTE_DESCONHECIDA", "variante recusada; usando secondary", {
      variante: variant,
      aceitas: BUTTON_VARIANTS,
    });
    v = "secondary";
  }
  let s = size;
  if (!BUTTON_SIZES.includes(s)) {
    avisarUmaVez("UI_BOTAO_TAMANHO_DESCONHECIDO", "tamanho recusado; usando md", {
      tamanho: size,
      aceitos: BUTTON_SIZES,
    });
    s = "md";
  }
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.botao, styles[v], styles[s], loading && styles.carregando, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={s === "sm" ? 12 : 14} /> : icon}
      {children != null && children !== false && <span className={styles.rotulo}>{children}</span>}
      {iconRight}
    </button>
  );
});
