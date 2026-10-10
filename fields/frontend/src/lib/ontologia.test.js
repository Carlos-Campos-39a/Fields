import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _zerarMemoria, capitalizar, carregarOntologia, CHAVE_CACHE, COLUNA_FEITO, criarRotulador, ehColunaFeita, ehConcluido,
  ENUMS_RESERVA, estadoInicial, gravarCache, lerCache, normalizarOntologia, proximoHolder, STATUS_CONCLUIDO, TIPOS_AGENDADOS,
} from "./ontologia.js";
// A fonte de verdade, lida do backend do mesmo repositório — o teste reflexivo do front.
import * as dominio from "../../../backend/src/dominio/enums.js";
import { ENUMS_COBERTOS, ROTULOS } from "../../../backend/src/agente/ontologia.js";

// O corpo de GET /api/ontologia, montado como rotas/ontologia.js monta.
const CORPO = {
  nodes: {},
  relationships: [],
  rotulos: ROTULOS,
  enums: Object.fromEntries(ENUMS_COBERTOS.map(([chave, valores]) => [chave, [...valores]])),
  operations: [],
};

function storageFalso(inicial = {}) {
  const dados = { ...inicial };
  return {
    dados,
    getItem: (k) => (k in dados ? dados[k] : null),
    setItem: (k, v) => {
      dados[k] = String(v);
    },
  };
}

const storageQueLanca = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw Object.assign(new Error("cheio"), { name: "QuotaExceededError" });
  },
};

