import { describe, expect, it } from "vitest";
import { formatHash, mesmaRota, parseHash, saidaSegurada, segurarSaida, VIEWS } from "./useHashRoute.js";

describe("parseHash", () => {
  it.each(["", "#", "#/", "#//", undefined, null])("%j → home", (hash) => {
    expect(parseHash(hash)).toEqual({ view: "home", id: null });
  });

  it.each([
    ["#/notas", { view: "notas", id: null }],
    ["#/notas/", { view: "notas", id: null }],
    ["#/notas/abc-123", { view: "notas", id: "abc-123" }],
    ["#/notas/a%20b", { view: "notas", id: "a b" }],
    ["#/cards", { view: "cards", id: null }],
    ["#/projetos", { view: "projetos", id: null }],
    ["#/kanban", { view: "kanban", id: null }],
    ["#/agenda", { view: "agenda", id: null }],
    ["#/AGENDA", { view: "agenda", id: null }],
    ["#/agenda?semana=2026-10-05", { view: "agenda", id: null }],
    ["#notas", { view: "notas", id: null }],
  ])("%s", (hash, esperado) => {
    expect(parseHash(hash)).toEqual(esperado);
  });

  it("rota desconhecida vira home, marcada, com o segmento para o log", () => {
    expect(parseHash("#/configuracoes")).toEqual({ view: "home", id: null, desconhecida: true, segmento: "configuracoes" });
  });

  it("segmento a mais ou id ilegível: a vista vale, o resto é recusado", () => {
    expect(parseHash("#/projetos/abc")).toMatchObject({ view: "projetos", id: null, desconhecida: true });
    expect(parseHash("#/notas/a/b")).toMatchObject({ view: "notas", id: null, desconhecida: true });
    expect(parseHash("#/notas/%E0%A4%A")).toMatchObject({ view: "notas", id: null, desconhecida: true });
  });
});

describe("formatHash", () => {
  it("cada vista tem o seu hash e volta igual pelo parse", () => {
    for (const view of VIEWS) {
      const hash = formatHash({ view });
      expect(parseHash(hash)).toEqual({ view, id: null });
    }
    expect(formatHash({ view: "home" })).toBe("#/");
    expect(formatHash({ view: "projetos" })).toBe("#/projetos");
  });

  it("id da entrada é codificado e volta decodificado", () => {
    const hash = formatHash({ view: "notas", id: "a/b c" });
    expect(hash).toBe("#/notas/a%2Fb%20c");
    expect(parseHash(hash)).toEqual({ view: "notas", id: "a/b c" });
  });

  it("só notas leva id; vista desconhecida vira a home", () => {
    expect(formatHash({ view: "kanban", id: "x" })).toBe("#/kanban");
    expect(formatHash({ view: "inexistente" })).toBe("#/");
    expect(formatHash()).toBe("#/");
  });
});

describe("mesmaRota", () => {
  it("compara vista e id, ignorando as marcas de recusa", () => {
    expect(mesmaRota({ view: "notas", id: "1" }, { view: "notas", id: "1", desconhecida: true })).toBe(true);
    expect(mesmaRota({ view: "notas", id: "1" }, { view: "notas", id: "2" })).toBe(false);
    expect(mesmaRota({ view: "notas" }, { view: "notas", id: null })).toBe(true);
  });
});

// O registro de guardas é o que decide se a troca de rota espera confirmação (EditForm sujo).
describe("segurarSaida", () => {
  it("segura enquanto houver uma guarda; soltar duas vezes não solta a de outro", () => {
    expect(saidaSegurada()).toBe(false);
    const soltarA = segurarSaida();
    const soltarB = segurarSaida();
    expect(saidaSegurada()).toBe(true);
    soltarA();
    soltarA();
    expect(saidaSegurada()).toBe(true);
    soltarB();
    expect(saidaSegurada()).toBe(false);
  });
});
