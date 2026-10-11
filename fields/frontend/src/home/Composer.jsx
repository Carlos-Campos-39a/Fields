import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Icon, IconButton } from "../ui/index.js";
import { TaskPicker } from "../components/TaskPicker.jsx";
import { TipoBadge } from "../components/TipoBadge.jsx";
import { rotuloDoAtalho } from "../lib/atalhos.js";
import { parseInput } from "../lib/parseInput.js";
import { TEXTO_MAX } from "./chat.js";
import styles from "./Composer.module.css";

const ALTURA_MAX = 200; // px; daí para cima a caixa rola por dentro
const AVISO_DE_TAMANHO = Math.floor(TEXTO_MAX * 0.9);

// Onde o CSS sabe crescer sozinho (field-sizing, Chrome 123+), o JS não mexe na altura.
const CRESCE_SOZINHO = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

function ajustarAltura(el) {
  if (!el || CRESCE_SOZINHO) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, ALTURA_MAX)}px`;
}

// Teclado de toque não tem Shift nem Alt: lá o Enter quebra a linha e quem envia é o botão (no iOS o
// Enter mandaria sempre; no Android dependeria do teclado). Lido na hora, e sem matchMedia (teste,
// navegador antigo) vale o desktop.
function toqueSemTeclado() {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * A caixa do chat. Enter envia; Shift+Enter (e Alt+Enter, como na caixa de captura) quebra a linha.
 * Em tela de toque, o Enter quebra a linha e o envio é pelo botão.
 * O texto sai da caixa NA HORA do envio: a bolha do fio passa a guardá-lo, e é nela que ficam o
 * "Tentar de novo" e o "Salvar como nota" se a mensagem não chegar.
 *
 * `ocupado`: há um turno rodando — o backend tem UM por canal e o prazo de um turno na fila conta da
 * chegada, então mandar outro agora só o faria esperar e perder tempo. Dá para escrever; não, enviar.
 * `desligado`: o servidor disse AGENTE_DESLIGADO — a caixa volta a ser a de captura (parseInput:
 * "evento …" vira evento), e grava direto como nota até o Carlos pedir o assistente de volta.
 * `pedirFoco`: o ⌘K do App; a caixa foca e avisa que atendeu (`aoAtenderFoco`).
 */
export function Composer({ ocupado, desligado, onEnviar, onSalvarDireto, onReativar, pedirFoco, aoAtenderFoco }) {
  const [texto, setTexto] = useState("");
  const [vinculo, setVinculo] = useState(null); // {tarefa, frente, projeto}
  const [seletorAberto, setSeletorAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const ref = useRef(null);
  const seletorRef = useRef(null);
  const atalho = rotuloDoAtalho();

  useEffect(() => {
    if (!pedirFoco) return;
    ref.current?.focus();
    aoAtenderFoco?.();
  }, [pedirFoco, aoAtenderFoco]);

  useLayoutEffect(() => {
    ajustarAltura(ref.current);
  }, [texto]);

  const limpo = texto.trim();
  const longoDemais = texto.length > TEXTO_MAX;
  const esperando = !desligado && ocupado;
  const podeMandar = Boolean(limpo) && !longoDemais && !salvando && !esperando;
  const detectado = desligado && limpo ? parseInput(limpo) : null;

  async function mandar() {
    if (!podeMandar) return;
    if (desligado) {
      const enviado = limpo;
      const vinculoEnviado = vinculo;
      setSalvando(true);
      const ok = await onSalvarDireto(enviado, vinculoEnviado);
      setSalvando(false);
      if (ok) {
        // Só limpa o que foi gravado: o que o Carlos começou a escrever (ou vinculou) enquanto a
        // gravação voava é a próxima nota, e fica.
        setTexto((atual) => (atual.trim() === enviado ? "" : atual));
        setVinculo((atual) => (atual === vinculoEnviado ? null : atual));
      }
      return;
    }
    onEnviar(limpo, vinculo);
    setTexto("");
    setVinculo(null);
  }

  function aoTeclar(e) {
    if (e.nativeEvent?.isComposing) return;
    if (e.key !== "Enter") return;
    if (toqueSemTeclado()) return; // o Enter do teclado de toque quebra a linha (o padrão do textarea)
    if (e.altKey) {
      e.preventDefault();
      const el = e.target;
      const ini = el.selectionStart;
      const fim = el.selectionEnd;
      setTexto(texto.slice(0, ini) + "\n" + texto.slice(fim));
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = ini + 1;
      });
    } else if (!e.shiftKey) {
      e.preventDefault();
      mandar();
    }
  }

  const rotuloDaCaixa = desligado ? "Nova nota, evento ou lembrete" : "Mensagem para o assistente";

  return (
    <div className={styles.raiz}>
      {vinculo && (
        <div className={styles.vinculo}>
          <span className={styles.vinculoRotulo}>
            <Icon name="link" size={12} />
            {desligado ? "Vai para a tarefa" : "Sobre a tarefa"}
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
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={aoTeclar}
          rows={1}
          enterKeyHint={toqueSemTeclado() ? "enter" : "send"}
          aria-label={rotuloDaCaixa}
          aria-keyshortcuts="Control+K Meta+K"
          aria-invalid={longoDemais || undefined}
          placeholder={desligado ? "Nova nota, evento ou lembrete…" : "Peça, pergunte ou anote…"}
          className={styles.texto}
        />
        <div className={styles.acoes}>
          <IconButton
            ref={seletorRef}
            aria-label={vinculo ? "Trocar a tarefa vinculada" : "Vincular a uma tarefa"}
            aria-haspopup="dialog"
            aria-expanded={seletorAberto}
            active={Boolean(vinculo)}
            onClick={() => setSeletorAberto((v) => !v)}
          >
            <Icon name="link" />
          </IconButton>
          <Button
            variant="primary"
            aria-label={desligado ? "Registrar" : esperando ? "Aguardando a resposta" : "Enviar"}
            title={esperando ? "Aguarde a resposta para mandar outra" : undefined}
            className={styles.enviar}
            icon={<Icon name="arrow-up" />}
            loading={salvando}
            disabled={!podeMandar}
            onClick={mandar}
          />
        </div>
      </div>

      <div className={styles.rodape}>
        <div aria-live="polite" className={styles.estado}>
          {desligado ? (
            <>
              <span>Assistente desligado: a caixa salva como nota.</span>
              {detectado && (
                <>
                  <span className={styles.vaiComo}>Vai como</span>
                  <TipoBadge tipo={detectado.type} />
                </>
              )}
              <button type="button" className={styles.link} onClick={onReativar}>
                Tentar o assistente
              </button>
            </>
          ) : esperando ? (
            <span>Aguarde a resposta para mandar outra.</span>
          ) : null}
        </div>
        {texto.length >= AVISO_DE_TAMANHO ? (
          <span className={longoDemais ? styles.contadorExcedido : styles.contador}>
            {texto.length.toLocaleString("pt-BR")}/{TEXTO_MAX.toLocaleString("pt-BR")}
          </span>
        ) : (
          <span className={styles.dica}>Enter envia · Shift+Enter quebra a linha · {atalho} de qualquer tela</span>
        )}
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
