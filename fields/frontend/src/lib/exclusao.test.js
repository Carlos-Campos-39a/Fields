import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.js";
import { excluirComDesfazer, jaFeito } from "./exclusao.js";

// O caso que motivou o 404 como "já feito": outra aba, o MCP ou o agente excluiu antes. Tratado
// como falha, o rollback trazia de volta um item que o servidor não tem, e toda nova tentativa
// batia no mesmo 404.
const naoEncontrado = () => new ApiError(404, "NAO_ENCONTRADO", "API DELETE → 404", { error: "Not found" });
const quebrou = () => new ApiError(500, "ERRO_SERVIDOR", "API DELETE → 500", null);

function cenario(sobrescrever = {}) {
  const toast = { show: vi.fn() };
  const opcoes = {
    entidade: "COMENTARIO",
    mensagem: "Excluído",
    tirar: vi.fn(),
    devolver: vi.fn(),
    apagar: vi.fn().mockResolvedValue({ success: true }),
    restaurar: vi.fn().mockResolvedValue({ success: true }),
    aposRestaurar: vi.fn().mockResolvedValue(undefined),
    ...sobrescrever,
  };
  return { toast, opcoes };
}

// O Desfazer é o onClick da ação do PRIMEIRO toast (o "… · Desfazer").
const desfazer = (toast) => toast.show.mock.calls[0][0].action.onClick();

let aviso;
beforeEach(() => {
  aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  aviso.mockRestore();
});

const eventos = () => aviso.mock.calls.map((c) => c[1].evento);

describe("jaFeito", () => {
  it("só o NAO_ENCONTRADO conta como já feito", () => {
    expect(jaFeito(naoEncontrado())).toBe(true);
    expect(jaFeito(quebrou())).toBe(false);
    expect(jaFeito(new TypeError("Failed to fetch"))).toBe(false); // sem conexão: falha de verdade
  });
});

describe("excluirComDesfazer", () => {
  it("DELETE ok: tira, não devolve, e oferece Desfazer", async () => {
    const { toast, opcoes } = cenario();
    await expect(excluirComDesfazer(toast, opcoes)).resolves.toBe(true);
    expect(opcoes.tirar).toHaveBeenCalledOnce();
    expect(opcoes.devolver).not.toHaveBeenCalled();
    expect(toast.show.mock.calls[0][0].action.label).toBe("Desfazer");
  });

  it("DELETE 404: o item NÃO volta, o toast é neutro e sem Desfazer", async () => {
    const { toast, opcoes } = cenario({ apagar: vi.fn().mockRejectedValue(naoEncontrado()) });
    await expect(excluirComDesfazer(toast, opcoes)).resolves.toBe(true);
    expect(opcoes.devolver).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledOnce();
    const [{ tone, action }] = toast.show.mock.calls[0];
    expect(tone).toBe("neutral");
    expect(action).toBeUndefined();
    expect(eventos()).toEqual(["EXCLUSAO_JA_FEITA"]);
  });

  it("DELETE com outra falha: devolve à tela e diz que não deu", async () => {
    const { toast, opcoes } = cenario({ apagar: vi.fn().mockRejectedValue(quebrou()) });
    await expect(excluirComDesfazer(toast, opcoes)).resolves.toBe(false);
    expect(opcoes.devolver).toHaveBeenCalledOnce();
    expect(toast.show.mock.calls[0][0].tone).toBe("danger");
    expect(eventos()).toEqual(["EXCLUSAO_FALHOU"]);
  });

  it("Desfazer ok: relê e confirma", async () => {
    const { toast, opcoes } = cenario();
    await excluirComDesfazer(toast, opcoes);
    await desfazer(toast);
    expect(opcoes.aposRestaurar).toHaveBeenCalledOnce();
    expect(toast.show.mock.calls[1][0].tone).toBe("success");
  });

  it("Desfazer com 404: já estava de volta — relê em vez de afirmar que falhou", async () => {
    const { toast, opcoes } = cenario({ restaurar: vi.fn().mockRejectedValue(naoEncontrado()) });
    await excluirComDesfazer(toast, opcoes);
    await desfazer(toast);
    expect(opcoes.aposRestaurar).toHaveBeenCalledOnce();
    expect(toast.show.mock.calls[1][0].tone).toBe("neutral");
    expect(eventos()).toEqual(["RESTAURACAO_JA_FEITA"]);
  });

  it("Desfazer com outra falha: não relê e diz que não deu", async () => {
    const { toast, opcoes } = cenario({ restaurar: vi.fn().mockRejectedValue(quebrou()) });
    await excluirComDesfazer(toast, opcoes);
    await desfazer(toast);
    expect(opcoes.aposRestaurar).not.toHaveBeenCalled();
    expect(toast.show.mock.calls[1][0].tone).toBe("danger");
    expect(eventos()).toEqual(["RESTAURACAO_FALHOU"]);
  });
});
