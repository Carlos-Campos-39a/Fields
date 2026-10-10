// As cinco vistas de primeiro nível — as MESMAS na barra lateral (desktop) e na barra inferior
// (celular). Uma lista só: no monólito o celular escondia Projetos, Agenda e Kanban porque cada
// barra tinha a sua cópia e só uma delas era mostrada por vez.
//
// "Cards" não está aqui de propósito: é outra EXIBIÇÃO das notas (#/cards), e não outra vista.
// Ela mora no seletor Lista/Cards do TopBar e no menu "Mais" do celular.

export const VISTAS = Object.freeze([
  { view: "home", icone: "home", label: "Home" },
  { view: "notas", icone: "note", label: "Notas" },
  { view: "projetos", icone: "folder", label: "Projetos" },
  { view: "kanban", icone: "columns", label: "Kanban" },
  { view: "agenda", icone: "calendar", label: "Agenda" },
]);

/** A vista `view` está ativa na rota? #/cards conta como Notas (são as mesmas entradas). */
export function vistaAtiva(rota, view) {
  if (view === "notas") return rota.view === "notas" || rota.view === "cards";
  return rota.view === view;
}
