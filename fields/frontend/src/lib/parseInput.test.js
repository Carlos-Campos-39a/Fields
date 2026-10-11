import { describe, expect, it } from "vitest";
import { DICAS_DE_PREFIXO, parseInput } from "./parseInput.js";
import { TIPOS_ENTRADA } from "../../../backend/src/dominio/enums.js";

describe("parseInput", () => {
  it.each([
    ["evento reunião às 14h", "event", "reunião às 14h"],
    ["Event kickoff", "event", "kickoff"],
    ["lembrete pagar boleto", "reminder", "pagar boleto"],
    ["fr bonjour", "lang_fr", "bonjour"],
    ["frances merci", "lang_fr", "merci"],
    ["jp こんにちは", "lang_jp", "こんにちは"],
    ["nihon arigatou", "lang_jp", "arigatou"],
    ["  só uma nota  ", "note", "só uma nota"],
    ["eventos sem espaço depois do prefixo", "note", "eventos sem espaço depois do prefixo"],
  ])("%j → %s", (texto, tipo, corpo) => {
    expect(parseInput(texto)).toEqual({ type: tipo, body: corpo });
  });

  it("todo tipo produzido existe no backend", () => {
    for (const { tipo } of DICAS_DE_PREFIXO) expect(TIPOS_ENTRADA).toContain(tipo);
  });
});
