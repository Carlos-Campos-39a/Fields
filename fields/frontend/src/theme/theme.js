// Tema do Fields': a PREFERÊNCIA (light | dark | system) mora em localStorage "fields.tema"; o TEMA
// (light | dark) é o que ela resolve agora, e é o que vai para <html data-theme>.
//
// O script inline do <head> (index.html e ui.html) aplica a mesma regra antes da primeira pintura;
// este módulo assume dali em diante: troca de preferência, acompanhar o sistema quando ela é
// "system" e sincronizar outras abas. Mude a regra nos três lugares juntos.
//
// Sem preferência salva, o tema é CLARO (decisão do plano: "claro por padrão, escuro como opção").
// O @media (prefers-color-scheme) de tokens.css é só a rede para quando o script não roda.

export const CHAVE_TEMA = "fields.tema";
export const PREFERENCIAS = ["light", "dark", "system"];
export const PREFERENCIA_PADRAO = "light";

const CONSULTA_ESCURO = "(prefers-color-scheme: dark)";

// Vale quando o storage está bloqueado: a troca funciona nesta aba, só não persiste.
let preferenciaEmMemoria = null;
let midiaEscuro;
let iniciado = false;
const assinantes = new Set();

function consultaEscuro() {
  if (midiaEscuro !== undefined) return midiaEscuro;
  try {
    midiaEscuro = window.matchMedia(CONSULTA_ESCURO);
  } catch {
    midiaEscuro = null;
  }
  return midiaEscuro;
}

/** Preferência salva (ou a em memória, ou o padrão). Nunca lança. */
export function getPreferencia() {
  try {
    const salva = window.localStorage.getItem(CHAVE_TEMA);
    if (PREFERENCIAS.includes(salva)) return salva;
    if (salva !== null) {
      console.warn("[TEMA_PREFERENCIA_INVALIDA] valor salvo ignorado", {
        evento: "TEMA_PREFERENCIA_INVALIDA",
        valor: salva,
        usado: preferenciaEmMemoria ?? PREFERENCIA_PADRAO,
      });
    }
  } catch {
    // storage bloqueado: cai na memória/padrão abaixo
  }
  return preferenciaEmMemoria ?? PREFERENCIA_PADRAO;
}

/** O tema que uma preferência resolve agora. */
export function resolverTema(preferencia) {
  if (preferencia === "light" || preferencia === "dark") return preferencia;
  return consultaEscuro()?.matches ? "dark" : "light";
}

/** O tema aplicado no <html> neste momento. */
export function getTema() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** A preferência que está aplicada no <html> (a do script inline ou a do último setPreferencia). */
export function getPreferenciaAplicada() {
  const aplicada = document.documentElement.dataset.temaPreferencia;
  return PREFERENCIAS.includes(aplicada) ? aplicada : getPreferencia();
}

function aplicar(preferencia) {
  const tema = resolverTema(preferencia);
  const raiz = document.documentElement;
  raiz.dataset.theme = tema;
  raiz.dataset.temaPreferencia = preferencia;
  raiz.style.colorScheme = tema;
  assinantes.forEach((fn) => fn({ preferencia, tema }));
  return tema;
}

function aoMudarSistema() {
  if (getPreferenciaAplicada() === "system") aplicar("system");
}

function acompanharSistema(ligar) {
  const midia = consultaEscuro();
  if (!midia) return;
  if (midia.removeEventListener) midia.removeEventListener("change", aoMudarSistema);
  else midia.removeListener?.(aoMudarSistema);
  if (!ligar) return;
  if (midia.addEventListener) midia.addEventListener("change", aoMudarSistema);
  else midia.addListener?.(aoMudarSistema);
}

/**
 * Grava e aplica a preferência. Devolve false (com log) para valor fora de PREFERENCIAS — nunca
 * aplica em silêncio um tema que ninguém pediu.
 */
export function setPreferencia(preferencia) {
  if (!PREFERENCIAS.includes(preferencia)) {
    console.warn("[TEMA_PREFERENCIA_RECUSADA] preferência fora da lista", {
      evento: "TEMA_PREFERENCIA_RECUSADA",
      valor: preferencia,
      aceitos: PREFERENCIAS,
    });
    return false;
  }
  preferenciaEmMemoria = preferencia;
  try {
    window.localStorage.setItem(CHAVE_TEMA, preferencia);
  } catch (erro) {
    console.info("[TEMA_STORAGE_INDISPONIVEL] a preferência vale só nesta aba", {
      evento: "TEMA_STORAGE_INDISPONIVEL",
      motivo: erro?.name,
    });
  }
  acompanharSistema(preferencia === "system");
  aplicar(preferencia);
  return true;
}

/**
 * Liga o módulo: reaplica a preferência salva, acompanha o sistema quando ela é "system" e ouve a
 * troca feita em outra aba. Idempotente — chamar duas vezes não duplica ouvinte.
 */
export function iniciarTema() {
  const preferencia = getPreferencia();
  acompanharSistema(preferencia === "system");
  if (!iniciado) {
    iniciado = true;
    window.addEventListener("storage", (evento) => {
      if (evento.key !== CHAVE_TEMA) return;
      const nova = getPreferencia();
      acompanharSistema(nova === "system");
      aplicar(nova);
    });
  }
  return aplicar(preferencia);
}

/** Avisa a cada aplicação de tema. Devolve a função que cancela a assinatura. */
export function assinarTema(fn) {
  assinantes.add(fn);
  return () => assinantes.delete(fn);
}
