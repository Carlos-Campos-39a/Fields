import { useCallback, useEffect, useRef, useState } from "react";
import { avisar } from "./log.js";

// Rota por hash. É hash, e não history API, porque o front sai estático da Vercel: um F5 em
// /projetos pediria ao servidor um arquivo que não existe, e #/projetos nunca sai do navegador.
//
//   #/              home
//   #/notas         lista de notas (no celular é a tela da lista; no desktop, o vazio do painel)
//   #/notas/:id     uma entrada aberta
//   #/cards         as entradas em cartões
//   #/projetos      #/kanban      #/agenda
//
// No monólito a "rota" eram quatro booleanos (showHome, activeView, showCards, activeEntry) que
// se contradiziam: abrir uma nota com Projetos ativo não mostrava a nota (openEntry não mexia na
// view), e o F5 sempre voltava à home. Aqui a rota é a única verdade, e o voltar do navegador anda.

export const VIEWS = Object.freeze(["home", "notas", "cards", "projetos", "kanban", "agenda"]);

// view → segmento da URL. Só "notas" aceita id.
const SEGMENTO = Object.freeze({
  home: "", notas: "notas", cards: "cards", projetos: "projetos", kanban: "kanban", agenda: "agenda",
});
const VIEW_DO_SEGMENTO = Object.freeze(
  Object.fromEntries(Object.entries(SEGMENTO).filter(([, s]) => s).map(([v, s]) => [s, v])),
);

const HOME = Object.freeze({ view: "home", id: null });

function decodificar(texto) {
  try {
    return decodeURIComponent(texto);
  } catch {
    return null; // %E0%A4%A sem par: não é um id que a API devolveu
  }
}

/**
 * "#/notas/abc" → {view: "notas", id: "abc"}. Pura.
 * Rota que não existe vira a home com `desconhecida: true` (e o segmento, para o log): o hook
 * normaliza a URL e diz no console o que recusou — nunca uma tela em branco muda.
 */
