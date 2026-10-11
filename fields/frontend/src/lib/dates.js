// Datas no fuso do Fields (America/Sao_Paulo), qualquer que seja o fuso do navegador.
//
// Duas naturezas de data, e nunca uma pela outra:
//  - DIA de calendário ("YYYY-MM-DD"): entries.date, deadline, start_date, meetings.date. É texto
//    no banco e não tem fuso. Aritmética e formatação dele aqui são em UTC PURO (Date.UTC +
//    timeZone "UTC"), que é só o calendário — o fuso do navegador nunca entra.
//  - INSTANTE (created_at, criado_em): um ponto no tempo. "Que dia/hora é" depende do fuso, e o
//    fuso é o de Brasília, não o do navegador.
// O monólito misturava: `new Date(d + "T00:00:00")` e getDay()/getHours() no fuso do navegador, e
// `toISOString()` para "hoje" — depois das 21h em São Paulo o UTC já é amanhã. Num notebook em
// outro fuso, a Agenda abria na semana errada e "Hoje" marcava o dia errado.

export const FUSO = "America/Sao_Paulo";

const formatador = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function partesLocais(instante) {
  const p = {};
  for (const { type, value } of formatador.formatToParts(instante)) p[type] = value;
  return p;
}

// Monta pelas partes em vez de confiar no formato do locale, que já mudou entre versões do ICU.
/** O DIA ("YYYY-MM-DD") em que um instante cai em São Paulo. */
export function toISODateLocal(date) {
  const p = partesLocais(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hoje em São Paulo. `agora` existe para teste. */
export function hojeISO(agora = new Date()) {
  return toISODateLocal(agora);
}

export function isTodayLocal(iso, agora = new Date()) {
  return iso === hojeISO(agora);
}

/** A hora (0–23) de um instante em São Paulo. */
export function horaLocal(agora = new Date()) {
  return Number(partesLocais(agora).hour);
}

// ─── Dia de calendário ───────────────────────────────────────────────

const ISO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" válido (o mês e o dia existem)? */
export function ehDataISO(v) {
  const m = ISO_DATA.exec(String(v ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// Dia de calendário → Date na meia-noite UTC (só calendário). null se não for "YYYY-MM-DD" válido.
function utc(iso) {
  if (!ehDataISO(iso)) return null;
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d));
}

const paraISO = (d) => d.toISOString().slice(0, 10);

/** Soma n dias a "YYYY-MM-DD". Entrada inválida → null (quem chama decide; nunca "Invalid Date"). */
export function somarDias(iso, n) {
  const d = utc(iso);
  if (!d || !Number.isInteger(n)) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return paraISO(d);
}

/** Dias de `de` até `ate` (ate − de), ou null se alguma não for data. */
export function diferencaEmDias(de, ate) {
  const a = utc(de);
  const b = utc(ate);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

/** 0 (domingo) a 6 (sábado), como getDay(). null se não for data. */
export function diaDaSemana(iso) {
  const d = utc(iso);
  return d ? d.getUTCDay() : null;
}

/** {ano, mes (1–12), dia} de "YYYY-MM-DD", ou null. */
export function partesDaData(iso) {
  const d = utc(iso);
  return d ? { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() } : null;
}

/** A segunda-feira da semana de um dia (a semana da Agenda começa na segunda). */
export function segundaDe(iso) {
  const dow = diaDaSemana(iso);
  if (dow === null) return null;
  return somarDias(iso, dow === 0 ? -6 : 1 - dow);
}

/** A segunda-feira da semana corrente EM SÃO PAULO, como "YYYY-MM-DD". */
export function getMonday(agora = new Date()) {
  return segundaDe(hojeISO(agora));
}

const dataPorExtenso = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
});

/**
 * "YYYY-MM-DD" → "10 de out. de 2026". Vazio → "". Texto que não é data (prazo legado escrito à
 * mão, "sexta") volta como veio: é dado do Carlos, e esconder seria pior que mostrar cru.
 */
export function formatDate(iso) {
  if (!iso) return "";
  const d = utc(iso);
  return d ? dataPorExtenso.format(d) : String(iso);
}

/** "YYYY-MM-DD" → "10/10" (o kanban, onde a largura é curta). Não-data volta como veio. */
export function formatarDiaMes(iso) {
  if (!iso) return "";
  const p = partesDaData(iso);
  if (!p) return String(iso);
  return `${String(p.dia).padStart(2, "0")}/${String(p.mes).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → "10/10/2026" (tabela de projetos). Não-data volta como veio. */
export function formatarDataCurta(iso) {
  if (!iso) return "";
  const p = partesDaData(iso);
  if (!p) return String(iso);
  return `${formatarDiaMes(iso)}/${p.ano}`;
}

/**
 * "YYYY-MM-DD" → "10/10" no ano corrente DE SÃO PAULO, "05/01/2027" fora dele: o ano só aparece
 * quando diz alguma coisa, e a coluna fica estreita. Vazio → "". Texto que não é data (prazo
 * legado, "sexta") volta como veio. Era o mesmo helper duas vezes — dataCurta em entries/ e
 * textoDoPrazo em projects/ —, e duas cópias de regra de data divergem no primeiro conserto.
 */
export function dataCurta(iso, agora = new Date()) {
  if (!iso) return "";
  const p = partesDaData(iso);
  if (!p) return String(iso);
  return p.ano === partesDaData(hojeISO(agora))?.ano ? formatarDiaMes(iso) : formatarDataCurta(iso);
}

/** Hoje, Amanhã, Ontem, "Em N dias" (até 6), ou a data por extenso — sempre contra o hoje de SP. */
export function relativeDate(iso, agora = new Date()) {
  if (!iso) return "";
  const diff = diferencaEmDias(hojeISO(agora), iso);
  if (diff === null) return formatDate(iso);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Amanhã";
  if (diff === -1) return "Ontem";
  if (diff > 0 && diff < 7) return `Em ${diff} dias`;
  return formatDate(iso);
}

// ─── Instante ────────────────────────────────────────────────────────

const dataHora = new Intl.DateTimeFormat("pt-BR", {
  timeZone: FUSO, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});

/** Instante (ISO com fuso, ou Date) → "10 de out., 14:30" na hora de Brasília. Inválido → "". */
export function formatDateTime(instante) {
  if (!instante) return "";
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) return "";
  return dataHora.format(d);
}

/** Bom dia (até 11h59), Boa tarde (até 17h59), Boa noite — pela hora de Brasília. */
export function saudacao(agora = new Date()) {
  const h = horaLocal(agora);
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

// ─── Rótulos de calendário (Agenda) ──────────────────────────────────

export const DIAS_SEMANA_CURTOS = Object.freeze(["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]);
export const MESES_CURTOS = Object.freeze(["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]);

/** Semana de 7 dias a partir de `inicio` → "6–12 Out 2026" ou "29 Set – 5 Out 2026". */
export function rotuloDaSemana(inicio) {
  const a = partesDaData(inicio);
  const b = partesDaData(somarDias(inicio, 6));
  if (!a || !b) return "";
  if (a.mes === b.mes) return `${a.dia}–${b.dia} ${MESES_CURTOS[a.mes - 1]} ${a.ano}`;
  return `${a.dia} ${MESES_CURTOS[a.mes - 1]} – ${b.dia} ${MESES_CURTOS[b.mes - 1]} ${b.ano}`;
}
