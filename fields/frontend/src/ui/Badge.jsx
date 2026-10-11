import { Children } from "react";
import styles from "./Badge.module.css";
import { avisarUmaVez, cx } from "./util.js";

export const BADGE_TONES = ["neutral", "info", "success", "warning", "accent", "danger"];
export const BADGE_VARIANTS = ["soft", "solid", "outline"];

// Texto solto dentro do inline-flex vira um item ANÔNIMO, que não aceita reticências: um rótulo
// longo numa coluna estreita era cortado no meio da letra. Os trechos de texto seguidos ("#" e a
// tag; o rótulo e o "· Amanhã") vão juntos num <span> que encolhe com "…" — o mesmo agrupamento
// que o flex já fazia com o texto anônimo, então nada muda de lugar. Ícones e outros nós passam
// como vieram.
function agruparTexto(children) {
  const saida = [];
  let texto = [];
  const fechar = () => {
    if (texto.length === 0) return;
    saida.push(
      <span key={`texto-${saida.length}`} className={styles.texto}>
        {texto.join("")}
      </span>,
    );
    texto = [];
  };
  for (const filho of Children.toArray(children)) {
    if (typeof filho === "string" || typeof filho === "number") {
      texto.push(String(filho));
    } else {
      fechar();
      saida.push(filho);
    }
  }
  fechar();
  return saida;
}

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
      {agruparTexto(children)}
    </span>
  );
}
