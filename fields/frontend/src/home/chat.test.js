import { describe, expect, it } from "vitest";
import {
  DESLIGADO,
  EM_ANDAMENTO,
  ENVIANDO,
  ESTADO_INICIAL,
  FALHAS_ATE_PARAR,
  FOLGA_RELOGIO_MS,
  JANELA_DESFAZER_MIN,
  LIMITE_CONSULTA_MS,
  NAO_ENVIADO,
  PERDIDO,
  VERIFICANDO,
  aConsultar,
  avisoDoTurno,
  coladoAposRolar,
  ehComandoDesfazer,
  ehTerminal,
  falhaIncerta,
  iconeDaAcao,
  locaisDoGuardado,
  locaisParaGuardar,
  mensagemDoDesfazer,
  montarFio,
  normalizarTurno,
  ocupado,
  opcoesDeRetentar,
  podeDesfazer,
  podeSalvarComoNota,
  podeTentarDeNovo,
  podeVerificarDeNovo,
  reduzirChat,
  respostaDoEnvio,
  turnoAdotavel,
} from "./chat.js";

// ─── Ajudantes ────────────────────────────────────────────────────────

// O reducer não pode mutar o que recebe (o React compara por referência): todo estado dos testes
// entra congelado até o fundo, e uma mutação vira TypeError no modo estrito dos módulos.
function congelar(v, vistos = new Set()) {
  if (v && typeof v === "object" && !vistos.has(v)) {
    vistos.add(v);
    Object.freeze(v);
    for (const filho of Object.values(v)) congelar(filho, vistos);
  }
  return v;
}

const rodar = (estado, ...acoes) => acoes.reduce((e, a) => reduzirChat(congelar(e), a), estado);

const T0 = Date.UTC(2026, 9, 10, 13, 0, 0); // 10/10/2026 10:00 em São Paulo

/** <turno> como o servidor manda (servicos/turnos.js turnoPublico). */
function doServidor(id, campos = {}) {
  return {
    turno_id: id,
    status: "CONCLUIDO",
    motivo: null,
    texto: "Pronto.",
    entrada: `pedido ${id}`,
    acoes: [],
    progresso: { n_tools: 0 },
    sessao_id: "s1",
    criado_em: "2026-10-10T13:00:00.000Z",
    concluido_em: "2026-10-10T13:00:05.000Z",
    ...campos,
  };
}

const acao = (idx, campos = {}) => ({
  idx,
  acao: "NOVA_TAREFA",
  resumo: `Tarefa ${idx} criada`,
  desfazivel: true,
  desfeito_em: null,
  ...campos,
});

const enviar = (chave = "c1", texto = "cria uma tarefa", contexto = null, agora = T0) => ({ type: "ENVIAR", chave, texto, contexto, agora });
const aceito = (chave = "c1", turnoId = "t1", agora = T0) => ({ type: "ACEITO", chave, turnoId, agora });
const atualizado = (corpo, agora = T0 + 1000) => ({ type: "ATUALIZADO", turno: normalizarTurno(corpo), agora });
const turno = (estado, chave = "c1") => estado.turnos.find((t) => t.chave === chave);
/** podeTentarDeNovo como o Fio pergunta: com o lugar do turno no fio. */
const retentavel = (estado, chave = "c1") => podeTentarDeNovo(turno(estado, chave), opcoesDeRetentar(estado, turno(estado, chave)));

// ─── O contrato ───────────────────────────────────────────────────────

describe("respostaDoEnvio", () => {
  it("202 {turno_id} → ACEITO", () => {
    expect(respostaDoEnvio({ turno_id: "t1" })).toEqual({ tipo: "ACEITO", turnoId: "t1" });
  });

  it("200 <turno> (o comando desfazer) → RESPONDIDO, com o desfazer junto", () => {
    const desfazer = { turno_id: "t0", desfeitas: [{ idx: 0, resumo: "x" }] };
    const r = respostaDoEnvio({ ...doServidor("t9"), desfazer });
    expect(r.tipo).toBe("RESPONDIDO");
    expect(r.turno.turno_id).toBe("t9");
    expect(r.desfazer).toEqual(desfazer);
  });

  it.each([null, undefined, "", {}, { turno_id: "" }, { turno_id: 7 }, { status: "CONCLUIDO" }, []])(
    "%j → INESPERADA",
    (corpo) => {
      expect(respostaDoEnvio(corpo)).toEqual({ tipo: "INESPERADA" });
    },
  );
});

describe("normalizarTurno", () => {
  it("sem turno_id não serve", () => {
    expect(normalizarTurno({ status: "CONCLUIDO" })).toBeNull();
    expect(normalizarTurno(null)).toBeNull();
  });

  it("ação sem idx inteiro sai; resumo vazio ganha um texto; n_tools vem do progresso", () => {
    const t = normalizarTurno(
      doServidor("t1", { acoes: [acao(0), { acao: "X" }, acao(1, { resumo: " " })], progresso: { n_tools: 3 } }),
    );
    expect(t.acoes.map((a) => a.idx)).toEqual([0, 1]);
    expect(t.acoes[1].resumo).toBe("Ação registrada");
    expect(t.n_tools).toBe(3);
  });

  it("status fora do contrato fica como veio — e conta como fim (a tela não consulta para sempre)", () => {
    const t = normalizarTurno(doServidor("t1", { status: "PAUSADO" }));
    expect(t.status).toBe("PAUSADO");
    expect(ehTerminal(t.status)).toBe(true);
    expect(ehTerminal(normalizarTurno(doServidor("t2", { status: undefined })).status)).toBe(true);
  });
});

// ─── O ciclo de um turno ──────────────────────────────────────────────

