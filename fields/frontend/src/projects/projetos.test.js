import { describe, expect, it } from "vitest";
import { ehAtivar, ehEnter, ehEscape } from "./teclas.js";

// O prazo da tabela (dd/mm no ano corrente, e por extenso na dica) é o dataCurta e o formatDate de
// lib/dates.js; os casos dele estão em lib/dates.test.js.

// O keydown sintético do React carrega o nativo em nativeEvent.
const tecla = (key, { compondo = false, keyCode = 0 } = {}) => ({ key, keyCode, nativeEvent: { isComposing: compondo } });

describe("teclas", () => {
  it("Enter e Escape comuns salvam e cancelam", () => {
    expect(ehEnter(tecla("Enter"))).toBe(true);
    expect(ehEscape(tecla("Escape"))).toBe(true);
    expect(ehAtivar(tecla(" "))).toBe(true);
    expect(ehAtivar(tecla("Enter"))).toBe(true);
  });
  it("o Enter que confirma a composição (IME) não salva", () => {
    expect(ehEnter(tecla("Enter", { compondo: true }))).toBe(false);
    // Safari: a composição termina antes do keydown, que chega com keyCode 229.
    expect(ehEnter(tecla("Enter", { keyCode: 229 }))).toBe(false);
  });
  it("o Escape da composição não fecha o campo", () => {
    expect(ehEscape(tecla("Escape", { compondo: true }))).toBe(false);
  });
  it("outras teclas não disparam nada", () => {
    expect(ehEnter(tecla("a"))).toBe(false);
    expect(ehEscape(tecla("Tab"))).toBe(false);
    expect(ehAtivar(tecla("Escape"))).toBe(false);
  });
});
