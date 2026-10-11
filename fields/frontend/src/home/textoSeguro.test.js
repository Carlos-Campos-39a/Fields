import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { analisarLinha, analisarTexto } from "./textoSeguro.js";
import { TextoDoAgente } from "./TextoDoAgente.jsx";

const n = (texto) => ({ texto, negrito: true });
const t = (texto) => ({ texto, negrito: false });

describe("analisarLinha — *negrito* com a regra do WhatsApp", () => {
  it.each([
    ["sem marca", "só texto", [t("só texto")]],
    ["*simples*", "a tarefa *Relatório* foi criada", [t("a tarefa "), n("Relatório"), t(" foi criada")]],
    ["**duplo**", "**Hoje** você tem 2 reuniões", [n("Hoje"), t(" você tem 2 reuniões")]],
    ["dois na linha", "*a* e *b*", [n("a"), t(" e "), n("b")]],
    ["pontuação colada por fora", "(*ok*).", [t("("), n("ok"), t(").")]],
    ["miolo com espaço por dentro", "*duas palavras*", [n("duas palavras")]],
  ])("%s", (_nome, linha, esperado) => {
    expect(analisarLinha(linha)).toEqual(esperado);
  });

  // O que NÃO é negrito fica exatamente como veio: um asterisco a mais na tela é melhor que uma
  // palavra sumida (ou uma conta de multiplicar virando negrito).
  it.each([
    ["conta", "2*3*4"],
    ["dentro da palavra", "abc*def*ghi"],
    ["abre com espaço", "* não é negrito*"],
    ["fecha com espaço", "*não é negrito *"],
    ["sem fechar", "*aberto e nunca fechado"],
    ["vazio", "**"],
    ["quatro asteriscos", "****"],
    ["delimitadores diferentes", "**a*"],
  ])("%s fica literal", (_nome, linha) => {
    expect(analisarLinha(linha)).toEqual([t(linha)]);
  });

  it("não atravessa linhas (cada linha é analisada sozinha)", () => {
    expect(analisarTexto("*começa\ntermina*")).toEqual([
      [
        { marcador: false, partes: [t("*começa")] },
        { marcador: false, partes: [t("termina*")] },
      ],
    ]);
  });
});

describe("analisarTexto — parágrafos, quebras, marcadores e títulos", () => {
  it("linha em branco separa parágrafo; quebra simples vira quebra de linha", () => {
    expect(analisarTexto("Feito.\nCriei a tarefa.\n\nMais alguma coisa?")).toEqual([
      [
        { marcador: false, partes: [t("Feito.")] },
        { marcador: false, partes: [t("Criei a tarefa.")] },
      ],
      [{ marcador: false, partes: [t("Mais alguma coisa?")] }],
    ]);
  });

  it("CRLF, espaços na linha em branco e linhas em branco seguidas valem o mesmo", () => {
    expect(analisarTexto("a\r\n \r\n\r\n\r\nb")).toEqual([
      [{ marcador: false, partes: [t("a")] }],
      [{ marcador: false, partes: [t("b")] }],
    ]);
  });

  it("- item, * item e • item viram marcador (e o '* ' do começo não abre negrito)", () => {
    expect(analisarTexto("- um\n* *dois*\n• três")).toEqual([
      [
        { marcador: true, partes: [t("um")] },
        { marcador: true, partes: [n("dois")] },
        { marcador: true, partes: [t("três")] },
      ],
    ]);
  });

  it("# Título vira a linha em negrito, sem os asteriscos de dentro", () => {
    expect(analisarTexto("## **Resumo**\ntexto")).toEqual([
      [
        { marcador: false, partes: [n("Resumo")] },
        { marcador: false, partes: [t("texto")] },
      ],
    ]);
  });

  it.each([null, undefined, "", "   \n\n  ", 42, { texto: "x" }])("%j → nada", (v) => {
    expect(analisarTexto(v)).toEqual([]);
  });
});

describe("TextoDoAgente — nunca HTML do texto", () => {
  const html = (texto) => renderToStaticMarkup(createElement(TextoDoAgente, { texto }));

  // O modelo repete o que leu (título de nota, comentário colado): se o texto virasse HTML, isto
  // rodaria na sessão do Carlos.
  it("marcação no texto sai escapada, inclusive dentro do negrito", () => {
    const saida = html('<img src=x onerror="alert(1)"> e *<script>alert(2)</script>*');
    expect(saida).not.toContain("<img");
    expect(saida).not.toContain("<script");
    expect(saida).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(saida).toContain("<strong>&lt;script&gt;alert(2)&lt;/script&gt;</strong>");
  });

  it("negrito, quebras e parágrafos viram elementos", () => {
    const saida = html("**Pronto.**\nCriei *X*.\n\nMais?");
    expect(saida).toMatch(/<p[^>]*><strong>Pronto\.<\/strong><br\/>Criei <strong>X<\/strong>\.<\/p><p[^>]*>Mais\?<\/p>/);
  });

  it("link não vira <a>: não há link automático", () => {
    expect(html("veja https://exemplo.com/x")).not.toContain("<a");
  });

  it("texto vazio não desenha nada", () => {
    expect(html("")).toBe("");
    expect(html(null)).toBe("");
  });
});