describe("enviar → 202 → consultar → fim", () => {
  it("o caminho feliz", () => {
    let e = rodar(ESTADO_INICIAL, enviar());
    expect(turno(e)).toMatchObject({ status: ENVIANDO, turno_id: null, entrada: "cria uma tarefa" });
    expect(ocupado(e)).toBe(true);
    expect(aConsultar(e)).toEqual([]); // sem turno_id não há o que consultar

    e = rodar(e, aceito());
    expect(turno(e)).toMatchObject({ status: EM_ANDAMENTO, turno_id: "t1", chave: "c1" });
    expect(aConsultar(e)).toEqual(["t1"]);
    expect(ocupado(e)).toBe(true);

    e = rodar(e, atualizado(doServidor("t1", { status: EM_ANDAMENTO, texto: null, progresso: { n_tools: 2 } })));
    expect(turno(e)).toMatchObject({ status: EM_ANDAMENTO, n_tools: 2 });
    expect(aConsultar(e)).toEqual(["t1"]);

    e = rodar(e, atualizado(doServidor("t1", { acoes: [acao(0)], progresso: { n_tools: 3 } })));
    expect(turno(e)).toMatchObject({ status: "CONCLUIDO", texto: "Pronto.", chave: "c1" });
    expect(aConsultar(e)).toEqual([]);
    expect(ocupado(e)).toBe(false);
    expect(e.mudancas).toBe(1); // o agente mexeu nos dados: o card "Hoje" relê
  });

  it("terminar sem ação não mexe em `mudancas`", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), aceito(), atualizado(doServidor("t1")));
    expect(e.mudancas).toBe(0);
  });

  it("uma consulta atrasada (EM_ANDAMENTO) depois do fim não desfaz o fim", () => {
    const fim = rodar(ESTADO_INICIAL, enviar(), aceito(), atualizado(doServidor("t1")));
    const depois = rodar(fim, atualizado(doServidor("t1", { status: EM_ANDAMENTO, texto: null })));
    expect(depois).toBe(fim);
  });

  it("um GET da conversa atrasado (com o turno ainda EM_ANDAMENTO) não reabre o turno terminado", () => {
    const fim = rodar(ESTADO_INICIAL, enviar(), aceito(), atualizado(doServidor("t1")));
    const e = rodar(fim, { type: "CONVERSA_CARREGADA", turnos: [doServidor("t1", { status: EM_ANDAMENTO, texto: null })], agora: T0 });
    expect(turno(e)).toBe(turno(fim));
    expect(aConsultar(e)).toEqual([]);
  });

  it("ACEITO de quem não está ENVIANDO (ou de chave desconhecida) é ignorado", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), aceito());
    expect(rodar(e, aceito("c1", "outro"))).toBe(e);
    expect(rodar(e, aceito("nao-existe"))).toBe(e);
  });

  it("o GET da conversa que voltou antes do 202 não deixa o turno em dobro", () => {
    let e = rodar(ESTADO_INICIAL, enviar());
    e = rodar(e, { type: "CONVERSA_CARREGADA", turnos: [doServidor("t1", { status: EM_ANDAMENTO, texto: null })], agora: T0 });
    expect(e.turnos).toHaveLength(2); // o do servidor (t1) e o local, ainda sem id
    e = rodar(e, aceito("c1", "t1"));
    expect(e.turnos).toHaveLength(1);
    expect(e.turnos[0]).toMatchObject({ chave: "c1", turno_id: "t1" });
  });
});

describe("falhas no envio", () => {
  it("503 AGENTE_DESLIGADO → DESLIGADO: salvar como nota, e o composer vira caixa de nota", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), { type: "ENVIO_FALHOU", chave: "c1", codigo: "AGENTE_DESLIGADO" });
    expect(turno(e).status).toBe(DESLIGADO);
    expect(e.desligado).toBe(true);
    expect(ocupado(e)).toBe(false);
    expect(podeSalvarComoNota(turno(e))).toBe(true);
    expect(podeTentarDeNovo(turno(e))).toBe(true);
    expect(avisoDoTurno(turno(e))).toMatch(/desligado/);
  });

  it("404 da rota (backend sem a A2b) conta como desligado", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), { type: "ENVIO_FALHOU", chave: "c1", codigo: "NAO_ENCONTRADO" });
    expect(turno(e).status).toBe(DESLIGADO);
  });

  it("recusa clara (4xx) → NAO_ENVIADO com os botões na hora, sem ligar o modo nota", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), { type: "ENVIO_FALHOU", chave: "c1", codigo: "REQUISICAO_INVALIDA", status: 400 });
    expect(turno(e)).toMatchObject({ status: NAO_ENVIADO, codigo: "REQUISICAO_INVALIDA", incerto: false });
    expect(e.desligado).toBe(false);
    expect(podeSalvarComoNota(turno(e))).toBe(true);
    expect(podeTentarDeNovo(turno(e))).toBe(true);
    expect(podeVerificarDeNovo(turno(e))).toBe(false);
    expect(avisoDoTurno(turno(e))).toMatch(/não aceitou/);
  });

  it("429 é recusa clara, com o aviso de esperar", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), { type: "ENVIO_FALHOU", chave: "c1", codigo: "MUITAS_TENTATIVAS", status: 429 });
    expect(turno(e).status).toBe(NAO_ENVIADO);
    expect(avisoDoTurno(turno(e))).toMatch(/Espere/);
  });

  it("rede caída → VERIFICANDO: nenhum botão até conferir, e o composer espera", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), { type: "ENVIO_FALHOU", chave: "c1", codigo: "SEM_CONEXAO" });
    expect(turno(e)).toMatchObject({ status: VERIFICANDO, codigo: "SEM_CONEXAO", incerto: true, enviado_em: T0 });
    expect(e.desligado).toBe(false);
    expect(ocupado(e)).toBe(true);
    expect(ehTerminal(turno(e).status)).toBe(false);
    expect(podeSalvarComoNota(turno(e))).toBe(false);
    expect(podeTentarDeNovo(turno(e))).toBe(false);
    expect(podeVerificarDeNovo(turno(e))).toBe(false);
  });

  it("Tentar de novo de quem nunca chegou: a MESMA bolha volta a ENVIANDO; o 202 religa o assistente", () => {
    let e = rodar(ESTADO_INICIAL, enviar(), { type: "ENVIO_FALHOU", chave: "c1", codigo: "AGENTE_DESLIGADO" });
    e = rodar(e, { type: "REENVIAR", chave: "c1" });
    expect(e.turnos).toHaveLength(1);
    expect(turno(e)).toMatchObject({ status: ENVIANDO, codigo: null });
    e = rodar(e, aceito());
    expect(e.desligado).toBe(false);
  });

  it("salvo como nota: some o Salvar e o Tentar de novo (seria registrar duas vezes)", () => {
    const e = rodar(
      ESTADO_INICIAL,
      enviar(),
      { type: "ENVIO_FALHOU", chave: "c1", codigo: "AGENTE_DESLIGADO" },
      { type: "NOTA_SALVANDO", chave: "c1" },
      { type: "NOTA_SALVA", chave: "c1", nota: { id: "e1", type: "note" } },
    );
    expect(turno(e)).toMatchObject({ salvandoNota: false, nota: { id: "e1", type: "note" } });
    expect(podeSalvarComoNota(turno(e))).toBe(false);
    expect(podeTentarDeNovo(turno(e))).toBe(false);
  });

  it("REATIVAR devolve o composer ao assistente", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), { type: "ENVIO_FALHOU", chave: "c1", codigo: "AGENTE_DESLIGADO" }, { type: "REATIVAR" });
    expect(e.desligado).toBe(false);
  });
});

// ─── Envio incerto: o servidor pode ter recebido ─────────────────────

