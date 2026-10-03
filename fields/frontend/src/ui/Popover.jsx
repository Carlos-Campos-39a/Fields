import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Popover.module.css";
import { Icon } from "./icons.jsx";
import { avisarUmaVez, cx, focarSemRolar, focaveis } from "./util.js";

const MARGEM = 8; // distância mínima da borda da janela

/**
 * Posição de um popover `caixa` ({width, height}) junto a uma âncora (DOMRect), dentro do
 * `viewport` ({width, height}). Prefere `side`; vira para o outro lado quando não cabe E o outro
 * lado tem mais espaço. Depois, prende nas bordas com MARGEM. Pura — sem DOM.
 */
export function calcularPosicao(ancora, caixa, viewport, { side = "bottom", align = "start", offset = 6 } = {}) {
  const espacoAbaixo = viewport.height - ancora.bottom - offset - MARGEM;
  const espacoAcima = ancora.top - offset - MARGEM;

  let lado = side === "top" ? "top" : "bottom";
  if (lado === "bottom" && caixa.height > espacoAbaixo && espacoAcima > espacoAbaixo) lado = "top";
  else if (lado === "top" && caixa.height > espacoAcima && espacoAbaixo > espacoAcima) lado = "bottom";

  let top = lado === "bottom" ? ancora.bottom + offset : ancora.top - offset - caixa.height;
  top = Math.min(Math.max(top, MARGEM), Math.max(MARGEM, viewport.height - MARGEM - caixa.height));

  let left;
  if (align === "end") left = ancora.right - caixa.width;
  else if (align === "center") left = ancora.left + ancora.width / 2 - caixa.width / 2;
  else left = ancora.left;
  left = Math.min(Math.max(left, MARGEM), Math.max(MARGEM, viewport.width - MARGEM - caixa.width));

  return { top: Math.round(top), left: Math.round(left), lado };
}

