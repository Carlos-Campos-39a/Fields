import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { CHAVE_DATA_LEGADA, deApi, deLegado, ehIndisponivel, listaDeLegado, paraLegado } from "./comentarios.js";
import { CHAVE_DATA_LEGADA as CHAVE_DO_BACKEND } from "../../../backend/src/dominio/comentarios_legado.js";

describe("ponte legado ↔ API nova", () => {
  it("a chave de data de cada alvo é a do backend", () => {
    expect(CHAVE_DATA_LEGADA).toEqual(CHAVE_DO_BACKEND);
  });

  it("ida e volta preserva id, texto e data, na chave do alvo", () => {
    const entrada = { id: "1", text: "oi", createdAt: "2026-10-10T12:00:00.000Z" };
    expect(paraLegado("ENTRADA", deLegado("ENTRADA", entrada))).toEqual(entrada);
    const tarefa = { id: "2", text: "ok", created_at: "2026-10-10T12:00:00.000Z" };
    expect(paraLegado("TAREFA", deLegado("TAREFA", tarefa))).toEqual(tarefa);
  });

  it("aceita a data na chave da outra época, e id numérico", () => {
    expect(deLegado("TAREFA", { id: 7, text: "x", createdAt: "2026-01-01T00:00:00.000Z" })).toEqual({
      id: "7", texto: "x", criado_em: "2026-01-01T00:00:00.000Z",
    });
  });

  it("listaDeLegado descarta o ilegível e aceita não-array", () => {
    expect(listaDeLegado("REUNIAO", null)).toEqual([]);
    expect(listaDeLegado("REUNIAO", [null, { id: "a" }, { id: "b", text: "t", created_at: null }])).toEqual([
      { id: "b", texto: "t", criado_em: null },
    ]);
  });

  it("deApi e o reconhecimento do modo legado", () => {
    expect(deApi({ id: "c", texto: "t", criado_em: "x", origem: "web", alvo_tipo: "TAREFA" })).toEqual({ id: "c", texto: "t", criado_em: "x" });
    expect(ehIndisponivel(new ApiError(503, "COMENTARIOS_INDISPONIVEIS", "m", null))).toBe(true);
    expect(ehIndisponivel(new ApiError(409, "COMENTARIOS_DESATUALIZADOS", "m", null))).toBe(false);
    expect(ehIndisponivel(new TypeError("x"))).toBe(false);
  });
});
