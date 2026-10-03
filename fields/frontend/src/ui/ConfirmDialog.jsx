import { useEffect, useId, useRef } from "react";
import styles from "./ConfirmDialog.module.css";
import { Button } from "./Button.jsx";
import { avisarUmaVez, focarSemRolar } from "./util.js";

/**
 * Confirmação modal sobre o <dialog> nativo (showModal): camada de topo, fundo inerte e Tab
 * contido de graça.
 *
 *   <ConfirmDialog open={aberto} tone="danger" title="Excluir projeto?"
 *     description="As frentes e tarefas somem junto." confirmLabel="Excluir"
 *     busy={salvando} onConfirm={excluir} onCancel={() => setAberto(false)} />
 *
 * - Foco inicial: no Cancelar quando `tone="danger"` (o Enter distraído não destrói nada); no
 *   Confirmar nos demais. Ao fechar, o foco volta para quem o tinha antes de abrir.
 * - Escape e clique no fundo chamam `onCancel` — salvo durante `busy`.
 * - Quem manda é a prop `open`: o diálogo nunca se fecha sozinho. Se o navegador o fechar por
 *   fora (o Chrome fecha no segundo Escape seguido), `onCancel` é chamado para o estado alcançar.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}) {
  const dialogoRef = useRef(null);
  const confirmarRef = useRef(null);
  const cancelarRef = useRef(null);
  const pressionouNoFundo = useRef(false);
  const tituloId = useId();
  const descricaoId = useId();

  const abertoRef = useRef(open);
  abertoRef.current = open;
  const ocupadoRef = useRef(busy);
  ocupadoRef.current = busy;
  const cancelarCb = useRef(onCancel);
  cancelarCb.current = onCancel;
  const perigoRef = useRef(tone === "danger");
  perigoRef.current = tone === "danger";

  if (open && !title) {
    avisarUmaVez("UI_DIALOGO_SEM_TITULO", "ConfirmDialog aberto sem title; o diálogo fica sem nome", {});
  }

  // open → showModal + foco; open falso (ou desmontar aberto) → close + foco de volta.
  useEffect(() => {
    if (!open) return undefined;
    const dialogo = dialogoRef.current;
    if (!dialogo) return undefined;
    const anterior = document.activeElement;
    if (!dialogo.open) {
      try {
        dialogo.showModal();
      } catch (erro) {
        avisarUmaVez("UI_DIALOGO_SEM_MODAL", "showModal indisponível; abrindo sem camada modal", {
          motivo: erro?.name ?? "sem showModal",
        });
        dialogo.setAttribute("open", "");
      }
    }
    focarSemRolar((perigoRef.current ? cancelarRef : confirmarRef).current);
    return () => {
      if (dialogo.open) dialogo.close();
      focarSemRolar(anterior);
    };
  }, [open]);

  // Escape (evento cancel) e fechamento por fora do React (evento close).
  useEffect(() => {
    const dialogo = dialogoRef.current;
    if (!dialogo) return undefined;
    const aoCancelar = (e) => {
      e.preventDefault(); // quem fecha é a prop open
      if (!ocupadoRef.current) cancelarCb.current?.();
    };
    const aoFechar = () => {
      // O close disparado pelo nosso próprio cleanup chega depois, com open já falso — ou com o
      // diálogo reaberto (StrictMode monta duas vezes). Nos dois casos, nada a fazer.
      if (abertoRef.current && !dialogo.open) cancelarCb.current?.();
    };
    dialogo.addEventListener("cancel", aoCancelar);
    dialogo.addEventListener("close", aoFechar);
    return () => {
      dialogo.removeEventListener("cancel", aoCancelar);
      dialogo.removeEventListener("close", aoFechar);
    };
  }, []);

  return (
    <dialog
      ref={dialogoRef}
      role="alertdialog"
      className={styles.dialogo}
      aria-labelledby={tituloId}
      aria-describedby={description ? descricaoId : undefined}
      onPointerDown={(e) => {
        pressionouNoFundo.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // O <dialog> não tem padding e o .corpo o preenche: clique no próprio elemento é o fundo.
        const noFundo = pressionouNoFundo.current && e.target === e.currentTarget;
        pressionouNoFundo.current = false;
        if (noFundo && !busy) onCancel?.();
      }}
    >
      <div className={styles.corpo}>
        <h2 id={tituloId} className={styles.titulo}>
          {title}
        </h2>
        {description && (
          <p id={descricaoId} className={styles.descricao}>
            {description}
          </p>
        )}
        {children && <div className={styles.extra}>{children}</div>}
        <div className={styles.acoes}>
          <Button ref={cancelarRef} variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmarRef}
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