beforeEach(() => {
  _zerarMemoria();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("reflexivo: a reserva e as constantes do front batem com o backend", () => {
  it("ENUMS_RESERVA == ENUMS_COBERTOS (mesmas chaves, mesmos valores, mesma ordem)", () => {
    expect(Object.keys(ENUMS_RESERVA).sort()).toEqual(ENUMS_COBERTOS.map(([k]) => k).sort());
    for (const [chave, valores] of ENUMS_COBERTOS) expect([...ENUMS_RESERVA[chave]]).toEqual([...valores]);
  });

  it("os valores com semântica são os de dominio/enums.js", () => {
    expect(STATUS_CONCLUIDO).toBe(dominio.STATUS_CONCLUIDO);
    expect(COLUNA_FEITO).toBe(dominio.COLUNA_FEITO);
    expect([...TIPOS_AGENDADOS]).toEqual([...dominio.TIPOS_AGENDADOS]);
  });
});

describe("rotulo", () => {
  const rotulo = criarRotulador(ROTULOS);

  it("rótulo da ontologia com a 1ª letra maiúscula", () => {
    expect(rotulo("tipo_entrada", "note")).toBe("Nota");
    expect(rotulo("tipo_entrada", "lang_fr")).toBe("Francês");
    expect(rotulo("status", "Em andamento")).toBe("Em andamento");
    expect(rotulo("kanban", "A fazer")).toBe("A fazer");
    expect(rotulo("alvo_comentario", "REUNIAO")).toBe("Reunião");
  });

  it("o holder vazio TEM rótulo — os três estados", () => {
    expect(rotulo("holder", "Nós")).toBe("Com você");
    expect(rotulo("holder", "Eles")).toBe("Com terceiros");
    expect(rotulo("holder", "")).toBe("Sem responsável definido");
  });

  it("capitalizar: false devolve o rótulo como a ontologia escreve", () => {
    expect(rotulo("tipo_entrada", "event", { capitalizar: false })).toBe("evento");
  });

  it("sem rótulo: o valor cru (e um aviso, uma vez); ausente: vazio", () => {
    expect(rotulo("status", "Arquivado")).toBe("Arquivado");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(rotulo("status", "Arquivado")).toBe("Arquivado");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(rotulo("status", null)).toBe("");
    expect(rotulo("status", undefined)).toBe("");
  });

  it("reserva (sem rótulos): todo valor sai cru, capitalizado, sem log por valor", () => {
    const reserva = criarRotulador({});
    expect(reserva("tipo_entrada", "note")).toBe("Note");
    expect(reserva("holder", "")).toBe("");
    expect(reserva("kanban", "Feito")).toBe("Feito");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("todo valor de todo enum coberto tem rótulo não vazio (exceto onde o vazio é o valor)", () => {
    for (const [chave, valores] of ENUMS_COBERTOS) {
      for (const v of valores) expect(rotulo(chave, v).length).toBeGreaterThan(0);
    }
  });
});

describe("capitalizar", () => {
  it("só a primeira letra, com acento", () => {
    expect(capitalizar("nota")).toBe("Nota");
    expect(capitalizar("é agora")).toBe("É agora");
    expect(capitalizar("")).toBe("");
    expect(capitalizar(null)).toBe("");
  });
});

describe("normalizarOntologia", () => {
  it("aceita o corpo real", () => {
    expect(normalizarOntologia(CORPO)).toEqual({ enums: CORPO.enums, rotulos: ROTULOS });
  });
  it.each([
    null,
    "texto",
    {},
    { enums: [], rotulos: {} },
    { enums: {}, rotulos: [] },
    { enums: { status: "Em andamento" }, rotulos: {} },
    { enums: { status: [1, 2] }, rotulos: {} },
  ])("recusa %j", (corpo) => {
    expect(normalizarOntologia(corpo)).toBeNull();
  });
});

describe("estado inicial e cache", () => {
  it("sem cache: reserva (a tela nunca fica sem lista)", () => {
    const e = estadoInicial(storageFalso());
    expect(e.origem).toBe("reserva");
    expect(e.enums).toBe(ENUMS_RESERVA);
    expect(e.rotulos).toEqual({});
  });

  it("com cache bom: o cache, ainda carregando", () => {
    const e = estadoInicial(storageFalso({ [CHAVE_CACHE]: JSON.stringify({ enums: CORPO.enums, rotulos: ROTULOS }) }));
    expect(e.origem).toBe("cache");
    expect(e.carregando).toBe(true);
    expect(e.enums.kanban).toEqual(["A fazer", "Fazendo", "Espera", "Feito"]);
  });

  it("cache quebrado ou storage bloqueado: reserva, sem lançar", () => {
    expect(estadoInicial(storageFalso({ [CHAVE_CACHE]: "{nao é json" })).origem).toBe("reserva");
    expect(estadoInicial(storageFalso({ [CHAVE_CACHE]: JSON.stringify({ enums: 1 }) })).origem).toBe("reserva");
    expect(estadoInicial(storageQueLanca).origem).toBe("reserva");
    expect(lerCache(null)).toBeNull();
  });

  it("gravarCache: grava; storage que recusa → false com aviso", () => {
    const s = storageFalso();
    expect(gravarCache({ enums: CORPO.enums, rotulos: ROTULOS }, s)).toBe(true);
    expect(lerCache(s)).toEqual({ enums: CORPO.enums, rotulos: ROTULOS });
    expect(gravarCache({ enums: {}, rotulos: {} }, storageQueLanca)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("ONTOLOGIA_CACHE_INDISPONIVEL"),
      expect.objectContaining({ motivo: "QuotaExceededError" }),
    );
  });
});

describe("carregarOntologia", () => {
  it("uma ida ao servidor para chamadas simultâneas, e nenhuma depois do sucesso", async () => {
    const buscar = vi.fn(async () => CORPO);
    const [a, b] = await Promise.all([carregarOntologia(buscar), carregarOntologia(buscar)]);
    expect(a).toBe(b);
    await carregarOntologia(buscar);
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(estadoInicial(storageFalso()).origem).toBe("servidor");
  });

  it("falha não fica em memória: a próxima chamada tenta de novo", async () => {
    const falhar = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(carregarOntologia(falhar)).rejects.toThrow("Failed to fetch");
    const buscar = vi.fn(async () => CORPO);
    await expect(carregarOntologia(buscar)).resolves.toEqual({ enums: CORPO.enums, rotulos: ROTULOS });
    expect(buscar).toHaveBeenCalledTimes(1);
  });

  it("corpo com forma errada é erro ONTOLOGIA_INVALIDA, não lista vazia", async () => {
    const erro = await carregarOntologia(async () => ({ enums: null })).catch((e) => e);
    expect(erro.codigo).toBe("ONTOLOGIA_INVALIDA");
  });
});

describe("semântica", () => {
  it("concluído e feito", () => {
    expect(ehConcluido("Concluído")).toBe(true);
    expect(ehConcluido("Em andamento")).toBe(false);
    expect(ehColunaFeita("Feito")).toBe(true);
    expect(ehColunaFeita("Fazendo")).toBe(false);
  });

  it("proximoHolder: ciclo de três, com o vazio como estado", () => {
    const h = CORPO.enums.holder;
    expect(proximoHolder("Nós", h)).toBe("Eles");
    expect(proximoHolder("Eles", h)).toBe("");
    expect(proximoHolder("", h)).toBe("Nós");
    expect(proximoHolder(null, h)).toBe("Nós"); // null legado = sem responsável
    expect(proximoHolder("Fulano", h)).toBe("Nós");
    expect(proximoHolder("Nós", [])).toBe("Eles"); // lista vazia → reserva
  });
});