describe("falhaIncerta", () => {
  it.each([
    ["SEM_CONEXAO", 0, true],
    ["ERRO_SERVIDOR", 502, true],
    ["ERRO_INTERNO", 500, true], // o 500 do backend (error: "erro_interno")
    ["QUALQUER", 504, true],
    ["ERRO_DESCONHECIDO", undefined, true],
    ["RESPOSTA_INESPERADA", 200, true],
    ["AGENTE_DESLIGADO", 503, false],
    ["NAO_ENCONTRADO", 404, false],
    ["REQUISICAO_INVALIDA", 400, false],
    ["MUITAS_TENTATIVAS", 429, false],
  ])("%s (%s) → %s", (codigo, status, esperado) => {
    expect(falhaIncerta(codigo, status)).toBe(esperado);
  });
});

describe("ehComandoDesfazer (a mesma regra do backend)", () => {
  it.each(["desfazer", "Desfaz!", "desfaça.", "  DESFAZER  ", "desfaz…"])("%j é o comando", (texto) => {
    expect(ehComandoDesfazer(texto)).toBe(true);
  });
  it.each(["desfaz a tarefa X", "não desfazer", "", null, "desfazerr"])("%j não é", (texto) => {
    expect(ehComandoDesfazer(texto)).toBe(false);
  });
});

describe("envio incerto: confere antes de oferecer reenviar", () => {
  const ENVIO = T0; // o ms do navegador no ENVIAR
  const iso = (ms) => new Date(ms).toISOString();
  const incerto = (codigo = "SEM_CONEXAO", texto = "cria uma tarefa") =>
    rodar(ESTADO_INICIAL, enviar("c1", texto, { tarefa: { id: "k", name: "K" } }, ENVIO), { type: "ENVIO_FALHOU", chave: "c1", codigo, status: 0 });
  const verificado = (turnos, agora = ENVIO + 3000) => ({ type: "VERIFICADO", chave: "c1", turnos, agora });
  const noServidor = (id, campos = {}) => doServidor(id, { entrada: "cria uma tarefa", criado_em: iso(ENVIO + 200), ...campos });

  it("o turno estava lá rodando: a bolha o adota (mesma chave, vínculo mantido) e a consulta liga", () => {
    const e = rodar(incerto(), verificado([noServidor("t1", { status: EM_ANDAMENTO, texto: null })]));
    expect(e.turnos).toHaveLength(1);
    expect(turno(e)).toMatchObject({
      chave: "c1",
      turno_id: "t1",
      status: EM_ANDAMENTO,
      contexto: { tarefa: { id: "k", name: "K" } },
      incerto: false,
      codigo: null,
    });
    expect(aConsultar(e)).toEqual(["t1"]);
    expect(ocupado(e)).toBe(true);
    expect(podeTentarDeNovo(turno(e), opcoesDeRetentar(e, turno(e)))).toBe(false);
    expect(podeSalvarComoNota(turno(e))).toBe(false);
  });

  it("o turno já tinha terminado agindo: adotado pronto, e `mudancas` sobe", () => {
    const e = rodar(incerto(), verificado([noServidor("t1", { acoes: [acao(0)] })]));
    expect(turno(e)).toMatchObject({ turno_id: "t1", status: "CONCLUIDO", texto: "Pronto." });
    expect(aConsultar(e)).toEqual([]);
    expect(e.mudancas).toBe(1);
    expect(e.releituras).toBe(0);
  });

  it("não está lá: NAO_ENVIADO conferido, e só então os botões aparecem", () => {
    const e = rodar(incerto(), verificado([doServidor("t0", { entrada: "outra coisa" })]));
    expect(turno(e)).toMatchObject({ status: NAO_ENVIADO, incerto: true, conferido: true, turno_id: null });
    expect(ocupado(e)).toBe(false);
    expect(podeTentarDeNovo(turno(e))).toBe(true);
    expect(podeSalvarComoNota(turno(e))).toBe(true);
    expect(podeVerificarDeNovo(turno(e))).toBe(false);
    expect(avisoDoTurno(turno(e))).toMatch(/não chegou/);
  });

  it("um turno de mesma entrada criado ANTES do envio (além da folga do relógio) não é o procurado", () => {
    const velho = noServidor("t0", { criado_em: iso(ENVIO - FOLGA_RELOGIO_MS - 1) });
    const dentro = noServidor("t1", { criado_em: iso(ENVIO - FOLGA_RELOGIO_MS) });
    expect(turno(rodar(incerto(), verificado([velho]))).status).toBe(NAO_ENVIADO);
    expect(turno(rodar(incerto(), verificado([velho, dentro]))).turno_id).toBe("t1");
  });

  it("a entrada compara sem os espaços das pontas (o backend grava com trim)", () => {
    const e = rodar(incerto("SEM_CONEXAO", "  cria uma tarefa \n"), verificado([noServidor("t1")]));
    expect(turno(e).turno_id).toBe("t1");
  });

  it("um turno que já é de outra bolha aceita não é adotado", () => {
    let e = rodar(ESTADO_INICIAL, enviar("c0", "cria uma tarefa", null, ENVIO), aceito("c0", "t1"));
    e = rodar(e, enviar("c1", "cria uma tarefa", null, ENVIO + 100), { type: "ENVIO_FALHOU", chave: "c1", codigo: "SEM_CONEXAO" });
    e = rodar(e, verificado([noServidor("t1")]));
    expect(turno(e, "c0").turno_id).toBe("t1");
    expect(turno(e, "c1")).toMatchObject({ turno_id: null, status: NAO_ENVIADO, conferido: true });
  });

  it("o turno que o GET da conversa já pôs no fio é adotado sem duplicar", () => {
    let e = rodar(incerto(), { type: "CONVERSA_CARREGADA", agora: ENVIO + 1000, turnos: [doServidor("t0"), noServidor("t1", { status: EM_ANDAMENTO, texto: null })] });
    // O GET da conversa já adotou: a bolha c1 virou t1, e o fio não tem t1 duas vezes.
    expect(e.turnos.map((t) => t.chave)).toEqual(["t0", "c1"]);
    expect(turno(e)).toMatchObject({ turno_id: "t1", status: EM_ANDAMENTO });
    // A conferência que volta depois não mexe em nada (a bolha já não está VERIFICANDO).
    expect(rodar(e, verificado([noServidor("t1")]))).toBe(e);
  });

  it("VERIFICADO acha o turno que a carga da conversa pôs no fio ANTES de o envio falhar: fica um só", () => {
    // A carga voltou com a bolha ainda ENVIANDO (que não se adota pela entrada: é o 202 que decide).
    let e = rodar(ESTADO_INICIAL, enviar("c1", "cria uma tarefa", null, ENVIO));
    e = rodar(e, { type: "CONVERSA_CARREGADA", agora: ENVIO + 50, turnos: [doServidor("t0"), noServidor("t1", { status: EM_ANDAMENTO, texto: null })] });
    expect(e.turnos.map((t) => t.chave)).toEqual(["t0", "t1", "c1"]);
    e = rodar(e, { type: "ENVIO_FALHOU", chave: "c1", codigo: "ERRO_SERVIDOR", status: 502 });
    e = rodar(e, verificado([doServidor("t0"), noServidor("t1", { status: EM_ANDAMENTO, texto: null })]));
    expect(e.turnos.map((t) => t.chave)).toEqual(["t0", "c1"]);
    expect(turno(e)).toMatchObject({ turno_id: "t1", status: EM_ANDAMENTO });
    expect(aConsultar(e)).toEqual(["t1"]);
  });

  it("a conferência que falha não libera nada: fica o Verificar de novo", () => {
    let e = rodar(incerto(), { type: "VERIFICACAO_FALHOU", chave: "c1" });
    expect(turno(e)).toMatchObject({ status: NAO_ENVIADO, incerto: true, conferido: false });
    expect(ocupado(e)).toBe(false);
    expect(podeTentarDeNovo(turno(e))).toBe(false);
    expect(podeSalvarComoNota(turno(e))).toBe(false);
    expect(podeVerificarDeNovo(turno(e))).toBe(true);
    expect(avisoDoTurno(turno(e))).toMatch(/Não sei se a mensagem chegou/);
    e = rodar(e, { type: "VERIFICAR", chave: "c1" });
    expect(turno(e).status).toBe(VERIFICANDO);
    e = rodar(e, verificado([noServidor("t1")]));
    expect(turno(e).turno_id).toBe("t1");
  });

  it("2xx fora da forma: nunca oferece reenviar nem salvar, mesmo conferido", () => {
    let e = incerto("RESPOSTA_INESPERADA");
    expect(turno(e).status).toBe(VERIFICANDO);
    e = rodar(e, verificado([]));
    expect(turno(e)).toMatchObject({ status: NAO_ENVIADO, conferido: true });
    expect(podeTentarDeNovo(turno(e))).toBe(false);
    expect(podeSalvarComoNota(turno(e))).toBe(false);
    expect(podeVerificarDeNovo(turno(e))).toBe(true);
    expect(avisoDoTurno(turno(e))).toMatch(/fora do esperado/);
  });

  it('o comando "desfazer" incerto nunca é reenviado (desfaria o turno ANTERIOR também)', () => {
    let e = incerto("ERRO_SERVIDOR", "desfazer");
    e = rodar(e, verificado([]));
    expect(turno(e)).toMatchObject({ status: NAO_ENVIADO, conferido: true });
    expect(podeTentarDeNovo(turno(e))).toBe(false);
    expect(podeSalvarComoNota(turno(e))).toBe(false);
    expect(podeVerificarDeNovo(turno(e))).toBe(true);
    expect(avisoDoTurno(turno(e))).toMatch(/desfazer chegou/);
    // O mesmo "desfazer" com recusa clara (4xx) segue a regra de sempre.
    const claro = rodar(ESTADO_INICIAL, enviar("c1", "desfazer"), { type: "ENVIO_FALHOU", chave: "c1", codigo: "REQUISICAO_INVALIDA", status: 400 });
    expect(podeTentarDeNovo(turno(claro))).toBe(true);
  });

  it('o "desfazer" adotado já pronto: relê a conversa (os chips riscados só vinham no 200 perdido)', () => {
    const e = rodar(incerto("SEM_CONEXAO", "desfazer"), verificado([noServidor("t1", { entrada: "desfazer", texto: "Desfiz." })]));
    expect(turno(e)).toMatchObject({ turno_id: "t1", status: "CONCLUIDO" });
    expect(e.releituras).toBe(1);
    expect(e.mudancas).toBe(1);
  });

  it('o "desfazer" adotado em andamento: relê a conversa quando a consulta o vê terminar', () => {
    let e = rodar(incerto("SEM_CONEXAO", "desfazer"), verificado([noServidor("t1", { entrada: "desfazer", status: EM_ANDAMENTO, texto: null })]));
    expect(e.releituras).toBe(0);
    e = rodar(e, atualizado(noServidor("t1", { entrada: "desfazer", texto: "Desfiz." })));
    expect(e.releituras).toBe(1);
    expect(e.mudancas).toBe(1);
  });

  it("Tentar de novo de uma bolha incerta conferida: REENVIAR zera a dúvida e renova o enviado_em", () => {
    let e = rodar(incerto(), verificado([]));
    e = rodar(e, { type: "VERIFICAR", chave: "c1" }, verificado([]), { type: "REENVIAR", chave: "c1", agora: ENVIO + 60_000 });
    expect(turno(e)).toMatchObject({ status: ENVIANDO, incerto: false, conferido: false, codigo: null, enviado_em: ENVIO + 60_000 });
  });

  it("turnoAdotavel (o que o hook usa para decidir o reenvio) concorda com o reducer", () => {
    const e = incerto();
    expect(turnoAdotavel(e.turnos, "c1", [noServidor("t1")])?.turno_id).toBe("t1");
    expect(turnoAdotavel(e.turnos, "c1", [doServidor("t1")])).toBeNull(); // outra entrada
    expect(turnoAdotavel(e.turnos, "c1", "lixo")).toBeNull();
    expect(turnoAdotavel(e.turnos, "nao-existe", [noServidor("t1")])).toBeNull();
  });
});

