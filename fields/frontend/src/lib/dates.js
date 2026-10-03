// Datas de calendário no fuso do Fields (America/Sao_Paulo).
//
// `toISOString()` devolve o dia em UTC: depois das 21h em São Paulo ele já é "amanhã".
// Para DIA (YYYY-MM-DD) use estas funções; para INSTANTE (created_at) o ISO em UTC continua certo.

const FUSO = "America/Sao_Paulo";

const formatador = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit",
});

// Monta pelas partes em vez de confiar no formato do locale, que já mudou entre versões do ICU.
export function toISODateLocal(date) {
  const p = {};
  for (const { type, value } of formatador.formatToParts(date)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function hojeISO() {
  return toISODateLocal(new Date());
}

export function isTodayLocal(iso) {
  return iso === hojeISO();
}
