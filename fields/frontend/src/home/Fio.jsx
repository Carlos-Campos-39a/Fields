import { Button, Icon, Spinner } from "../ui/index.js";
import { cx } from "../ui/util.js";
import { useOntologia } from "../lib/ontologia.js";
import { formatHash } from "../lib/useHashRoute.js";
import { relativeDate } from "../lib/dates.js";
import { parseInput } from "../lib/parseInput.js";
import {
  ENVIANDO,
  EM_ANDAMENTO,
  VERIFICANDO,
  avisoDoTurno,
  ehTerminal,
  iconeDaAcao,
  podeDesfazer,
  podeSalvarComoNota,
  podeTentarDeNovo,
  podeVerificarDeNovo,
} from "./chat.js";
import { TextoDoAgente } from "./TextoDoAgente.jsx";
import styles from "./Fio.module.css";

/**
 * O fio da conversa: os itens de chat.montarFio (dias, divisores de sessão, o bloco "hoje" e os
 * turnos). O bloco "hoje" — a saudação e o card — vem pronto de quem monta (`hoje`): ele fica onde
 * o dia de hoje começa no fio, e não no topo da página, para a conversa de ontem não ficar embaixo
 * do resumo de hoje. `corte` é o turno_id do "Nova conversa" (o "Tentar de novo" olha para ele).
 */
export function Fio({ itens, hoje, chat, agora, corte = null }) {
  return (
    <div className={styles.fio}>
      {itens.map((item) => {
        if (item.tipo === "hoje") return <div key={item.chave}>{hoje}</div>;
        if (item.tipo === "dia") {
          return (
            <div key={item.chave} className={styles.divisor} role="separator" aria-label={relativeDate(item.data)}>
              <span className={styles.divisorTexto}>{relativeDate(item.data)}</span>
            </div>
          );
        }
        if (item.tipo === "sessao") {
          return (
            <div key={item.chave} className={styles.divisor} role="separator" aria-label="Conversa nova">
              <span className={styles.divisorTexto}>Conversa nova</span>
            </div>
          );
        }
        return <Turno key={item.chave} turno={item.turno} ultimo={item.ultimo} corte={corte} chat={chat} agora={agora} />;
      })}
    </div>
  );
}

/**
 * Um turno: o pedido (bolha em --surface-2) e a resposta (Lora), com os chips das ações.
 * `agora` (ms, o relógio de minuto da Home) tira o "Desfazer" dos chips fora da janela.
 */
function Turno({ turno: t, ultimo, corte, chat, agora }) {
  const { rotulo } = useOntologia();
  const emCurso = t.status === ENVIANDO || t.status === VERIFICANDO || t.status === EM_ANDAMENTO;
  const aviso = avisoDoTurno(t);
  const tentar = podeTentarDeNovo(t, { ultimo, corte });
  const salvar = podeSalvarComoNota(t);
  const verificar = podeVerificarDeNovo(t);
  const tipoDaNota = salvar ? parseInput(t.entrada).type : null;
  const rotuloDaNota = tipoDaNota ? rotulo("tipo_entrada", tipoDaNota, { capitalizar: false }) || "nota" : "nota";

  return (
    <article className={styles.turno}>
      {t.entrada && (
        <div className={styles.pedido}>
          {t.contexto && (
            <span className={styles.contexto}>
              <Icon name="link" size={12} />
              <span className={styles.contextoNome}>{t.contexto.tarefa?.name || "Tarefa"}</span>
            </span>
          )}
          <p className={styles.bolha}>{t.entrada}</p>
        </div>
      )}

      {/* aria-busy segura o anúncio até a resposta chegar: o leitor de tela lê o texto final, não
          cada "Trabalhando…" do caminho. */}
      <div className={styles.resposta} aria-live="polite" aria-busy={emCurso}>
        {t.status === ENVIANDO && <Progresso texto="Enviando…" />}

        {t.status === VERIFICANDO && <Progresso texto="Conferindo se a mensagem chegou…" />}

        {t.status === EM_ANDAMENTO && !t.consulta?.parada && (
          <Progresso texto="Trabalhando…" detalhe={t.n_tools > 0 ? `${t.n_tools} ${t.n_tools === 1 ? "passo" : "passos"}` : null} />
        )}

        {t.status === EM_ANDAMENTO && t.consulta?.parada && (
          <div className={styles.aviso}>
            <Icon name="alert" size={14} className={styles.avisoIcone} />
            <span>
              {t.consulta.parada === "DEMORA"
                ? "Está demorando mais que o normal."
                : "Perdi o contato com o servidor. O pedido pode ter continuado lá."}
            </span>
            <Button variant="ghost" size="sm" onClick={() => chat.retomarConsulta(t.turno_id)}>
              Verificar de novo
            </Button>
          </div>
        )}

        {ehTerminal(t.status) && <TextoDoAgente texto={t.texto} />}

        {aviso && (
          <p className={styles.aviso}>
            <Icon name="alert" size={14} className={styles.avisoIcone} />
            <span>{aviso}</span>
          </p>
        )}

        {t.acoes.length > 0 && (
          <ul className={styles.acoes} aria-label="O que o assistente fez">
            {t.acoes.map((a) => (
              <li key={a.idx} className={cx(styles.chip, a.desfeito_em && styles.chipDesfeito)}>
                <Icon name={iconeDaAcao(a.acao)} size={14} className={styles.chipIcone} />
                <span className={styles.chipResumo}>{a.resumo}</span>
                {podeDesfazer(t, a, agora) && (
                  <button
                    type="button"
                    className={styles.desfazer}
                    disabled={a.desfazendo}
                    aria-label={`Desfazer: ${a.resumo}`}
                    onClick={() => chat.desfazer(t.turno_id, a.idx)}
                  >
                    {a.desfazendo ? "Desfazendo…" : "Desfazer"}
                  </button>
                )}
                {a.desfeito_em && <span className={styles.desfeito}>Desfeito</span>}
              </li>
            ))}
          </ul>
        )}

        {t.nota && (
          <p className={styles.nota}>
            <Icon name="check" size={14} />
            <span>Salvo como {rotulo("tipo_entrada", t.nota.type, { capitalizar: false }) || "nota"}.</span>
            {t.nota.id && (
              <a className={styles.link} href={formatHash({ view: "notas", id: String(t.nota.id) })}>
                Abrir
              </a>
            )}
          </p>
        )}

        {(tentar || salvar || verificar) && (
          <div className={styles.botoes}>
            {verificar && (
              <Button variant="ghost" size="sm" onClick={() => chat.verificarEnvio(t.chave)}>
                Verificar de novo
              </Button>
            )}
            {salvar && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="note" size={14} />}
                loading={t.salvandoNota}
                onClick={() => chat.salvarComoNota(t.chave)}
              >
                Salvar como {rotuloDaNota}
              </Button>
            )}
            {tentar && (
              <Button
                variant="ghost"
                size="sm"
                disabled={chat.ocupado || t.salvandoNota}
                onClick={() => chat.tentarDeNovo(t.chave)}
              >
                Tentar de novo
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function Progresso({ texto, detalhe }) {
  return (
    <p className={styles.progresso}>
      <Spinner size={14} />
      <span>{texto}</span>
      {detalhe && <span className={styles.progressoDetalhe}>{detalhe}</span>}
    </p>
  );
}
