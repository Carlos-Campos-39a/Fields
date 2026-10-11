import { describe, expect, it } from "vitest";
import { TAREFAS_NO_CARD, linhasDoHoje, normalizarResumo, rotuloDoDia } from "./hoje.js";

// O corpo de GET /api/resumo-do-dia → resultado (backend/src/servicos/resumo.js).
const resultado = (campos = {}) => ({ data: "2026-10-10", reunioes: [], tarefas: [], lembretes: [], ...campos });
const AGORA = new Date(Date.UTC(2026, 9, 10, 13));

describe("normalizarResumo", () => {
  it.each([null, undefined, "x", [], 1])("%j não é resumo", (v) => {
    expect(normalizarResumo(v)).toBeNull();
  });

  it("listas ausentes ou sujas viram listas limpas", () => {
    expect(normalizarResumo({ data: "2026-10-10", reunioes: null, tarefas: [null, { tarefa_id: "t" }] })).toEqual({
      data: "2026-10-10",
      reunioes: [],
      tarefas: [{ tarefa_id: "t" }],
      lembretes: [],
    });
  });
});

describe("linhasDoHoje", () => {
  it("dia vazio", () => {
    expect(linhasDoHoje(normalizarResumo(resultado()), AGORA)).toMatchObject({ compromissos: [], tarefas: [], vazio: true });
    expect(linhasDoHoje(null).vazio).toBe(true);
  });

  it("reuniões e lembretes juntos pela hora; sem hora vai para o fim", () => {
    const linhas = linhasDoHoje(
      normalizarResumo(
        resultado({
          reunioes: [{ reuniao_id: "r1", titulo: "1:1", inicio: "14:00", fim: "14:30" }],
          lembretes: [
            { entrada_id: "e1", tipo: "reminder", titulo: "Ligar", hora: "09:00" },
            { entrada_id: "e2", tipo: "event", titulo: "Sem hora", hora: null },
          ],
        }),
      ),
      AGORA,
    );
    expect(linhas.compromissos.map((c) => [c.hora, c.titulo, c.href])).toEqual([
      ["09:00", "Ligar", "#/notas/e1"],
      ["14:00–14:30", "1:1", "#/agenda"],
      [null, "Sem hora", "#/notas/e2"],
    ]);
    expect(linhas.vazio).toBe(false);
  });

  it(`tarefas: vencidas primeiro, no máximo ${TAREFAS_NO_CARD}, e o resto contado`, () => {
    const tarefas = Array.from({ length: TAREFAS_NO_CARD + 2 }, (_, i) => ({
      tarefa_id: `t${i}`,
      nome: `Tarefa ${i}`,
      prazo: i === 6 ? "2026-10-08" : "2026-10-10",
      atrasada: i === 6,
      projeto: "Fields",
      frente: "Front",
    }));
    const linhas = linhasDoHoje(normalizarResumo(resultado({ tarefas })), AGORA);
    expect(linhas.tarefas).toHaveLength(TAREFAS_NO_CARD);
    expect(linhas.tarefas[0]).toMatchObject({ titulo: "Tarefa 6", atrasada: true, prazo: "08/10", caminho: "Fields › Front" });
    expect(linhas.tarefas[1]).toMatchObject({ atrasada: false, prazo: null });
    expect(linhas.maisTarefas).toBe(2);
  });
});

describe("rotuloDoDia", () => {
  it("dia de calendário por extenso, sem fuso do navegador", () => {
    expect(rotuloDoDia("2026-10-10")).toBe("sábado, 10 de outubro");
    expect(rotuloDoDia("nada")).toBe("");
  });
});
