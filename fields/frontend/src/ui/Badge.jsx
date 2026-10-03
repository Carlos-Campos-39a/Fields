import styles from "./Badge.module.css";
import { avisarUmaVez, cx } from "./util.js";

export const BADGE_TONES = ["neutral", "info", "success", "warning", "accent", "danger"];
export const BADGE_VARIANTS = ["soft", "solid", "outline"];

/**
 * Pílula de 22px, 12px/500.
 * `tone`: neutral | info | success | warning | accent | danger.
 * `variant`: soft (fundo tingido, padrão) | solid (preenchido) | outline (só o anel).
 * `dot` acrescenta o ponto colorido à esquerda — a cor nunca é o único portador do sentido: o
 * texto do badge diz o estado.
 */
export function Badge({ tone = "neutral", variant = "soft", dot = false, className, children, ...rest }) {
  let t = tone;
  if (!BADGE_TONES.includes(t)) {
    avisarUmaVez("UI_BADGE_TOM_DESCONHECIDO", "tom recusado; usando neutral", { tom: tone, aceitos: BADGE_TONES });
    t = "neutral";
  }
  let v = variant;
  if (!BADGE_VARIANTS.includes(v)) {
    avisarUmaVez("UI_BADGE_VARIANTE_DESCONHECIDA", "variante recusada; usando soft", {
      variante: variant,
      aceitas: BADGE_VARIANTS,
    });
    v = "soft";
  }
  return (
    <span className={cx(styles.badge, styles[t], styles[v], className)} {...rest}>
      {dot && <span className={styles.ponto} aria-hidden="true" />}
      {children}
    </span>
  );
}
