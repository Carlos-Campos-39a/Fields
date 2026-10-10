import { useRef, useState } from "react";
import { api } from "../api.js";
import { Button, Icon, IconButton } from "../ui/index.js";
import { TaskPicker } from "../components/TaskPicker.jsx";
import { TipoBadge } from "../components/TipoBadge.jsx";
import { comentar } from "../lib/comentarios.js";
import { parseInput } from "../lib/parseInput.js";
import { useFalha } from "../lib/useFalha.js";
import styles from "./InputBar.module.css";

/**
 * A caixa de captura (home e rodapé de #/notas). O prefixo escolhe o tipo (lib/parseInput.js).
 * Vincular a uma tarefa: depois de criar a entrada, o texto vira UM comentário da tarefa por POST
 * (lib/comentarios.js) — no monólito era um PATCH do array montado sobre o retrato do seletor, e o
 * 409 do backend sumia da tela.
 * `bordered`: a faixa do rodapé de #/notas (borda em cima, recuo próprio). Sem ela, a caixa se
 * encaixa no espaço de quem a monta (a home).
 */
export function InputBar({ onCreated, bordered = false }) {
  const falha = useFalha();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [vinculo, setVinculo] = useState(null); // {tarefa, frente, projeto}
  const [seletorAberto, setSeletorAberto] = useState(false);
  const ref = useRef(null);
  const seletorRef = useRef(null);

  const detected = text.trim() ? parseInput(text) : null;

  async function submit() {
    if (!text.trim() || loading) return;
    setLoading(true);
    const { type, body } = parseInput(text);
    let entry;
    try {
      ({ entry } = await api.createEntry({
        type, title: body.slice(0, 80) + (body.length > 80 ? "…" : ""),
        content: body, tags: [], // sem date: o backend grava o dia de hoje em São Paulo
      }));
    } catch (e) {
      // O texto fica na caixa: nada do que o Carlos escreveu se perde.
      falha("ENTRADA_CRIAR_FALHOU", "Não foi possível registrar. O texto continua na caixa.", e);
      setLoading(false);
      return;
    }
    onCreated(entry);
    setText("");
    const escolha = vinculo;
    if (escolha) {
      try {
        await comentar({ tipo: "TAREFA", id: escolha.tarefa.id }, body, escolha.tarefa.comments);
        setVinculo(null);
      } catch (e) {
        falha("VINCULO_TAREFA_FALHOU", "A entrada foi criada, mas não chegou à tarefa.", e);
      }
    }
    setLoading(false);
  }

  function handleKeyDown(e) {
    if (e.nativeEvent?.isComposing) return;
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      const el = e.target, s = el.selectionStart, end = el.selectionEnd;
      const v = text.slice(0, s) + "\n" + text.slice(end);
      setText(v);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 1; });
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); submit();
    }
  }

  return (
    <div className={`${styles.raiz} ${bordered ? styles.comBorda : ""}`}>
      <div className={styles.coluna}>
        {vinculo && (
          <div className={styles.vinculo}>
            <span className={styles.vinculoRotulo}>
              <Icon name="link" size={12} />
              Vai para a tarefa
            </span>
            <span className={styles.chip}>
              <span className={styles.caminho}>{vinculo.projeto.name}</span>
              <Icon name="chevron-right" size={12} className={styles.sep} />
              <span className={styles.caminho}>{vinculo.frente.name}</span>
              <Icon name="chevron-right" size={12} className={styles.sep} />
              <span className={styles.tarefa}>{vinculo.tarefa.name || "—"}</span>
              <IconButton size="sm" aria-label="Desvincular a tarefa" onClick={() => setVinculo(null)}>
                <Icon name="x" size={14} />
              </IconButton>
            </span>
          </div>
        )}

        {/* O anel de foco é da caixa inteira (:focus-within no CSS), não só do textarea. */}
        <div className={styles.caixa}>
          <textarea
            ref={ref}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            aria-label="Nova nota, evento ou lembrete"
            placeholder="Nova nota, evento ou lembrete…"
            className={styles.texto}
          />
          <div className={styles.acoes}>
            <IconButton
              ref={seletorRef}
              aria-label={vinculo ? "Trocar a tarefa vinculada" : "Vincular a uma tarefa"}
              aria-haspopup="dialog"
              aria-expanded={seletorAberto}
              active={Boolean(vinculo)}
              onClick={() => setSeletorAberto(v => !v)}
            >
              <Icon name="link" />
            </IconButton>
            <Button
              variant="primary"
              aria-label="Registrar"
              className={styles.enviar}
              icon={<Icon name="arrow-up" />}
              loading={loading}
              disabled={!text.trim()}
              onClick={submit}
            />
          </div>
        </div>

        {/* O tipo detectado fica NA linha de baixo, e a região viva está sempre montada: antes o
            badge flutuava 32px acima da caixa (cobrindo o que estivesse ali) e a região nascia
            junto com o conteúdo — o leitor de tela não anunciava a primeira detecção. */}
        <div className={styles.rodape}>
          <div aria-live="polite" className={styles.deteccao}>
            {detected && (
              <>
                <span className={styles.vaiComo}>Vai como</span>
                <TipoBadge tipo={detected.type} />
              </>
            )}
          </div>
          <span className={styles.dica}>Enter registra · Alt+Enter quebra a linha</span>
        </div>
      </div>

      <TaskPicker
        open={seletorAberto}
        onClose={() => setSeletorAberto(false)}
        anchorRef={seletorRef}
        selecionadaId={vinculo?.tarefa.id}
        onSelect={(escolha) => {
          setVinculo(escolha);
          ref.current?.focus();
        }}
      />
    </div>
  );
}
