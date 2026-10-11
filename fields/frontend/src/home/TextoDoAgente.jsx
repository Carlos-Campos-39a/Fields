import { Fragment } from "react";
import { analisarTexto } from "./textoSeguro.js";
import styles from "./TextoDoAgente.module.css";

/**
 * A resposta do agente em Lora, com *negrito*, marcadores e quebras — e só isso. Cada pedaço vira
 * um nó de texto do React (escapado); não há dangerouslySetInnerHTML em lugar nenhum do chat
 * (home/textoSeguro.js diz por quê).
 */
export function TextoDoAgente({ texto, className }) {
  const paragrafos = analisarTexto(texto);
  if (paragrafos.length === 0) return null;
  return (
    <div className={[styles.texto, className].filter(Boolean).join(" ")}>
      {paragrafos.map((linhas, p) => (
        <p key={p} className={styles.paragrafo}>
          {linhas.map((linha, l) => (
            <Fragment key={l}>
              {l > 0 && <br />}
              {linha.marcador && <span className={styles.marcador} aria-hidden="true">•</span>}
              {linha.partes.map((parte, i) =>
                parte.negrito ? <strong key={i}>{parte.texto}</strong> : <Fragment key={i}>{parte.texto}</Fragment>,
              )}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}
