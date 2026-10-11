import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Button, Popover, PopoverItem, Spinner } from "../ui/index.js";
import { ehConcluido } from "../lib/ontologia.js";
import { avisar, camposDoErro } from "../lib/log.js";
import styles from "./TaskPicker.module.css";

/**
 * Seletor de tarefa — o ÚNICO (no monólito eram duas cópias, no InputBar e na ThreadSection, cada
 * uma com o próprio portal e o próprio "clique fora").
 *
 *   const ref = useRef(null);
 *   <IconButton ref={ref} aria-expanded={aberto} onClick={() => setAberto(v => !v)} …/>
 *   <TaskPicker open={aberto} onClose={() => setAberto(false)} anchorRef={ref}
 *     selecionadaId={vinculo?.tarefa.id} onSelect={({ tarefa, frente, projeto }) => …} />
 *
 * Os projetos são buscados a CADA abertura: o retrato carregado uma vez por montagem era o que o
 * monólito usava para montar o array de comentários da tarefa — e o 409 que sumia da tela. Quem
 * comenta na tarefa escolhida faz um POST (lib/comentarios.js), não reescreve a lista.
 * Só aparecem tarefas não concluídas.
 */
export function TaskPicker({ open, onClose, anchorRef, selecionadaId, onSelect, side = "top", align = "start" }) {
  const [estado, setEstado] = useState({ carregando: false, erro: false, projetos: [] });
  const [tentativa, setTentativa] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    const minha = ++seq.current;
    setEstado((s) => ({ ...s, carregando: true, erro: false }));
    api
      .getProjects()
      .then(({ projects }) => {
        if (minha === seq.current) setEstado({ carregando: false, erro: false, projetos: projects ?? [] });
      })
      .catch((e) => {
        if (minha !== seq.current) return;
        avisar("TASKPICKER_FALHOU", "não deu para carregar os projetos do seletor", camposDoErro(e));
        setEstado({ carregando: false, erro: true, projetos: [] });
      });
    return () => {
      seq.current++; // fechou (ou reabriu) antes de voltar: a resposta velha não pinta a lista
    };
  }, [open, tentativa]);

  const grupos = estado.projetos
    .map((projeto) => ({
      projeto,
      frentes: (projeto.frentes ?? [])
        .map((frente) => ({ frente, tarefas: (frente.tasks ?? []).filter((t) => !ehConcluido(t.status)) }))
        .filter((f) => f.tarefas.length > 0),
    }))
    .filter((g) => g.frentes.length > 0);

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} side={side} align={align} label="Vincular a uma tarefa" width={320}>
      <div className={styles.cabecalho}>Vincular a uma tarefa</div>
      {estado.carregando ? (
        <div className={styles.aviso}>
          <Spinner size={14} label="Carregando tarefas" />
        </div>
      ) : estado.erro ? (
        <div className={styles.aviso} role="alert">
          <span>Não foi possível carregar as tarefas.</span>
          <Button size="sm" variant="ghost" onClick={() => setTentativa((n) => n + 1)}>
            Tentar de novo
          </Button>
        </div>
      ) : grupos.length === 0 ? (
        <div className={styles.aviso}>Nenhuma tarefa aberta.</div>
      ) : (
        <div className={styles.lista}>
          {grupos.map(({ projeto, frentes }) => (
            <div key={projeto.id} role="group" aria-label={projeto.name}>
              <div className={styles.projeto}>{projeto.name}</div>
              {frentes.map(({ frente, tarefas }) => (
                <div key={frente.id} role="group" aria-label={frente.name}>
                  <div className={styles.frente}>{frente.name}</div>
                  {tarefas.map((tarefa) => (
                    <PopoverItem
                      key={tarefa.id}
                      className={styles.tarefa}
                      selected={tarefa.id === selecionadaId}
                      onClick={() => {
                        onSelect?.({ tarefa, frente, projeto });
                        onClose?.("selecao");
                      }}
                    >
                      {tarefa.name || "—"}
                    </PopoverItem>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}
