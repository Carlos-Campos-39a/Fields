import { describe, expect, it } from "vitest";
import { dataRelativa, descreverData, horaCurta } from "./datas.js";

// Sábado, 10/10/2026, 22:30 em São Paulo — e já domingo, 11/10, em UTC. Se alguma função usasse o
// relógio do navegador (ou toISOString), "Hoje" cairia no dia 11.
// (Os casos de dataCurta foram com ela para lib/dates.test.js.)
const SAB_2230_SP = new Date("2026-10-11T01:30:00Z");

describe("dataRelativa", () => {
  it.each([
    ["2026-10-10", "Hoje"],
    ["2026-10-11", "Amanhã"],
    ["2026-10-09", "Ontem"],
    ["2026-10-12", "Em 2 dias"],
    ["2026-10-16", "Em 6 dias"],
    ["2026-10-17", "17/10"],
    ["2026-10-08", "08/10"],
    ["2027-01-15", "15/01/2027"],
  ])("%s → %s (sábado 22:30 em SP)", (iso, esperado) => {
    expect(dataRelativa(iso, SAB_2230_SP)).toBe(esperado);
  });
  it("não-data volta como veio", () => {
    expect(dataRelativa("amanhã cedo", SAB_2230_SP)).toBe("amanhã cedo");
  });
});

describe("horaCurta", () => {
  it.each([
    ["14:00", "14:00"],
    ["14:00:00", "14:00"],
    ["09:05:30.000", "09:05"],
    ["14h", "14h"],
    ["", ""],
    [null, ""],
  ])("%s → %s", (hora, esperado) => {
    expect(horaCurta(hora)).toBe(esperado);
  });
});

describe("descreverData", () => {
  it("perto: o relativo e a data completa", () => {
    expect(descreverData("2026-10-11", "14:00:00", SAB_2230_SP)).toBe("Amanhã · 11/10/2026 · 14:00");
    expect(descreverData("2026-10-10", null, SAB_2230_SP)).toBe("Hoje · 10/10/2026");
  });
  it("longe: só a data completa (o relativo seria a mesma data)", () => {
    expect(descreverData("2026-03-05", null, SAB_2230_SP)).toBe("05/03/2026");
  });
  it("texto legado aparece uma vez, cru", () => {
    expect(descreverData("sexta", "", SAB_2230_SP)).toBe("sexta");
  });
  it("sem data, só a hora (ou nada)", () => {
    expect(descreverData(null, "08:30", SAB_2230_SP)).toBe("08:30");
    expect(descreverData(null, null, SAB_2230_SP)).toBe("");
  });
});
