import { useId } from "react";
import { Icon, Logo } from "../ui/index.js";
import { useOntologia } from "../lib/ontologia.js";
import { DICAS_DE_PREFIXO } from "../lib/parseInput.js";
import css from "./EntryEmpty.module.css";

// O painel de #/notas sem entrada aberta (desktop). No celular, #/notas é a própria lista.
// A caixa de captura mora logo abaixo (InputBar, da casca): as dicas ensinam a gramática dela, e o
// tipo de cada prefixo sai da ontologia — a mesma palavra do filtro e do badge.
export function EntryEmpty() {
  const { rotulo } = useOntologia();
  const tituloId = useId();
  return (
    <section className={css.vazio} aria-labelledby={tituloId}>
      <Logo size={32} className={css.logo} />
      <h1 id={tituloId} className={css.titulo}>
        Nenhuma entrada aberta
      </h1>
      <p className={css.descricao}>Escolha uma na lista ou escreva na caixa abaixo. Um prefixo escolhe o tipo:</p>
      <ul className={css.dicas}>
        {DICAS_DE_PREFIXO.map(({ prefixo, tipo }) => (
          <li key={prefixo} className={css.dica}>
            <code className={css.prefixo}>{prefixo}</code>
            <span className={css.tipo}>
              <Icon name="chevron-right" size={12} />
              {rotulo("tipo_entrada", tipo)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
