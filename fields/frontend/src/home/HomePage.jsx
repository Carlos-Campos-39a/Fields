import { useEffect, useState } from "react";
import { Badge, Button, Icon, Logo, SectionLabel } from "../ui/index.js";
import { aparenciaDoTipo } from "../components/tipoEntrada.js";
import { relativeDate, saudacao } from "../lib/dates.js";
import { useOntologia } from "../lib/ontologia.js";
import { DICAS_DE_PREFIXO } from "../lib/parseInput.js";
import { useSair } from "../auth/useSair.js";
import { ThemeToggle } from "../layout/ThemeToggle.jsx";
import { InputBar } from "./InputBar.jsx";
import styles from "./HomePage.module.css";

const UM_MINUTO = 60_000;

// A saudação muda ao meio-dia e às 18h (hora de Brasília, lib/dates.js). Calculada só no render,
// uma home aberta de manhã seguia dizendo "Bom dia" à tarde.
function useAgora() {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), UM_MINUTO);
    return () => clearInterval(t);
  }, []);
  return agora;
}

/**
 * Rota #/ — a home. No monólito era uma sobreposição fixa (showHome) por cima do workspace; agora é
 * a tela da rota, e "fechar" é ir para #/notas. A R3 troca o miolo pelo chat do agente.
 * No desktop não há barra lateral nem TopBar aqui: o cabeçalho traz o caminho para o workspace,
 * o tema e o Sair. No celular os três ficam na MobileNav (o CSS esconde estes).
 * "Salvo como …" é o toast do App (aoCriar) — o aviso inline daqui repetia o mesmo recado.
 */
export function HomePage({ onClose, onCreated, recentEntries, onOpenEntry }) {
  const { rotulo } = useOntologia();
  const { sair, saindo } = useSair();
  const agora = useAgora();
  const recentes = recentEntries.slice(0, 5);

  return (
    <div className={styles.home}>
      <header className={styles.topo}>
        <span className={styles.marca}>
          <Logo size={18} className={styles.logo} />
          <span className={styles.nome}>Fields'</span>
        </span>
        <div className={styles.acoes}>
          <Button variant="ghost" size="sm" iconRight={<Icon name="chevron-right" size={14} />} onClick={onClose}>
            Abrir workspace
          </Button>
          <ThemeToggle />
          <Button variant="ghost" size="sm" icon={<Icon name="log-out" size={14} />} loading={saindo} onClick={sair}>
            Sair
          </Button>
        </div>
      </header>

      <div className={styles.centro}>
        <div className={styles.saudacao}>
          <h1 className={styles.titulo}>{saudacao(agora)}, Carlos.</h1>
          <p className={styles.sub}>O que você quer capturar hoje?</p>
        </div>

        <InputBar onCreated={onCreated} />

        <div className={styles.dicas}>
          <span className={styles.dicasRotulo}>Prefixos de tipo</span>
          {DICAS_DE_PREFIXO.map(({ prefixo }) => (
            <Badge key={prefixo} variant="outline">{prefixo}</Badge>
          ))}
        </div>

        {recentes.length > 0 && (
          <section className={styles.recentes} aria-labelledby="home-recentes">
            <SectionLabel id="home-recentes">Recentes</SectionLabel>
            <ul className={styles.lista}>
              {recentes.map(e => {
                const meta = aparenciaDoTipo(e.type);
                const nComentarios = e.threads?.length ?? 0;
                return (
                  <li key={e.id}>
                    <button type="button" className={styles.item} onClick={() => onOpenEntry(e)}>
                      <span className={styles.tipo}>
                        {meta.bandeira ? <span aria-hidden="true">{meta.bandeira}</span> : <Icon name={meta.icone} size={14} />}
                        <span className="sr-only">{rotulo("tipo_entrada", e.type)}:</span>
                      </span>
                      <span className={styles.tituloItem}>{e.title || "Sem título"}</span>
                      {nComentarios > 0 && (
                        <span className={styles.meta}>
                          <Icon name="message" size={12} />
                          {nComentarios}
                          <span className="sr-only">{nComentarios === 1 ? " comentário" : " comentários"}</span>
                        </span>
                      )}
                      <span className={styles.meta}>{relativeDate(e.date)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