describe("a consulta que falha ou demora", () => {
  const rodando = () => rodar(ESTADO_INICIAL, enviar(), aceito());
  const falhou = (codigo = "SEM_CONEXAO") => ({ type: "CONSULTA_FALHOU", turnoId: "t1", codigo, agora: T0 + 2000 });

  it(`${FALHAS_ATE_PARAR} falhas SEGUIDAS param a consulta e liberam o composer`, () => {
    let e = rodando();
    for (let i = 1; i < FALHAS_ATE_PARAR; i++) e = rodar(e, falhou());
    expect(turno(e).consulta).toMatchObject({ falhas: FALHAS_ATE_PARAR - 1, parada: null });
    expect(aConsultar(e)).toEqual(["t1"]);

    e = rodar(e, falhou());
    expect(turno(e).consulta.parada).toBe("SEM_CONEXAO");
    expect(turno(e).status).toBe(EM_ANDAMENTO); // a tela não sabe o fim: não inventa um
    expect(aConsultar(e)).toEqual([]);
    expect(ocupado(e)).toBe(false);

    e = rodar(e, { type: "CONSULTA_RETOMADA", turnoId: "t1", agora: T0 + 60_000 });
    expect(turno(e).consulta).toEqual({ falhas: 0, parada: null, desde: T0 + 60_000 });
    expect(aConsultar(e)).toEqual(["t1"]);
  });

  it("uma resposta boa zera as falhas", () => {
    let e = rodar(rodando(), falhou(), falhou());
    e = rodar(e, atualizado(doServidor("t1", { status: EM_ANDAMENTO, texto: null })));
    expect(turno(e).consulta.falhas).toBe(0);
  });

  it("404 na consulta → PERDIDO (sem ação, pode tentar de novo)", () => {
    const e = rodar(rodando(), falhou("NAO_ENCONTRADO"));
    expect(turno(e)).toMatchObject({ status: PERDIDO, consulta: null });
    expect(retentavel(e)).toBe(true);
    expect(ocupado(e)).toBe(false);
  });

  it("EM_ANDAMENTO além do limite → parada DEMORA (o backend fecha órfãos em 5 min)", () => {
    const quase = rodar(rodando(), atualizado(doServidor("t1", { status: EM_ANDAMENTO, texto: null }), T0 + LIMITE_CONSULTA_MS));
    expect(turno(quase).consulta.parada).toBeNull();
    const passou = rodar(quase, atualizado(doServidor("t1", { status: EM_ANDAMENTO, texto: null }), T0 + LIMITE_CONSULTA_MS + 1));
    expect(turno(passou).consulta.parada).toBe("DEMORA");
    expect(aConsultar(passou)).toEqual([]);
  });

  it("falha de consulta de um turno que já terminou não mexe nele", () => {
    const fim = rodar(rodando(), atualizado(doServidor("t1")));
    expect(rodar(fim, falhou()).turnos).toEqual(fim.turnos);
  });
});

