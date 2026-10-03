// Datas no fuso do Carlos, sem depender do TZ do processo (o Railway roda em UTC).
// Antes, "hoje" era new Date().toISOString().split("T")[0] — o dia em UTC: das 21h à meia-noite
// de Brasília o padrão das entradas e o filtro de "próximos" já estavam no dia seguinte.

export const FUSO = "America/Sao_Paulo";

const formato = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

const ISO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

function partes(agora) {
  const p = {};
  for (const { type, value } of formato.formatToParts(agora)) p[type] = value;
  return p;
}

/** "YYYY-MM-DD" do dia corrente em America/Sao_Paulo. */
export function hojeISO(agora = new Date()) {
  const p = partes(agora);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Data e hora de parede em America/Sao_Paulo: {data:"YYYY-MM-DD", hora:"HH:MM", segundos:"SS"}. */
export function agoraLocal(agora = new Date()) {
  const p = partes(agora);
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}`, segundos: p.second };
}

/** Soma n dias a uma data de calendário "YYYY-MM-DD" (aritmética pura, sem fuso). */
export function somarDias(iso, n) {
  const m = ISO_DATA.exec(String(iso));
  if (!m || !Number.isInteger(n)) throw new TypeError("somarDias: esperado ('YYYY-MM-DD', inteiro)");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}
