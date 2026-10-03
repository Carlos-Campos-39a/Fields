import styles from "./EmptyState.module.css";
import { Icon } from "./icons.jsx";
import { cx } from "./util.js";

/**
 * Estado vazio: ícone (nome de icons.jsx ou um nó), título em Lora, descrição e uma ação.
 *
 *   <EmptyState icon="note" title="Nenhuma nota ainda"
 *     description="Escreva na caixa acima — ela vira nota, evento ou lembrete."
 *     action={<Button variant="primary">Nova nota</Button>} />
 */
export function EmptyState({ icon, title, description, action, className }) {
  return (
    <div className={cx(styles.vazio, className)}>
      {icon && (
        <span className={styles.icone} aria-hidden="true">
          {typeof icon === "string" ? <Icon name={icon} size={20} /> : icon}
        </span>
      )}
      {title && <p className={styles.titulo}>{title}</p>}
      {description && <p className={styles.descricao}>{description}</p>}
      {action && <div className={styles.acao}>{action}</div>}
    </div>
  );
}
