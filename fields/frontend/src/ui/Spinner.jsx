import styles from "./Spinner.module.css";
import { cx } from "./util.js";

/**
 * Indicador de carregamento em currentColor. Com `label`, anuncia (role="status"); sem ele é
 * decorativo — dentro de um Button com `loading`, quem anuncia é o aria-busy do botão.
 */
export function Spinner({ size = 16, label, className }) {
  const desenho = (
    <svg
      className={styles.spinner}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
  if (!label) return <span className={cx(styles.raiz, className)}>{desenho}</span>;
  return (
    <span role="status" className={cx(styles.raiz, className)}>
      {desenho}
      <span className="sr-only">{label}</span>
    </span>
  );
}
