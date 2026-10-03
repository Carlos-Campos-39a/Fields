import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Toast.module.css";
import { Icon } from "./icons.jsx";
import { IconButton } from "./IconButton.jsx";
import { avisarUmaVez, cx } from "./util.js";

export const TOAST_TONES = ["neutral", "success", "danger"];
const DURACAO_PADRAO = 4000;
const DURACAO_COM_ACAO = 8000; // tempo de achar o "Desfazer"

/**
 * Um aviso. Normalmente quem renderiza é o ToastProvider; exportado para usos avulsos.
 * `action` = { label, onClick } — o botão sai em --accent-ink e fecha o aviso depois do clique.
 * O tempo pausa com o ponteiro em cima ou com o foco dentro. `duration` 0 ou Infinity = fixo.
 */
export function Toast({ message, tone = "neutral", action, duration = DURACAO_PADRAO, onDismiss, className }) {
  const fecharRef = useRef(onDismiss);
  fecharRef.current = onDismiss;
  const restante = useRef(duration);
  const [sobre, setSobre] = useState(false);
  const [focado, setFocado] = useState(false);
  const pausado = sobre || focado;

  useEffect(() => {
    if (!duration || duration === Infinity || pausado) return undefined;
    const inicio = Date.now();
    const timer = setTimeout(() => fecharRef.current?.(), Math.max(0, restante.current));
    return () => {
      clearTimeout(timer);
      restante.current -= Date.now() - inicio;
    };
  }, [pausado, duration]);

  const icone = tone === "success" ? "check" : tone === "danger" ? "alert" : null;

  return (
    <div
      className={cx(styles.toast, styles[tone], className)}
      onMouseEnter={() => setSobre(true)}
      onMouseLeave={() => setSobre(false)}
      onFocus={() => setFocado(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocado(false);
      }}
    >
      {icone && <Icon name={icone} className={styles.icone} />}
      <span className={styles.mensagem}>{message}</span>
      {action && (
        <button
          type="button"
          className={styles.acao}
          onClick={() => {
            action.onClick?.();
            fecharRef.current?.();
          }}
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <IconButton aria-label="Fechar aviso" size="sm" onClick={() => fecharRef.current?.()}>
          <Icon name="x" />
        </IconButton>
      )}
    </div>
  );
}

const ToastContext = createContext(null);

/**
 * Envolve a aplicação uma vez. Mantém até `max` avisos (os mais antigos saem primeiro) numa
 * região aria-live sempre montada — é ela que faz o leitor de tela anunciar.
 */
export function ToastProvider({ children, max = 3 }) {
  const [itens, setItens] = useState([]);
  const sequencia = useRef(0);

  const dismiss = useCallback((id) => {
    setItens((lista) => lista.filter((t) => t.id !== id));
  }, []);

  /**
   * show("Salvo") ou show({ message, tone, action: { label: "Desfazer", onClick }, duration, id }).
   * Mesmo `id` substitui o aviso anterior. Devolve o id, ou null quando recusa (com log).
   */
  const show = useCallback(
    (entrada) => {
      const opcoes = typeof entrada === "string" ? { message: entrada } : entrada ?? {};
      if (opcoes.message == null || opcoes.message === "") {
        // O conteúdo do aviso é texto do usuário: o log diz só o que faltou.
        avisarUmaVez("UI_TOAST_SEM_MENSAGEM", "aviso sem mensagem; nada foi exibido", {
          tipo: typeof entrada,
        });
        return null;
      }
      let tone = opcoes.tone ?? "neutral";
      if (!TOAST_TONES.includes(tone)) {
        avisarUmaVez("UI_TOAST_TOM_DESCONHECIDO", "tom recusado; usando neutral", { tom: tone, aceitos: TOAST_TONES });
        tone = "neutral";
      }
      if (opcoes.action && !opcoes.action.label) {
        avisarUmaVez("UI_TOAST_ACAO_SEM_ROTULO", "ação sem label; o botão sairia vazio", {});
      }
      sequencia.current += 1;
      const id = opcoes.id ?? `toast-${sequencia.current}`;
      const duration = opcoes.duration ?? (opcoes.action ? DURACAO_COM_ACAO : DURACAO_PADRAO);
      const versao = sequencia.current; // remonta o aviso substituído: tempo e anúncio recomeçam
      setItens((lista) =>
        [...lista.filter((t) => t.id !== id), { ...opcoes, id, versao, tone, duration }].slice(-max),
      );
      return id;
    },
    [max],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <div className={styles.regiao} role="region" aria-label="Avisos" aria-live="polite" aria-relevant="additions text">
            {itens.map((t) => (
              <Toast
                key={`${t.id}:${t.versao}`}
                message={t.message}
                tone={t.tone}
                action={t.action}
                duration={t.duration}
                onDismiss={() => dismiss(t.id)}
              />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

const SEM_PROVIDER = {
  show: () => {
    avisarUmaVez("UI_TOAST_SEM_PROVIDER", "useToast fora do ToastProvider; aviso descartado", {});
    return null;
  },
  dismiss: () => {},
};

/** { show, dismiss }. Fora do ToastProvider não quebra a tela: descarta e loga. */
export function useToast() {
  return useContext(ToastContext) ?? SEM_PROVIDER;
}