describe("Tentar de novo depois do servidor", () => {
  const terminou = (campos) => rodar(ESTADO_INICIAL, enviar("c1", "faz X", { tarefa: { id: "k" } }), aceito(), atualizado(doServidor("t1", campos)));

  it("ESGOTADO: turno NOVO no fim com o mesmo texto e vínculo; o velho fica e perde o botão", () => {
    let e = terminou({ status: "ESGOTADO", motivo: "PRAZO", acoes: [acao(0)] });
    expect(retentavel(e)).toBe(true);
    e = rodar(e, { type: "RETENTAR", chave: "c1", nova: "c2", agora: T0 + 9000 });
    expect(e.turnos.map((t) => t.chave)).toEqual(["c1", "c2"]);
    expect(turno(e, "c1").retentado).toBe(true);
    expect(retentavel(e, "c1")).toBe(false);
    expect(turno(e, "c2")).toMatchObject({ status: ENVIANDO, entrada: "pedido t1", contexto: { tarefa: { id: "k" } }, enviado_em: T0 + 9000 });
  });

  it("FALHOU sem ação pode; FALHOU com ação gravada NÃO (o pedido repetido refaria a escrita)", () => {
    expect(retentavel(terminou({ status: "FALHOU", acoes: [] }))).toBe(true);
    const comAcao = terminou({ status: "FALHOU", acoes: [acao(0)] });
    expect(retentavel(comAcao)).toBe(false);
    expect(rodar(comAcao, { type: "RETENTAR", chave: "c1", nova: "c2" })).toBe(comAcao);
  });

  it("CONCLUIDO e RECUSADO não oferecem", () => {
    expect(retentavel(terminou({ status: "CONCLUIDO" }))).toBe(false);
    expect(retentavel(terminou({ status: "RECUSADO" }))).toBe(false);
  });

  it("só o turno MAIS RECENTE oferece: o de antes, repetido com o contexto de agora, faria outra coisa", () => {
    const e = rodar(
      ESTADO_INICIAL,
      { type: "CONVERSA_CARREGADA", agora: T0, turnos: [doServidor("t1", { status: "ESGOTADO" }), doServidor("t2", { status: "FALHOU" })] },
    );
    expect(retentavel(e, "t1")).toBe(false);
    expect(retentavel(e, "t2")).toBe(true);
    expect(rodar(e, { type: "RETENTAR", chave: "t1", nova: "c9" })).toBe(e);
    const fio = montarFio(e.turnos, { hoje: "2026-10-10" }).filter((i) => i.tipo === "turno");
    expect(fio.map((i) => [i.chave, i.ultimo])).toEqual([["t1", false], ["t2", true]]);
  });

  it("ESGOTADO com ações depois do 'Nova conversa' não oferece (o histórico da sessão se foi)", () => {
    let e = terminou({ status: "ESGOTADO", acoes: [acao(0)] });
    e = rodar(e, { type: "NOVA_CONVERSA_PEDIDA" }, { type: "NOVA_CONVERSA_FEITA" });
    expect(e.corte).toBe("t1");
    expect(retentavel(e)).toBe(false);
    // Sem ações, o pedido repetido não refaz escrita nenhuma: continua oferecendo.
    let semAcao = terminou({ status: "ESGOTADO", acoes: [] });
    semAcao = rodar(semAcao, { type: "NOVA_CONVERSA_PEDIDA" }, { type: "NOVA_CONVERSA_FEITA" });
    expect(retentavel(semAcao)).toBe(true);
  });

  it("RETENTAR não serve para quem nunca chegou (esse é o REENVIAR)", () => {
    const e = rodar(ESTADO_INICIAL, enviar(), { type: "ENVIO_FALHOU", chave: "c1", codigo: "SEM_CONEXAO" });
    expect(rodar(e, { type: "RETENTAR", chave: "c1", nova: "c2" })).toBe(e);
  });
});

// ─── Desfazer ─────────────────────────────────────────────────────────

