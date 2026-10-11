import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Button, Icon, SectionLabel, Spinner } from "../ui/index.js";
import { aparenciaDoTipo } from "../components/tipoEntrada.js";
import { avisar, camposDoErro } from "../lib/log.js";
import { linhasDoHoje, normalizarResumo, rotuloDoDia } from "./hoje.js";
import styles from "./HojeCard.module.css";

/**
 * O card "Hoje" (GET /api/resumo-do-dia): reuniões, eventos e lembretes do dia pela hora, e as
 * tarefas abertas que vencem hoje ou já venceram. Relê quando o dia vira (`hoje`) e quando o
 * assistente mexeu nos dados ou a Home gravou uma nota sem ele (`versao` = chat.mudancas +
 * chat.capturas): a tarefa que ele acabou de criar para hoje, ou o "evento …" que a caixa salvou,
 * aparece aqui sem F5. Uma releitura que falha mantém o card anterior (com log); só a primeira
 * falha mostra o aviso.
 */
export function HojeCard({ hoje, versao }) {
  const [estado, setEstado] = useState({ fase: "CARREGANDO", resumo: null });
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let vivo = true;
    setEstado((s) => (s.resumo ? s : { fase: "CARREGANDO", resumo: null }));
    api
      .getResumoDoDia(hoje)
      .then((corpo) => {
        if (!vivo) return;
        const resumo = normalizarResumo(corpo?.resultado);
        if (!resumo) {
          avisar("RESUMO_DIA_FORMA", "GET /resumo-do-dia sem o resultado esperado", {});
          setEstado((s) => (s.resumo ? { ...s, fase: "PRONTO" } : { fase: "FALHOU", resumo: null }));
          return;
        }
        setEstado({ fase: "PRONTO", resumo });
      })
      .catch((e) => {
        if (!vivo) return;
        avisar("RESUMO_DIA_FALHOU", "não deu para carregar o resumo do dia", camposDoErro(e));
        setEstado((s) => (s.resumo ? { ...s, fase: "PRONTO" } : { fase: "FALHOU", resumo: null }));
      });
    return () => {
      vivo = false;
    };
  }, [hoje, versao, tentativa]);

  const linhas = linhasDoHoje(estado.resumo);

  return (
    <section className={styles.card} aria-labelledby="home-hoje">
      <header className={styles.cabecalho}>
        <SectionLabel id="home-hoje">Hoje</SectionLabel>
        <span className={styles.data}>{rotuloDoDia(hoje)}</span>
      </header>

      {estado.fase === "CARREGANDO" && (
        <div className={styles.aviso}>
          <Spinner size={14} label="Carregando o dia" />
        </div>
      )}

      {estado.fase === "FALHOU" && (
        <div className={styles.aviso}>
          <span>Não consegui carregar o dia.</span>
          <Button variant="ghost" size="sm" onClick={() => setTentativa((n) => n + 1)}>
            Tentar de novo
          </Button>
        </div>
      )}

      {estado.fase === "PRONTO" && linhas.vazio && <p className={styles.aviso}>Nada marcado para hoje.</p>}

      {estado.fase === "PRONTO" && linhas.compromissos.length > 0 && (
        <ul className={styles.lista} aria-label="Compromissos">
          {linhas.compromissos.map((c) => (
            <li key={c.chave}>
              <a className={styles.linha} href={c.href}>
                <span className={styles.icone}>
                  <Icon name={c.tipo === "reuniao" ? "calendar" : aparenciaDoTipo(c.tipo).icone} size={14} />
                </span>
                <span className={styles.hora}>{c.hora ?? "—"}</span>
                <span className={styles.titulo}>
                  <span className={styles.nome}>{c.titulo}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {estado.fase === "PRONTO" && linhas.tarefas.length > 0 && (
        <ul className={styles.lista} aria-label="Tarefas">
          {linhas.tarefas.map((t) => (
            <li key={t.chave}>
              <a className={styles.linha} href={t.href}>
                <span className={styles.icone}>
                  <Icon name="columns" size={14} />
                </span>
                <span className={styles.titulo}>
                  <span className={styles.nome}>{t.titulo}</span>
                  {t.caminho && <span className={styles.caminho}>{t.caminho}</span>}
                </span>
                {t.atrasada && (
                  <Badge tone="danger" className={styles.selo}>
                    {t.prazo ? `Venceu ${t.prazo}` : "Atrasada"}
                  </Badge>
                )}
              </a>
            </li>
          ))}
          {linhas.maisTarefas > 0 && (
            <li>
              <a className={`${styles.linha} ${styles.mais}`} href={linhas.hrefTarefas}>
                e mais {linhas.maisTarefas} {linhas.maisTarefas === 1 ? "tarefa" : "tarefas"}
              </a>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