/**
 * O ÚNICO popover do Fields' — status, seletor de tarefa, menu de ações, tudo passa por aqui.
 *
 *   const ref = useRef(null);
 *   <Button ref={ref} aria-expanded={aberto} aria-controls="pop-status" onClick={() => setAberto(v => !v)}>…</Button>
 *   <Popover id="pop-status" open={aberto} onClose={() => setAberto(false)} anchorRef={ref} label="Mudar status">…</Popover>
 *
 * - Portal em document.body, position: fixed, abaixo da âncora; vira para cima quando não cabe.
 *   Reposiciona em scroll (qualquer contêiner), resize e mudança de tamanho do conteúdo.
 * - Fecha com clique fora (a âncora não conta como fora: quem alterna é ela) e com Escape.
 *   `onClose(motivo)` recebe "fora" ou "esc".
 * - Foco: entra no primeiro item focável (ou no contêiner); Tab circula dentro; ao fechar, volta
 *   para a âncora — sempre no Escape, e no clique fora só se o foco tiver ficado órfão (não rouba
 *   o foco de quem o usuário clicou).
 * - Aninhável: um popover aberto de dentro de outro não fecha o de fora (clique e Escape seguem a
 *   árvore React, não a do DOM).
 *
 * `initialFocus`: "first" (padrão) | "container" | "none" | uma ref.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  side = "bottom",
  align = "start",
  offset = 6,
  role = "dialog",
  label,
  labelledBy,
  id,
  initialFocus = "first",
  width,
  className,
  children,
}) {
  const caixaRef = useRef(null);
  const cliqueDentro = useRef(false);
  const devolverFoco = useRef(false);
  const fecharRef = useRef(onClose);
  fecharRef.current = onClose;
  const focoInicialRef = useRef(initialFocus);
  focoInicialRef.current = initialFocus;
  const [pos, setPos] = useState(null);

  const reposicionar = useCallback(() => {
    const ancora = anchorRef?.current;
    const caixa = caixaRef.current;
    if (!ancora || !caixa) return;
    const proximo = calcularPosicao(
      ancora.getBoundingClientRect(),
      { width: caixa.offsetWidth, height: caixa.offsetHeight },
      { width: document.documentElement.clientWidth, height: window.innerHeight },
      { side, align, offset },
    );
    setPos((atual) =>
      atual && atual.top === proximo.top && atual.left === proximo.left && atual.lado === proximo.lado
        ? atual
        : proximo,
    );
  }, [anchorRef, side, align, offset]);

  // Posição antes da pintura: o popover nunca aparece em (0,0).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    if (!anchorRef?.current) {
      avisarUmaVez("UI_POPOVER_SEM_ANCORA", "popover aberto sem âncora montada; fica invisível", {
        id: id ?? null,
      });
      return;
    }
    reposicionar();
  }, [open, reposicionar, anchorRef, id]);

  // Acompanha scroll, resize e o tamanho do conteúdo/âncora.
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener("resize", reposicionar);
    window.addEventListener("scroll", reposicionar, true);
    let observador;
    if (typeof ResizeObserver !== "undefined") {
      observador = new ResizeObserver(() => reposicionar());
      if (caixaRef.current) observador.observe(caixaRef.current);
      if (anchorRef?.current) observador.observe(anchorRef.current);
    }
    return () => {
      window.removeEventListener("resize", reposicionar);
      window.removeEventListener("scroll", reposicionar, true);
      observador?.disconnect();
    };
  }, [open, reposicionar, anchorRef]);

  // Clique fora e Escape com o foco fora do popover (o Escape de dentro é tratado no onKeyDown,
  // que chega antes e marca defaultPrevented).
  useEffect(() => {
    if (!open) return undefined;
    const aoPressionar = (e) => {
      const caixa = caixaRef.current;
      if (cliqueDentro.current || (caixa && caixa.contains(e.target))) return;
      if (anchorRef?.current?.contains(e.target)) return;
      fecharRef.current?.("fora");
    };
    const aoTeclar = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      devolverFoco.current = true;
      fecharRef.current?.("esc");
    };
    document.addEventListener("pointerdown", aoPressionar);
    document.addEventListener("keydown", aoTeclar);
    return () => {
      document.removeEventListener("pointerdown", aoPressionar);
      document.removeEventListener("keydown", aoTeclar);
    };
  }, [open, anchorRef]);

  // Foco: entra ao abrir; ao fechar, devolve à âncora.
  useEffect(() => {
    if (!open) return undefined;
    const caixa = caixaRef.current;
    const ancora = anchorRef?.current ?? null;
    devolverFoco.current = false;
    const inicial = focoInicialRef.current;
    if (caixa && inicial !== "none") {
      let alvo;
      if (inicial === "container") alvo = caixa;
      else if (inicial && typeof inicial === "object") alvo = inicial.current;
      else alvo = focaveis(caixa)[0];
      focarSemRolar(alvo ?? caixa);
    }
    return () => {
      const ativo = document.activeElement;
      const focoOrfao = !ativo || ativo === document.body || (caixa && caixa.contains(ativo));
      if (devolverFoco.current || focoOrfao) focarSemRolar(ancora);
    };
  }, [open, anchorRef]);

  const marcarCliqueDentro = () => {
    // Vale para portais aninhados (o evento sintético sobe pela árvore React). Zera depois que o
    // pointerdown terminar de propagar até o document.
    cliqueDentro.current = true;
    setTimeout(() => {
      cliqueDentro.current = false;
    }, 0);
  };

  const aoTeclarDentro = (e) => {
    if (e.defaultPrevented) return; // um popover aninhado já tratou (o evento sobe pela árvore React)
    if (e.key === "Escape") {
      e.preventDefault(); // ouvintes de document (e um <dialog> por fora) já sabem que foi tratado
      e.stopPropagation(); // o popover de fora, na árvore React, não fecha junto
      devolverFoco.current = true;
      fecharRef.current?.("esc");
      return;
    }
    if (e.key === "Tab") {
      const lista = focaveis(caixaRef.current);
      if (lista.length === 0) {
        e.preventDefault();
        return;
      }
      const primeiro = lista[0];
      const ultimo = lista[lista.length - 1];
      const ativo = document.activeElement;
      if (e.shiftKey && (ativo === primeiro || ativo === caixaRef.current)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && ativo === ultimo) {
        e.preventDefault();
        primeiro.focus();
      }
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={caixaRef}
      id={id}
      role={role || undefined}
      aria-label={label}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      data-lado={pos?.lado ?? side}
      className={cx(styles.popover, className)}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width,
        // Antes de medir: invisível mas focável (visibility:hidden recusaria o foco inicial).
        opacity: pos ? undefined : 0,
        pointerEvents: pos ? undefined : "none",
      }}
      onPointerDown={marcarCliqueDentro}
      onKeyDown={aoTeclarDentro}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * Linha clicável dentro do Popover. `selected` mostra o check e marca aria-current.
 */
export const PopoverItem = forwardRef(function PopoverItem(
  { icon, selected = false, type = "button", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(styles.item, className)}
      aria-current={selected ? "true" : undefined}
      {...rest}
    >
      {icon}
      <span className={styles.itemTexto}>{children}</span>
      {selected && <Icon name="check" className={styles.check} />}
    </button>
  );
});