describe("chips e desfazer", () => {
  const comAcoes = () =>
    rodar(ESTADO_INICIAL, enviar(), aceito(), atualizado(doServidor("t1", { acoes: [acao(0), acao(1), acao(2, { desfazivel: false })] })));
  const chip = (e, idx) => turno(e).acoes.find((a) => a.idx === idx);

  it("Desfazer só no turno terminado, e só no que tem inverso", () => {
    const rodando = rodar(
      ESTADO_INICIAL,
      enviar(),
      aceito(),
      atualizado(doServidor("t1", { status: EM_ANDAMENTO, texto: null, acoes: [acao(0)] })),
    );
    expect(podeDesfazer(turno(rodando), chip(rodando, 0))).toBe(false);
    const e = comAcoes();
    expect(podeDesfazer(turno(e), chip(e, 0))).toBe(true);
    expect(podeDesfazer(turno(e), chip(e, 2))).toBe(false);
  });

  it("fora da janela (contada do criado_em do turno, como no servidor) o botão some", () => {
    const e = comAcoes(); // criado_em = T0
    const janela = JANELA_DESFAZER_MIN * 60_000;
    expect(podeDesfazer(turno(e), chip(e, 0), T0 + janela)).toBe(true);
    expect(podeDesfazer(turno(e), chip(e, 0), T0 + janela + 1)).toBe(false);
    expect(podeDesfazer({ ...turno(e), criado_em: null }, chip(e, 0), T0 + 10 * janela)).toBe(true);
  });

  it("pedido → desfeito: o chip fica riscado e perde o botão; `mudancas` sobe", () => {
    let e = rodar(comAcoes(), { type: "DESFAZER_PEDIDO", turnoId: "t1", idx: 0 });
    expect(chip(e, 0).desfazendo).toBe(true);
    const antes = e.mudancas;
    e = rodar(e, { type: "DESFEITO", turnoId: "t1", desfeitas: [{ idx: 0, resumo: "x" }], em: "2026-10-10T13:05:00.000Z" });
    expect(chip(e, 0)).toMatchObject({ desfazendo: false, desfeito_em: "2026-10-10T13:05:00.000Z" });
    expect(podeDesfazer(turno(e), chip(e, 0))).toBe(false);
    expect(chip(e, 1).desfeito_em).toBeNull();
    expect(e.mudancas).toBe(antes + 1);
  });

  it("o desfeito local sobrevive a uma releitura do servidor sem ele", () => {
    let e = rodar(comAcoes(), { type: "DESFEITO", turnoId: "t1", desfeitas: [{ idx: 1 }], em: "x" });
    e = rodar(e, { type: "CONVERSA_CARREGADA", turnos: [doServidor("t1", { acoes: [acao(0), acao(1), acao(2)] })], agora: T0 });
    expect(chip(e, 1).desfeito_em).toBe("x");
  });

  it.each([
    ["DESFAZER_JA_FEITO", { desfeito_em: "agora", semVolta: false }],
    ["DESFAZER_EXPIRADO", { desfeito_em: null, semVolta: true }],
    ["SEM_INVERSO", { desfeito_em: null, semVolta: true }],
    ["ALTERADO_DEPOIS", { desfeito_em: null, semVolta: false }],
    ["SEM_CONEXAO", { desfeito_em: null, semVolta: false }],
  ])("recusa %s", (codigo, esperado) => {
    const e = rodar(
      comAcoes(),
      { type: "DESFAZER_PEDIDO", turnoId: "t1", idx: 0 },
      { type: "DESFAZER_FALHOU", turnoId: "t1", idx: 0, codigo, em: "agora" },
    );
    expect(chip(e, 0)).toMatchObject({ desfazendo: false, ...esperado });
    expect(podeDesfazer(turno(e), chip(e, 0))).toBe(esperado.desfeito_em === null && !esperado.semVolta);
    expect(mensagemDoDesfazer(codigo)).toBeTruthy();
  });

  it("RESPONDIDO depois de um GET da conversa que já trouxe o turno: fica um só (sem chave duplicada)", () => {
    let e = rodar(comAcoes(), enviar("c2", "desfazer"));
    e = rodar(e, {
      type: "CONVERSA_CARREGADA",
      agora: T0,
      turnos: [doServidor("t1", { acoes: [acao(0), acao(1), acao(2, { desfazivel: false })] }), doServidor("t2", { entrada: "desfazer", status: EM_ANDAMENTO, texto: null })],
    });
    expect(e.turnos.map((t) => t.chave)).toEqual(["c1", "t2", "c2"]);
    const r = respostaDoEnvio({ ...doServidor("t2", { entrada: "desfazer", texto: "Desfiz." }), desfazer: { turno_id: "t1", desfeitas: [{ idx: 0 }] } });
    e = rodar(e, { type: "RESPONDIDO", chave: "c2", turno: r.turno, desfazer: r.desfazer, em: "quando" });
    expect(e.turnos.map((t) => t.chave)).toEqual(["c1", "c2"]);
    expect(turno(e, "c2")).toMatchObject({ turno_id: "t2", status: "CONCLUIDO" });
    expect(aConsultar(e)).toEqual([]);
    const chaves = montarFio(e.turnos, { hoje: "2026-10-10" }).map((i) => i.chave);
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it('o comando "desfazer" (200 síncrono) risca as ações do turno alvo', () => {
    let e = rodar(comAcoes(), enviar("c2", "desfazer"));
    const r = respostaDoEnvio({
      ...doServidor("t2", { entrada: "desfazer", texto: "Desfiz 2 ações." }),
      desfazer: { turno_id: "t1", desfeitas: [{ idx: 0 }, { idx: 1 }] },
    });
    e = rodar(e, { type: "RESPONDIDO", chave: "c2", turno: r.turno, desfazer: r.desfazer, em: "quando" });
    expect(turno(e, "c2")).toMatchObject({ status: "CONCLUIDO", turno_id: "t2", texto: "Desfiz 2 ações." });
    expect(chip(e, 0).desfeito_em).toBe("quando");
    expect(chip(e, 1).desfeito_em).toBe("quando");
    expect(chip(e, 2).desfeito_em).toBeNull();
    expect(ocupado(e)).toBe(false);
  });
});

// ─── A conversa e o fio ───────────────────────────────────────────────

describe("CONVERSA_CARREGADA", () => {
  it("o do servidor na ordem dele; o EM_ANDAMENTO já entra consultável; o local sem id fica no fim", () => {
    let e = rodar(ESTADO_INICIAL, enviar("c9", "ainda saindo"));
    e = rodar(e, {
      type: "CONVERSA_CARREGADA",
      agora: T0,
      turnos: [doServidor("t1"), doServidor("t2", { status: EM_ANDAMENTO, texto: null }), { lixo: true }],
    });
    expect(e.carga).toBe("PRONTA");
    expect(e.turnos.map((t) => t.chave)).toEqual(["t1", "t2", "c9"]);
    expect(aConsultar(e)).toEqual(["t2"]);
  });
});

describe("Nova conversa", () => {
  it("o corte é o último turno com id; o fio põe UM divisor depois dele", () => {
    let e = rodar(
      ESTADO_INICIAL,
      { type: "CONVERSA_CARREGADA", agora: T0, turnos: [doServidor("t1")] },
      { type: "NOVA_CONVERSA_PEDIDA" },
    );
    expect(e.novaConversa).toBe("PEDINDO");
    e = rodar(e, { type: "NOVA_CONVERSA_FEITA" });
    expect(e).toMatchObject({ novaConversa: "OCIOSA", corte: "t1" });

    const tipos = (est) => montarFio(est.turnos, { hoje: "2026-10-10", corte: est.corte }).map((i) => i.tipo);
    expect(tipos(e)).toEqual(["hoje", "turno", "sessao"]);

    // A mensagem seguinte abre sessão nova (sessao_id outro): continua UM divisor só.
    e = rodar(e, enviar("c2"), aceito("c2", "t2"), atualizado(doServidor("t2", { sessao_id: "s2" })));
    expect(tipos(e)).toEqual(["hoje", "turno", "sessao", "turno"]);
  });

  it("o corte é o do CLIQUE: um turno aceito enquanto o POST esperava já é da conversa nova", () => {
    let e = rodar(
      ESTADO_INICIAL,
      { type: "CONVERSA_CARREGADA", agora: T0, turnos: [doServidor("tA")] },
      { type: "NOVA_CONVERSA_PEDIDA" },
      enviar("cB"),
      aceito("cB", "tB"),
      { type: "NOVA_CONVERSA_FEITA" },
    );
    expect(e).toMatchObject({ corte: "tA", corteAlvo: null });
    const forma = montarFio(e.turnos, { hoje: "2026-10-10", corte: e.corte }).map((i) => (i.tipo === "turno" ? i.turno.turno_id : i.tipo));
    expect(forma).toEqual(["hoje", "tA", "sessao", "tB"]);
  });

  it("o pedido que falha não deixa corte pendurado", () => {
    const e = rodar(
      ESTADO_INICIAL,
      { type: "CONVERSA_CARREGADA", agora: T0, turnos: [doServidor("tA")] },
      { type: "NOVA_CONVERSA_PEDIDA" },
      { type: "NOVA_CONVERSA_FALHOU" },
    );
    expect(e).toMatchObject({ novaConversa: "OCIOSA", corte: null, corteAlvo: null });
  });
});

// ─── O que a aba guarda ───────────────────────────────────────────────

describe("as bolhas que só existem na aba (sessionStorage)", () => {
  const vinculo = { tarefa: { id: "k", name: "Tarefa K", comments: [{ id: "x", text: "y" }] }, frente: { name: "F" }, projeto: { name: "P" } };
  const comFalhas = () =>
    rodar(
      ESTADO_INICIAL,
      { type: "CONVERSA_CARREGADA", agora: T0, turnos: [doServidor("t0")] },
      enviar("c1", "evento reunião às 15h", vinculo),
      { type: "ENVIO_FALHOU", chave: "c1", codigo: "AGENTE_DESLIGADO", status: 503 },
      enviar("c2", "cria tarefa X", null, T0 + 10),
      { type: "ENVIO_FALHOU", chave: "c2", codigo: "SEM_CONEXAO" },
      enviar("c3", "já saiu", null, T0 + 20),
      aceito("c3", "t3"),
    );

  it("guarda só a bolha sem turno_id que não virou nota; a que ainda conferia vai como incerta", () => {
    const guardados = locaisParaGuardar(comFalhas().turnos);
    expect(guardados).toEqual([
      {
        chave: "c1",
        entrada: "evento reunião às 15h",
        status: DESLIGADO,
        codigo: "AGENTE_DESLIGADO",
        incerto: false,
        enviado_em: T0,
        contexto: { tarefa: { id: "k", name: "Tarefa K", comments: [{ id: "x", text: "y" }] } },
      },
      { chave: "c2", entrada: "cria tarefa X", status: NAO_ENVIADO, codigo: "SEM_CONEXAO", incerto: true, enviado_em: T0 + 10, contexto: null },
    ]);
  });

  it("a bolha que virou nota sai da guarda", () => {
    const e = rodar(comFalhas(), { type: "NOTA_SALVA", chave: "c1", nota: { id: "e1", type: "event" } });
    expect(locaisParaGuardar(e.turnos).map((g) => g.chave)).toEqual(["c2"]);
  });

  it("ida e volta: a bolha volta com o texto, o vínculo e o status; a incerta, NÃO conferida", () => {
    const guardados = JSON.parse(JSON.stringify(locaisParaGuardar(comFalhas().turnos)));
    const locais = locaisDoGuardado(guardados);
    expect(locais.map((t) => [t.chave, t.status, t.incerto, t.conferido])).toEqual([
      ["c1", DESLIGADO, false, false],
      ["c2", NAO_ENVIADO, true, false],
    ]);
    expect(locais[0]).toMatchObject({ entrada: "evento reunião às 15h", turno_id: null, enviado_em: T0, contexto: { tarefa: { id: "k" } } });
    expect(podeSalvarComoNota(locais[0])).toBe(true);
    expect(podeVerificarDeNovo(locais[1])).toBe(true);
  });

  it("o que vier torto do storage fica fora, sem quebrar", () => {
    expect(locaisDoGuardado(null)).toEqual([]);
    expect(locaisDoGuardado("lixo")).toEqual([]);
    expect(
      locaisDoGuardado([
        null,
        { chave: "a", entrada: "  ", status: NAO_ENVIADO },
        { chave: "b", entrada: "x", status: "CONCLUIDO" },
        { entrada: "x", status: NAO_ENVIADO },
        { chave: "c", entrada: "ok", status: NAO_ENVIADO, contexto: { tarefa: { name: "sem id" } }, enviado_em: "ontem" },
      ]).map((t) => [t.chave, t.contexto, t.enviado_em]),
    ).toEqual([["c", null, null]]);
  });

  it("LOCAIS_RESTAURADOS põe no fim, uma vez só, e libera a gravação", () => {
    const locais = locaisDoGuardado(locaisParaGuardar(comFalhas().turnos));
    let e = rodar(ESTADO_INICIAL, { type: "CONVERSA_CARREGADA", agora: T0, turnos: [doServidor("t0")] });
    expect(e.locaisRestaurados).toBe(false);
    e = rodar(e, { type: "LOCAIS_RESTAURADOS", locais });
    expect(e.locaisRestaurados).toBe(true);
    expect(e.turnos.map((t) => t.chave)).toEqual(["t0", "c1", "c2"]);
    // O StrictMode monta duas vezes: a segunda restauração não duplica.
    expect(rodar(e, { type: "LOCAIS_RESTAURADOS", locais }).turnos).toBe(e.turnos);
    // Sem nada guardado, a gravação é liberada do mesmo jeito.
    expect(rodar(ESTADO_INICIAL, { type: "LOCAIS_RESTAURADOS", locais: [] }).locaisRestaurados).toBe(true);
  });

  it("a incerta restaurada confere como qualquer outra (e é adotada se o turno estiver lá)", () => {
    const locais = locaisDoGuardado(locaisParaGuardar(comFalhas().turnos));
    let e = rodar(ESTADO_INICIAL, { type: "CONVERSA_CARREGADA", agora: T0, turnos: [doServidor("tX", { entrada: "cria tarefa X", criado_em: new Date(T0 + 300).toISOString() })] });
    e = rodar(e, { type: "LOCAIS_RESTAURADOS", locais });
    // A carga veio ANTES da restauração: o turno está no fio como item do servidor, e a bolha também.
    expect(e.turnos.map((t) => t.chave)).toEqual(["tX", "c1", "c2"]);
    e = rodar(e, { type: "VERIFICAR", chave: "c2" }, {
      type: "VERIFICADO",
      chave: "c2",
      agora: T0 + 5000,
      turnos: [doServidor("tX", { entrada: "cria tarefa X", criado_em: new Date(T0 + 300).toISOString() })],
    });
    expect(e.turnos.map((t) => t.chave)).toEqual(["c1", "c2"]);
    expect(turno(e, "c2")).toMatchObject({ turno_id: "tX", status: "CONCLUIDO" });
  });
});

describe("capturas (o card Hoje relê; a lista do App já soube pelo aoCriar)", () => {
  it("NOTA_SALVA e CAPTURA_FEITA sobem `capturas`, não `mudancas`", () => {
    const e = rodar(
      ESTADO_INICIAL,
      enviar(),
      { type: "ENVIO_FALHOU", chave: "c1", codigo: "AGENTE_DESLIGADO" },
      { type: "NOTA_SALVA", chave: "c1", nota: { id: "e1", type: "event" } },
      { type: "CAPTURA_FEITA" },
    );
    expect(e).toMatchObject({ capturas: 2, mudancas: 0 });
  });
});

describe("montarFio", () => {
  const hoje = "2026-10-10";
  const t = (chave, criado_em, sessao_id = "s1") => ({ chave, turno_id: chave, criado_em, sessao_id });
  const forma = (itens) => itens.map((i) => (i.tipo === "turno" ? i.turno.chave : i.tipo === "dia" ? `dia:${i.data}` : i.tipo));

  it("fio vazio: só o bloco de hoje", () => {
    expect(forma(montarFio([], { hoje }))).toEqual(["hoje"]);
  });

  it("dias anteriores ganham divisor; o bloco de hoje vem antes do 1º turno de hoje", () => {
    const fio = montarFio(
      [
        t("a", "2026-10-08T15:00:00Z"),
        t("b", "2026-10-09T15:00:00Z"),
        t("c", "2026-10-10T13:00:00Z"),
        { chave: "local", turno_id: null, criado_em: null, sessao_id: null },
      ],
      { hoje },
    );
    expect(forma(fio)).toEqual(["dia:2026-10-08", "a", "dia:2026-10-09", "b", "hoje", "c", "local"]);
  });

  it("sem turno hoje, o bloco de hoje vai para o fim (logo acima do composer)", () => {
    expect(forma(montarFio([t("a", "2026-10-09T15:00:00Z")], { hoje }))).toEqual(["dia:2026-10-09", "a", "hoje"]);
  });

  it("o dia é o de São Paulo, não o UTC: 02h UTC do dia 10 ainda é dia 9 lá", () => {
    expect(forma(montarFio([t("a", "2026-10-10T02:00:00Z")], { hoje }))).toEqual(["dia:2026-10-09", "a", "hoje"]);
  });

  it("sessão que muda no mesmo dia ganha divisor; na virada de dia, o dia já é a quebra", () => {
    const fio = montarFio(
      [
        t("a", "2026-10-09T15:00:00Z", "s1"),
        t("b", "2026-10-10T12:00:00Z", "s2"),
        t("c", "2026-10-10T13:00:00Z", "s2"),
        t("d", "2026-10-10T14:00:00Z", "s3"),
      ],
      { hoje },
    );
    expect(forma(fio)).toEqual(["dia:2026-10-09", "a", "hoje", "b", "c", "sessao", "d"]);
  });

  it("turno sem sessão (ainda abrindo) não conta como troca", () => {
    const fio = montarFio([t("a", "2026-10-10T12:00:00Z", "s1"), t("b", null, null), t("c", "2026-10-10T13:00:00Z", "s1")], { hoje });
    expect(forma(fio)).toEqual(["hoje", "a", "b", "c"]);
  });

  it("as chaves dos itens são únicas (key do React)", () => {
    const fio = montarFio(
      [t("a", "2026-10-09T15:00:00Z", "s1"), t("b", "2026-10-10T12:00:00Z", "s2"), t("c", "2026-10-10T13:00:00Z", "s3")],
      { hoje, corte: "c" },
    );
    const chaves = fio.map((i) => i.chave);
    expect(new Set(chaves).size).toBe(chaves.length);
  });
});

describe("textos e ícones", () => {
  it("avisoDoTurno", () => {
    expect(avisoDoTurno({ status: "CONCLUIDO" })).toBeNull();
    expect(avisoDoTurno({ status: "FALHOU", texto: "Desculpe…" })).toBeNull(); // o texto do servidor basta
    expect(avisoDoTurno({ status: "FALHOU", motivo: "REINICIO", texto: "x" })).toMatch(/reiniciou/);
    expect(avisoDoTurno({ status: "RECUSADO" })).toMatch(/do zero/);
    expect(avisoDoTurno({ status: PERDIDO })).toMatch(/não encontrou/);
  });

  it.each([
    ["NOVA_TAREFA", "plus"],
    ["NOVO_PROJETO", "plus"],
    ["NOVO_COMENTARIO", "message"],
    ["EDITAR_ENTRADA", "pencil"],
    ["EXCLUIR_TAREFA", "trash"],
    ["RESTAURAR_FRENTE", "undo"],
    ["CONCLUIR_TAREFA", "check"],
    ["LEMBRAR", "pin"],
    ["ALGO_NOVO", "check"],
    [undefined, "check"],
  ])("iconeDaAcao(%s) → %s", (codigo, icone) => {
    expect(iconeDaAcao(codigo)).toBe(icone);
  });
});

describe("coladoAposRolar (o fio acompanha a resposta)", () => {
  const LIMITE = 96;

  it("perto do fim cola, mesmo vindo de descolado", () => {
    expect(coladoAposRolar(false, { distancia: 10, topo: 900, topoAnterior: 500, limite: LIMITE })).toBe(true);
  });

  it("longe do fim com o topo subindo descola: o Carlos rolou para ler", () => {
    expect(coladoAposRolar(true, { distancia: 400, topo: 600, topoAnterior: 1000, limite: LIMITE })).toBe(false);
  });

  it("longe do fim com o topo PARADO segue colado: é o scroll do próprio fio, entregue depois de a resposta crescer", () => {
    // Visto na verificação da R3: a bolha de falha e os botões dela ficavam abaixo da dobra.
    expect(coladoAposRolar(true, { distancia: 140, topo: 1091, topoAnterior: 1091, limite: LIMITE })).toBe(true);
  });

  it("descer até o meio não recola: só chegar perto do fim", () => {
    expect(coladoAposRolar(false, { distancia: 300, topo: 800, topoAnterior: 600, limite: LIMITE })).toBe(false);
  });
});

describe("pureza", () => {
  it("ação desconhecida devolve o mesmo estado", () => {
    const e = congelar({ ...ESTADO_INICIAL });
    expect(reduzirChat(e, { type: "QUALQUER" })).toBe(e);
  });
});
