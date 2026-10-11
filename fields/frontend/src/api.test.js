import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, codigoDe, EVENTO_401, normalizarErro } from "./api.js";

// O backend fala três dialetos de erro; a tela só pode depender de um código. Estes casos são os
// corpos REAIS de hoje (lib/rota.js RESPOSTA_LEGADA, app.js, rotas/ops.js responderErro).
describe("normalizarErro", () => {
  it.each([
    // legado do server.js monolítico: texto humano → código
    [404, { error: "Not found" }, "NAO_ENCONTRADO", "Not found"],
    [400, { error: "nothing to update" }, "NADA_A_ATUALIZAR", "nothing to update"],
    [400, { error: "name required" }, "NOME_OBRIGATORIO", "name required"],
    [400, { error: "title and content are required" }, "TITULO_E_CONTEUDO_OBRIGATORIOS", "title and content are required"],
    [400, { error: "title and date required" }, "TITULO_E_DATA_OBRIGATORIOS", "title and date required"],
    // A0/A1: snake_case → UPPER_SNAKE
    [503, { error: "comentarios_indisponiveis" }, "COMENTARIOS_INDISPONIVEIS", null],
    [409, { error: "comentarios_desatualizados" }, "COMENTARIOS_DESATUALIZADOS", null],
    [401, { error: "nao_autenticado" }, "NAO_AUTENTICADO", null],
    [500, { error: "erro_interno" }, "ERRO_INTERNO", null],
    [415, { error: "content_type_invalido" }, "CONTENT_TYPE_INVALIDO", null],
    // A2: {erro, codigo} e o ErroDominio {error, codigo}
    [404, { erro: "tarefa não encontrada", codigo: "NAO_ENCONTRADO" }, "NAO_ENCONTRADO", "tarefa não encontrada"],
    [409, { error: "restaure o projeto antes", codigo: "PAI_EXCLUIDO" }, "PAI_EXCLUIDO", "restaure o projeto antes"],
    [503, { erro: "agente desligado", codigo: "AGENTE_DESLIGADO" }, "AGENTE_DESLIGADO", "agente desligado"],
    [422, { erro: "x", codigo: "ambiguo" }, "AMBIGUO", "x"],
  ])("%i %j → %s", (status, corpo, codigo, detalhe) => {
    expect(normalizarErro(status, corpo)).toEqual({ codigo, detalhe });
  });

  it("sem corpo reconhecível, decide pelo status", () => {
    expect(normalizarErro(404, null).codigo).toBe("NAO_ENCONTRADO"); // 404 HTML do Express
    expect(normalizarErro(502, null).codigo).toBe("ERRO_SERVIDOR"); // rewrite da Vercel
    expect(normalizarErro(429, {}).codigo).toBe("MUITAS_TENTATIVAS");
    expect(normalizarErro(418, {}).codigo).toBe("HTTP_418");
    expect(normalizarErro(400, [1, 2]).codigo).toBe("REQUISICAO_INVALIDA");
  });

  it("texto humano desconhecido não vira código, mas fica no detalhe", () => {
    expect(normalizarErro(400, { error: "Algo deu Errado" })).toEqual({ codigo: "REQUISICAO_INVALIDA", detalhe: "Algo deu Errado" });
  });

  it("codigo vazio é ignorado", () => {
    expect(normalizarErro(404, { error: "Not found", codigo: "  " }).codigo).toBe("NAO_ENCONTRADO");
  });
});

describe("codigoDe", () => {
  it("ApiError → o código; TypeError do fetch → SEM_CONEXAO; resto → ERRO_DESCONHECIDO", () => {
    expect(codigoDe(new ApiError(409, "PAI_EXCLUIDO", "m", null))).toBe("PAI_EXCLUIDO");
    expect(codigoDe(new TypeError("Failed to fetch"))).toBe("SEM_CONEXAO");
    expect(codigoDe(new Error("x"))).toBe("ERRO_DESCONHECIDO");
    expect(codigoDe(undefined)).toBe("ERRO_DESCONHECIDO");
  });
});

describe("req (fetch falso)", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    delete globalThis.window;
  });

  function responder(status, corpo) {
    const chamadas = [];
    globalThis.fetch = vi.fn(async (url, opcoes) => {
      chamadas.push({ url, opcoes });
      return { ok: status < 400, status, text: async () => (corpo === undefined ? "" : JSON.stringify(corpo)) };
    });
    return chamadas;
  }

  it("o erro sai como ApiError com o código normalizado", async () => {
    const chamadas = responder(503, { error: "comentarios_indisponiveis" });
    const erro = await api.getComentarios("TAREFA", "t 1").catch((e) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro.status).toBe(503);
    expect(erro.codigo).toBe("COMENTARIOS_INDISPONIVEIS");
    expect(chamadas[0].url).toBe("/api/comentarios?alvo_tipo=TAREFA&alvo_id=t+1");
  });

  it("401 avisa o Gate pelo evento global", async () => {
    responder(401, { error: "nao_autenticado" });
    const eventos = [];
    globalThis.window = { dispatchEvent: (ev) => eventos.push(ev.type) };
    const erro = await api.getOntologia().catch((e) => e);
    expect(erro.codigo).toBe("NAO_AUTENTICADO");
    expect(eventos).toEqual([EVENTO_401]);
  });

  it("restaurar e desfazer: método, caminho e corpo", async () => {
    const chamadas = responder(200, { success: true });
    await api.restaurarTask("abc");
    await api.restaurarComentario("x/y");
    await api.desfazerAgente("t1");
    await api.desfazerAgente("t1", 0);
    expect(chamadas.map((c) => [c.opcoes.method, c.url, c.opcoes.body])).toEqual([
      ["POST", "/api/tasks/abc/restaurar", undefined],
      ["POST", "/api/comentarios/x%2Fy/restaurar", undefined],
      ["POST", "/api/agente/desfazer", JSON.stringify({ turno_id: "t1" })],
      ["POST", "/api/agente/desfazer", JSON.stringify({ turno_id: "t1", idx: 0 })],
    ]);
    // Mutação sem corpo ainda declara JSON: o backend recusa mutação sem Content-Type.
    expect(chamadas[0].opcoes.headers["Content-Type"]).toBe("application/json");
  });

  // O id da entrada vem da URL (#/notas/:id): um "/" decodificado não pode virar outro caminho.
  it("ler, editar e excluir uma entrada codificam o id", async () => {
    const chamadas = responder(200, { entry: {} });
    await api.getEntry("a/b");
    await api.updateEntry("a?b", { pinned: true });
    await api.deleteEntry("a#b");
    expect(chamadas.map((c) => [c.opcoes.method, c.url])).toEqual([
      ["GET", "/api/entries/a%2Fb"],
      ["PATCH", "/api/entries/a%3Fb"],
      ["DELETE", "/api/entries/a%23b"],
    ]);
  });

  it("resumo do dia com e sem data", async () => {
    const chamadas = responder(200, { resultado: {} });
    await api.getResumoDoDia();
    await api.getResumoDoDia("2026-10-10");
    expect(chamadas.map((c) => c.url)).toEqual(["/api/resumo-do-dia", "/api/resumo-do-dia?data=2026-10-10"]);
  });
});
