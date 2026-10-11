import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, Logo, Spinner } from "../ui/index.js";
import { hojeISO, saudacao } from "../lib/dates.js";
import { useSair } from "../auth/useSair.js";
import { ThemeToggle } from "../layout/ThemeToggle.jsx";
import { coladoAposRolar, montarFio } from "./chat.js";
import { useChat } from "./useChat.js";
import { Composer } from "./Composer.jsx";
import { Fio } from "./Fio.jsx";
import { HojeCard } from "./HojeCard.jsx";
import styles from "./HomePage.module.css";

const UM_MINUTO = 60_000;
// A esta distância do fim (px), o fio acompanha o que chega. Mais longe, o Carlos subiu para ler
// alguma coisa, e a resposta nova não pode arrancá-lo de lá.
const COLADO_PX = 96;

// A saudação muda ao meio-dia e às 18h, e o card "Hoje" vira à meia-noite (hora de Brasília,
// lib/dates.js). Calculado só no render, uma Home aberta de manhã seguia dizendo "Bom dia" à tarde.
function useAgora() {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), UM_MINUTO);
    return () => clearInterval(t);
  }, []);
  return agora;
}

/**
 * Rota #/ — a Home é o chat com o assistente (R3). Em cima, o fio da conversa (home/Fio.jsx), com a
 * saudação e o card "Hoje" no ponto onde o dia de hoje começa; embaixo, fixo, o composer.
 * No desktop não há barra lateral nem TopBar aqui: o cabeçalho traz o caminho para o workspace, o
 * tema e o Sair (no celular os três ficam na MobileNav, e o CSS os esconde). "Nova conversa" fica
 * nos dois.
 *
 * `onCreated` é o aoCriar do App (o "Salvar como nota" e o composer sem assistente);
 * `onDadosMudaram` é o carregar do App: o agente (ou um desfazer) mexeu nos dados, e a lista de
 * entradas da barra lateral, dos cartões e de #/notas relê;
 * `pedirFoco`/`aoAtenderFoco` são o ⌘K do App.
 */
export function HomePage({ onClose, onCreated, onDadosMudaram, pedirFoco, aoAtenderFoco }) {
  const { sair, saindo } = useSair();
  const agora = useAgora();
  const hoje = hojeISO(agora);
  const chat = useChat({ onCreated, onDadosMudaram });
  const { estado } = chat;
  const itens = useMemo(() => montarFio(estado.turnos, { hoje, corte: estado.corte }), [estado.turnos, estado.corte, hoje]);

  // ── Rolagem colada no fim ──
  const rolagemRef = useRef(null);
  const colunaRef = useRef(null);
  const colado = useRef(true);

  const irParaOFim = useCallback(() => {
    const el = rolagemRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Tudo o que muda a altura do fio (turno novo, resposta, chips, o card "Hoje" que chega depois,
  // a fonte que carrega) passa por aqui: colado no fim, continua no fim. A área de rolagem também é
  // observada: ela encolhe sem a coluna mudar quando o composer cresce, o chip da tarefa aparece ou
  // o teclado do celular sobe.
  useEffect(() => {
    const coluna = colunaRef.current;
    const rolagem = rolagemRef.current;
    if (!coluna || typeof ResizeObserver === "undefined") return undefined;
    const observador = new ResizeObserver(() => {
      if (colado.current) irParaOFim();
    });
    observador.observe(coluna);
    if (rolagem) observador.observe(rolagem);
    return () => observador.disconnect();
  }, [irParaOFim]);

  // Descola só quando o Carlos SOBE (chat.js coladoAposRolar diz por quê).
  const topoAnterior = useRef(0);
  function aoRolar() {
    const el = rolagemRef.current;
    if (!el) return;
    colado.current = coladoAposRolar(colado.current, {
      distancia: el.scrollHeight - el.scrollTop - el.clientHeight,
      topo: el.scrollTop,
      topoAnterior: topoAnterior.current,
      limite: COLADO_PX,
    });
    topoAnterior.current = el.scrollTop;
  }

  function enviar(texto, vinculo) {
    colado.current = true; // quem acabou de mandar quer ver a resposta
    chat.enviar(texto, vinculo);
  }

  const ultimoComId = [...estado.turnos].reverse().find((t) => t.turno_id);
  const jaNova = Boolean(estado.corte) && ultimoComId?.turno_id === estado.corte;
  const podeNovaConversa = Boolean(ultimoComId) && !jaNova && !chat.ocupado;

  const blocoHoje = (
    <div className={styles.hoje}>
      <div className={styles.saudacao}>
        <h1 className={styles.titulo}>{saudacao(agora)}, Carlos.</h1>
        <p className={styles.sub}>
          {estado.desligado ? "O assistente está desligado: o que você escrever vira nota." : "O que você precisa hoje?"}
        </p>
      </div>
      <HojeCard hoje={hoje} versao={estado.mudancas + estado.capturas} />
    </div>
  );

  return (
    <div className={styles.home}>
      <header className={styles.topo}>
        <span className={styles.marca}>
          <Logo size={18} className={styles.logo} />
          <span className={styles.nome}>Fields'</span>
        </span>
        <div className={styles.direita}>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="plus" size={14} />}
            loading={estado.novaConversa === "PEDINDO"}
            disabled={!podeNovaConversa}
            title={jaNova ? "A próxima mensagem já começa uma conversa nova" : undefined}
            onClick={chat.novaConversa}
          >
            Nova conversa
          </Button>
          <div className={styles.acoes}>
            <Button variant="ghost" size="sm" iconRight={<Icon name="chevron-right" size={14} />} onClick={onClose}>
              Abrir workspace
            </Button>
            <ThemeToggle />
            <Button variant="ghost" size="sm" icon={<Icon name="log-out" size={14} />} loading={saindo} onClick={sair}>
              Sair
            </Button>
          </div>
        </div>
      </header>

      <div ref={rolagemRef} className={styles.rolagem} onScroll={aoRolar}>
        <div ref={colunaRef} className={styles.coluna}>
          {estado.carga === "CARREGANDO" && estado.turnos.length === 0 && (
            <div className={styles.carregando}>
              <Spinner size={16} label="Carregando a conversa" />
            </div>
          )}
          {estado.carga === "FALHOU" && (
            <div className={styles.falhaCarga}>
              <Icon name="alert" size={14} className={styles.falhaIcone} />
              <span>Não consegui carregar a conversa anterior.</span>
              <Button variant="ghost" size="sm" onClick={chat.recarregar}>
                Tentar de novo
              </Button>
            </div>
          )}
          <Fio itens={itens} hoje={blocoHoje} chat={chat} agora={agora.getTime()} corte={estado.corte} />
        </div>
      </div>

      <div className={styles.rodape}>
        <div className={styles.rodapeColuna}>
          <Composer
            ocupado={chat.ocupado}
            desligado={estado.desligado}
            onEnviar={enviar}
            onSalvarDireto={chat.salvarDireto}
            onReativar={chat.reativar}
            pedirFoco={pedirFoco}
            aoAtenderFoco={aoAtenderFoco}
          />
        </div>
      </div>
    </div>
  );
}
