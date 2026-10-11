import { afterAll, describe, expect, it } from "vitest";
import {
  dataCurta, diaDaSemana, diferencaEmDias, ehDataISO, formatarDataCurta, formatarDiaMes, formatDate, formatDateTime,
  getMonday, hojeISO, horaLocal, isTodayLocal, relativeDate, rotuloDaSemana, saudacao, segundaDe, somarDias,
} from "./dates.js";

// Sábado, 10/10/2026, 22:30 em São Paulo — e já domingo, 11/10, em UTC. É a hora em que o monólito
// errava: toISOString() dava amanhã, e getDay()/getHours() seguiam o fuso do navegador.
const SAB_2230_SP = new Date("2026-10-11T01:30:00Z");

describe("hoje e hora em São Paulo", () => {
  it("o dia é o de SP, não o de UTC", () => {
    expect(hojeISO(SAB_2230_SP)).toBe("2026-10-10");
    expect(isTodayLocal("2026-10-10", SAB_2230_SP)).toBe(true);
    expect(isTodayLocal("2026-10-11", SAB_2230_SP)).toBe(false);
    expect(horaLocal(SAB_2230_SP)).toBe(22);
  });

  it.each([
    ["2026-10-10T14:59:00Z", "Bom dia"], // 11:59
    ["2026-10-10T15:00:00Z", "Boa tarde"], // 12:00
    ["2026-10-10T20:59:00Z", "Boa tarde"], // 17:59
    ["2026-10-10T21:00:00Z", "Boa noite"], // 18:00
    ["2026-10-11T01:30:00Z", "Boa noite"], // 22:30
    ["2026-10-11T03:00:00Z", "Bom dia"], // 00:00
  ])("saudação às %s → %s", (instante, esperado) => {
    expect(saudacao(new Date(instante))).toBe(esperado);
  });
});

describe("getMonday (semana da Agenda)", () => {
  it("sábado à noite em SP ainda é a semana de segunda 05/10", () => {
    expect(getMonday(SAB_2230_SP)).toBe("2026-10-05");
  });
  it("domingo 23:59 em SP é o fim da semana, não o começo da próxima", () => {
    expect(getMonday(new Date("2026-10-12T02:59:00Z"))).toBe("2026-10-05");
  });
  it("segunda 00:00 em SP abre a semana nova", () => {
    expect(getMonday(new Date("2026-10-12T03:00:00Z"))).toBe("2026-10-12");
  });
  it("segundaDe atravessa mês e ano", () => {
    expect(segundaDe("2026-11-01")).toBe("2026-10-26");
    expect(segundaDe("2027-01-02")).toBe("2026-12-28");
    expect(segundaDe("lixo")).toBeNull();
  });
});

describe("relativeDate", () => {
  it.each([
    ["2026-10-10", "Hoje"],
    ["2026-10-11", "Amanhã"],
    ["2026-10-09", "Ontem"],
    ["2026-10-13", "Em 3 dias"],
    ["2026-10-16", "Em 6 dias"],
  ])("%s → %s (contra o hoje de SP)", (iso, esperado) => {
    expect(relativeDate(iso, SAB_2230_SP)).toBe(esperado);
  });
  it("longe, ou no passado, vira a data por extenso", () => {
    expect(relativeDate("2026-10-17", SAB_2230_SP)).toBe(formatDate("2026-10-17"));
    expect(relativeDate("2026-10-01", SAB_2230_SP)).toBe(formatDate("2026-10-01"));
  });
  it("vazio e texto livre não quebram", () => {
    expect(relativeDate("", SAB_2230_SP)).toBe("");
    expect(relativeDate(null, SAB_2230_SP)).toBe("");
    expect(relativeDate("sexta", SAB_2230_SP)).toBe("sexta");
  });
});

describe("formatação", () => {
  it("formatDate: dia por extenso, sem 'Invalid Date' para texto livre", () => {
    expect(formatDate("2026-10-10")).toMatch(/^10 de out\.? de 2026$/);
    expect(formatDate("2026-01-05")).toMatch(/^05 de jan\.? de 2026$/);
    expect(formatDate("sexta")).toBe("sexta");
    expect(formatDate("2026-02-30")).toBe("2026-02-30");
    expect(formatDate(null)).toBe("");
  });
  it("dd/mm e dd/mm/aaaa", () => {
    expect(formatarDiaMes("2026-10-05")).toBe("05/10");
    expect(formatarDataCurta("2026-10-05")).toBe("05/10/2026");
    expect(formatarDiaMes("fim do mês")).toBe("fim do mês");
    expect(formatarDataCurta("")).toBe("");
  });
  it("formatDateTime: o instante na hora de Brasília", () => {
    const texto = formatDateTime("2026-10-11T01:30:00Z");
    expect(texto).toContain("10");
    expect(texto).toContain("22:30");
    expect(formatDateTime("lixo")).toBe("");
    expect(formatDateTime(null)).toBe("");
  });
  it("formatDate também é o prazo por extenso (dica e leitor de tela da tabela de projetos)", () => {
    expect(formatDate("2026-10-20")).toMatch(/20 de out\.? de 2026/);
    expect(formatDate("fim do mês")).toBe("fim do mês");
  });
  it("rótulo da semana: mesmo mês, meses e anos diferentes", () => {
    expect(rotuloDaSemana("2026-10-05")).toBe("5–11 Out 2026");
    expect(rotuloDaSemana("2026-09-28")).toBe("28 Set – 4 Out 2026");
    expect(rotuloDaSemana("2026-12-28")).toBe("28 Dez – 3 Jan 2027");
  });
});

