import { avisarUmaVez } from "../lib/log.js";

// A APARÊNCIA de cada tipo de entrada (ícone e tom do Badge). Só aparência: QUAIS tipos existem e
// o RÓTULO de cada um vêm da ontologia (useOntologia → enums.tipo_entrada, rotulo("tipo_entrada")).
// Tipo novo no backend aparece com o rótulo certo e a aparência padrão até ganhar linha aqui — e o
// console diz qual faltou.
const APARENCIA = Object.freeze({
  note: { icone: "note", tom: "accent" },
  event: { icone: "calendar", tom: "neutral" },
  reminder: { icone: "bell", tom: "warning" },
  lang_fr: { icone: "flag", tom: "info", bandeira: "🇫🇷" },
  lang_jp: { icone: "flag", tom: "danger", bandeira: "🇯🇵" },
});

const PADRAO = Object.freeze({ icone: "note", tom: "neutral" });

/** {icone, tom, bandeira?} de um tipo. Tipo sem aparência (ou nulo) → padrão, com log uma vez. */
export function aparenciaDoTipo(tipo) {
  const a = APARENCIA[tipo];
  if (a) return a;
  avisarUmaVez("TIPO_SEM_APARENCIA", "tipo de entrada sem ícone/tom; usando o padrão", { tipo: tipo ?? null });
  return PADRAO;
}

/** Os tipos de língua formam o submenu "Línguas" do filtro (lang_fr, lang_jp…). */
export function ehLingua(tipo) {
  return typeof tipo === "string" && tipo.startsWith("lang_");
}