export function parseHash(hash) {
  const caminho = String(hash ?? "")
    .replace(/^#/, "")
    .split("?")[0]
    .replace(/^\/+|\/+$/g, "");
  if (caminho === "") return HOME;
  const [segmento, id, ...resto] = caminho.split("/");
  const view = VIEW_DO_SEGMENTO[segmento.toLowerCase()];
  if (!view) return { ...HOME, desconhecida: true, segmento };
  if (id === undefined) return { view, id: null };
  if (view === "notas" && resto.length === 0) {
    const decodificado = decodificar(id);
    if (decodificado) return { view, id: decodificado };
  }
  // Segmento a mais (#/projetos/x) ou id ilegível: a view vale, o resto é recusado.
  return { view, id: null, desconhecida: true, segmento };
}

/** {view, id} → "#/notas/abc". Pura. View fora de VIEWS vira a home. */
export function formatHash({ view, id = null } = {}) {
  const segmento = SEGMENTO[view];
  if (segmento === undefined || segmento === "") return "#/";
  if (view === "notas" && id) return `#/notas/${encodeURIComponent(id)}`;
  return `#/${segmento}`;
}

/** Duas rotas levam à mesma tela? (ignora as marcas de recusa) */
export function mesmaRota(a, b) {
  return a?.view === b?.view && (a?.id ?? null) === (b?.id ?? null);
}

function lerRota() {
  return typeof window === "undefined" ? HOME : parseHash(window.location.hash);
}

// ─── Saída segurada ──────────────────────────────────────────────────
// Uma tela com alteração NÃO SALVA (o EditForm da entrada) registra uma guarda enquanto estiver
// suja. Com guarda, trocar de rota não acontece na hora: o shell pergunta e só segue se o Carlos
// descartar. Antes, clicar outra entrada na lista (ou anterior/próxima, ou uma vista) desmontava o
// formulário e a edição sumia sem aviso nenhum.
//
// Registro de MÓDULO, e não contexto: há uma rota por aba, e quem segura (o formulário, fundo na
// árvore) fica longe de tudo o que navega — a lista, o topo, a barra inferior, o voltar do navegador.
const guardas = new Set();

/** Alguma tela está segurando a saída? */
export function saidaSegurada() {
  return guardas.size > 0;
}

/** Registra uma guarda; devolve a função que a solta. Soltar duas vezes não faz mal. */
export function segurarSaida() {
  const guarda = {};
  guardas.add(guarda);
  return () => {
    guardas.delete(guarda);
  };
}

/**
 * Enquanto `ativa`, trocar de rota pede confirmação (o ConfirmDialog do App) e fechar ou recarregar
 * a aba pede a do navegador (beforeunload — o texto dela é do navegador, não nosso).
 */
export function useGuardaDeSaida(ativa) {
  useEffect(() => {
    if (!ativa) return undefined;
    const soltar = segurarSaida();
    const aoDescarregar = (e) => {
      e.preventDefault();
      e.returnValue = ""; // Chrome < 119 só mostra o aviso com returnValue
    };
    window.addEventListener("beforeunload", aoDescarregar);
    return () => {
      soltar();
      window.removeEventListener("beforeunload", aoDescarregar);
    };
  }, [ativa]);
}

/**
 * { rota: {view, id}, navegar(destino, {substituir}), saidaPendente, confirmarSaida(), ficar() }.
 * `destino` é {view, id} ou um hash pronto. `substituir` troca a entrada do histórico em vez de
 * empilhar (redirecionamento, item excluído).
 *
 * Com a saída segurada (useGuardaDeSaida), a troca vira `saidaPendente: true` e espera:
 * `confirmarSaida()` segue para o destino, `ficar()` desiste. Quem mostra a pergunta é o App.
 */
export function useHashRoute() {
  const [rota, setRota] = useState(lerRota);
  const rotaRef = useRef(rota);
  rotaRef.current = rota;
  const [pendente, setPendente] = useState(null); // {hash, substituir}
  const pendenteRef = useRef(null);
  pendenteRef.current = pendente;
  // A próxima hashchange já foi confirmada pelo Carlos: passa mesmo com a guarda ainda montada (o
  // formulário só desmonta DEPOIS que a rota troca).
  const liberada = useRef(false);

  const segurar = useCallback((hash, substituir, origem) => {
    avisar("SAIDA_SEGURADA", "troca de rota com alteração não salva; pedindo confirmação", {
      origem,
      destino: parseHash(hash).view,
    });
    setPendente({ hash, substituir });
  }, []);

  useEffect(() => {
    const aoMudar = (e) => {
      if (liberada.current) {
        liberada.current = false;
      } else if (saidaSegurada() && !mesmaRota(lerRota(), rotaRef.current)) {
        // Link <a href="#/…">, voltar/avançar e hash digitado chegam com a URL JÁ trocada: ela
        // volta para a da tela (sem empilhar; a rota em estado nem chegou a mudar) e o destino
        // espera a confirmação. Custo aceito: o histórico fica com a tela atual repetida (link)
        // ou perde o passo anterior (voltar) — um passo de histórico vale menos que a edição.
        const destino = window.location.hash || "#/";
        window.history.replaceState(null, "", formatHash(rotaRef.current));
        segurar(destino, false, "url");
        return;
      }
      setRota(lerRota());
    };
    window.addEventListener("hashchange", aoMudar);
    return () => window.removeEventListener("hashchange", aoMudar);
  }, [segurar]);

  // Rota recusada: diz o quê (só o segmento — o resto pode ser qualquer coisa colada na barra) e
  // reescreve a URL para a rota canônica, sem empilhar histórico.
  useEffect(() => {
    if (!rota.desconhecida) return;
    avisar("ROTA_DESCONHECIDA", "hash fora das rotas conhecidas; normalizado", {
      segmento: rota.segmento ?? null,
      usada: rota.view,
    });
    const canonica = { view: rota.view, id: rota.id };
    window.history.replaceState(null, "", formatHash(canonica));
    setRota(canonica);
  }, [rota]);

  // Sem guarda (ou já confirmada): troca de fato.
  const ir = useCallback((hash, substituir) => {
    const atual = window.location.hash || "#/";
    if (hash === atual) return;
    if (substituir) {
      // replaceState não dispara hashchange: o estado acompanha à mão.
      window.history.replaceState(null, "", hash);
      setRota(parseHash(hash));
    } else {
      liberada.current = saidaSegurada();
      window.location.hash = hash; // dispara hashchange → setRota
    }
  }, []);

  const navegar = useCallback((destino, { substituir = false } = {}) => {
    const hash = typeof destino === "string" ? destino : formatHash(destino);
    const atual = window.location.hash || "#/";
    if (hash === atual) return;
    if (saidaSegurada()) {
      segurar(hash, substituir, "navegar");
      return;
    }
    ir(hash, substituir);
  }, [ir, segurar]);

  const confirmarSaida = useCallback(() => {
    const p = pendenteRef.current;
    setPendente(null);
    if (p) ir(p.hash, p.substituir);
  }, [ir]);

  const ficar = useCallback(() => setPendente(null), []);

  return { rota, navegar, saidaPendente: pendente !== null, confirmarSaida, ficar };
}
