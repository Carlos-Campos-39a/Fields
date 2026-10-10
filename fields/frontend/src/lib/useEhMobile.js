import { useSyncExternalStore } from "react";

// O mesmo corte do monólito (window.innerWidth < 768), mas por matchMedia: só re-renderiza quando
// o lado do corte muda, e não a cada pixel de resize.
const CONSULTA = "(max-width: 767.98px)";

function midia() {
  try {
    return window.matchMedia(CONSULTA);
  } catch {
    return null;
  }
}

function assinar(aviso) {
  const m = midia();
  if (!m) return () => {};
  if (m.addEventListener) m.addEventListener("change", aviso);
  else m.addListener?.(aviso);
  return () => {
    if (m.removeEventListener) m.removeEventListener("change", aviso);
    else m.removeListener?.(aviso);
  };
}

const ler = () => midia()?.matches ?? false;

/** true abaixo de 768px de largura. */
export function useEhMobile() {
  return useSyncExternalStore(assinar, ler, () => false);
}
