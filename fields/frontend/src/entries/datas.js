import { dataCurta, diferencaEmDias, formatarDataCurta, hojeISO, partesDaData } from "../lib/dates.js";

// As datas da pasta entries/ em dd/mm, contra o HOJE DE SÃO PAULO (lib/dates.js), nunca contra o
// relógio do navegador. entries.date é um DIA de calendário ("YYYY-MM-DD", texto sem fuso) e
// entries.time é a hora do compromisso ("HH:MM", também sem fuso): nenhum dos dois passa por Date
// local aqui. O dd/mm em si (dataCurta) mora em lib/dates.js — projects/ usa o mesmo.
//
// Texto que não é data (o banco antigo aceitava qualquer coisa) volta como veio: é dado do Carlos,
// e esconder seria pior que mostrar cru.

/** Hoje, Amanhã, Ontem, "Em N dias" (2 a 6) — e, fora dessa janela, dataCurta. */
export function dataRelativa(iso, agora = new Date()) {
  if (!iso) return "";
  const diff = diferencaEmDias(hojeISO(agora), iso);
  if (diff === null) return String(iso);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Amanhã";
  if (diff === -1) return "Ontem";
  if (diff > 1 && diff < 7) return `Em ${diff} dias`;
  return dataCurta(iso, agora);
}

const HORA = /^(\d{2}):(\d{2})(:\d{2}(\.\d+)?)?$/;

/** "14:00:00" → "14:00". Vazio → "". Hora escrita à mão ("14h") volta como veio. */
export function horaCurta(hora) {
  if (!hora) return "";
  const m = HORA.exec(String(hora).trim());
  return m ? `${m[1]}:${m[2]}` : String(hora);
}

/**
 * A linha de data de uma entrada aberta: "Amanhã · 11/10/2026 · 14:00". O relativo só aparece
 * quando diz algo que a data completa não diz (Hoje, Ontem, Em 3 dias); longe disso, só a data.
 */
export function descreverData(iso, hora, agora = new Date()) {
  if (!iso) return horaCurta(hora);
  const completa = formatarDataCurta(iso);
  const relativa = dataRelativa(iso, agora);
  const partes = [];
  if (partesDaData(iso) && relativa !== dataCurta(iso, agora)) partes.push(relativa);
  partes.push(completa);
  if (hora) partes.push(horaCurta(hora));
  return partes.join(" · ");
}
