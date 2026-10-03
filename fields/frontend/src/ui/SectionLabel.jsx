import styles from "./SectionLabel.module.css";
import { cx } from "./util.js";

/**
 * Rótulo de seção: 12px, caixa-alta, .06em, 500, --text-2.
 * É um título por padrão (`as="h2"`); troque o nível com `as` ("h3", "div", "span"…).
 * Escreva o texto normal ("Hoje") — a caixa-alta é do CSS, e o leitor de tela lê a palavra.
 */
export function SectionLabel({ as: Elemento = "h2", className, children, ...rest }) {
  return (
    <Elemento className={cx(styles.rotulo, className)} {...rest}>
      {children}
    </Elemento>
  );
}
