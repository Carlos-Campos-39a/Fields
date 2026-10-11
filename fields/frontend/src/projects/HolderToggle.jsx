import { proximoHolder, useOntologia } from "../lib/ontologia.js";
import styles from "./Celulas.module.css";

/**
 * Com quem está a bola. TRÊS estados, em ciclo, na ordem da ontologia (enums.holder): "Nós",
 * "Eles" e "" — o vazio é valor real em produção ("sem responsável definido"), e o monólito só
 * alternava Nós/Eles: um holder vazio, clicado, nunca mais voltava a vazio.
 * O texto é o rótulo da ontologia ("Com você", "Com terceiros", "Sem responsável definido").
 *
 * O estado vai em data-estado e o CSS pinta o ponto: acento para "nós", azul para o outro lado,
 * anel vazio para ninguém. O texto continua sendo quem diz o estado.
 */
export function HolderToggle({ value, onChange, label = "Holder" }) {
  const { enums, rotulo } = useOntologia();
  const atual = value ?? "";
  const texto = rotulo("holder", atual) || "—";
  const proximo = proximoHolder(atual, enums.holder);
  const textoProximo = rotulo("holder", proximo) || "—";
  const estado = atual === "" ? "vazio" : atual === enums.holder[0] ? "nos" : "outro";
  return (
    <button
      type="button"
      className={styles.holder}
      data-estado={estado}
      onClick={() => onChange(proximo)}
      aria-label={`${label}: ${texto}. Mudar para: ${textoProximo}`}
      title={`${texto}. Clique para: ${textoProximo}`}
    >
      <span className={styles.holderPonto} aria-hidden="true" />
      <span className={styles.holderTexto}>{texto}</span>
    </button>
  );
}