// Os casos de entries/ (lista, cartões, relacionadas) e de projects/ (prazo na tabela) juntos: era
// o mesmo helper duas vezes, dataCurta e textoDoPrazo.
describe("dataCurta (dd/mm no ano corrente de SP)", () => {
  it("dd/mm no ano corrente de São Paulo", () => {
    expect(dataCurta("2026-03-05", SAB_2230_SP)).toBe("05/03");
    expect(dataCurta("2026-10-20", SAB_2230_SP)).toBe("20/10");
  });
  it("dd/mm/aaaa fora do ano corrente", () => {
    expect(dataCurta("2025-12-31", SAB_2230_SP)).toBe("31/12/2025");
    expect(dataCurta("2027-01-05", SAB_2230_SP)).toBe("05/01/2027");
  });
  it("31/12 às 22h em SP ainda é o ano velho", () => {
    // 01/01/2027 01:00 UTC = 31/12/2026 22:00 em SP.
    const virada = new Date("2027-01-01T01:00:00Z");
    expect(dataCurta("2026-12-31", virada)).toBe("31/12");
    expect(dataCurta("2027-01-02", virada)).toBe("02/01/2027");
  });
  it("vazio vira vazio; texto que não é data volta como veio", () => {
    expect(dataCurta(null, SAB_2230_SP)).toBe("");
    expect(dataCurta("", SAB_2230_SP)).toBe("");
    expect(dataCurta("sexta", SAB_2230_SP)).toBe("sexta");
    expect(dataCurta("2026-02-30", SAB_2230_SP)).toBe("2026-02-30");
  });
});

describe("aritmética de calendário", () => {
  it("somarDias atravessa mês, ano e 29/02", () => {
    expect(somarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(somarDias("2028-02-28", 1)).toBe("2028-02-29");
    expect(somarDias("2026-03-01", -1)).toBe("2026-02-28");
    expect(somarDias("lixo", 1)).toBeNull();
    expect(somarDias("2026-01-01", 1.5)).toBeNull();
  });
  it("diaDaSemana, diferencaEmDias, ehDataISO", () => {
    expect(diaDaSemana("2026-10-10")).toBe(6);
    expect(diaDaSemana("2026-10-12")).toBe(1);
    expect(diferencaEmDias("2026-10-10", "2026-11-10")).toBe(31);
    expect(diferencaEmDias("x", "2026-11-10")).toBeNull();
    expect(ehDataISO("2026-02-29")).toBe(false);
    expect(ehDataISO("2028-02-29")).toBe(true);
    expect(ehDataISO("2026-1-1")).toBe(false);
  });
});

describe("o fuso do navegador não entra", () => {
  const tzOriginal = process.env.TZ;
  afterAll(() => {
    if (tzOriginal === undefined) delete process.env.TZ;
    else process.env.TZ = tzOriginal;
  });

  const amostra = () => [
    hojeISO(SAB_2230_SP), getMonday(SAB_2230_SP), saudacao(SAB_2230_SP), relativeDate("2026-10-11", SAB_2230_SP),
    formatDate("2026-10-10"), formatarDiaMes("2026-10-10"), diaDaSemana("2026-10-10"), formatDateTime("2026-10-11T01:30:00Z"),
  ];

  it("Kiritimati (UTC+14) e Pago Pago (UTC−11) dão o mesmo resultado", () => {
    process.env.TZ = "Pacific/Kiritimati";
    const leste = amostra();
    const offsetLeste = new Date(2026, 9, 10).getTimezoneOffset();
    process.env.TZ = "Pacific/Pago_Pago";
    const oeste = amostra();
    const offsetOeste = new Date(2026, 9, 10).getTimezoneOffset();
    expect(offsetLeste).not.toBe(offsetOeste); // o fuso do processo mudou de fato
    expect(leste).toEqual(oeste);
    expect(leste.slice(0, 4)).toEqual(["2026-10-10", "2026-10-05", "Boa noite", "Amanhã"]);
  });
});
