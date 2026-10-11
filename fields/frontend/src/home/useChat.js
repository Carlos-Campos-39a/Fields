import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, codigoDe } from "../api.js";
import { useToast } from "../ui/index.js";
import { comentar } from "../lib/comentarios.js";
import { avisar, avisarUmaVez, camposDoErro } from "../lib/log.js";
import { parseInput } from "../lib/parseInput.js";
import { useFalha } from "../lib/useFalha.js";
import {
  EM_ANDAMENTO,
  ESTADO_INICIAL,
  FALHAS_ATE_PARAR,
  INTERVALO_CONSULTA_MS,
  LIMITE_CONSULTA_MS,
  LIMITE_CONVERSA,
  LIMITE_VERIFICACAO,
  NAO_ENVIADO,
  PERDIDO,
  STATUS_DO_SERVIDOR,
  VERIFICANDO,
  aConsultar,
  ehComandoDesfazer,
  ehFalhaLocal,
  ehTerminal,
  falhaIncerta,
  locaisDoGuardado,
  locaisParaGuardar,
  mensagemDoDesfazer,
  normalizarTurno,
  ocupado,
  opcoesDeRetentar,
  podeSalvarComoNota,
  podeTentarDeNovo,
  reduzirChat,
  respostaDoEnvio,
  turnoAdotavel,
} from "./chat.js";

let sequencia = 0;
// A chave do React de um turno que ainda não tem turno_id. Fica com ele depois do 202: trocar a
// chave remontaria a bolha (e o foco que estiver nela) no meio da conversa.
const novaChave = () => `local-${Date.now().toString(36)}-${++sequencia}`;
const agoraIso = () => new Date().toISOString();

// O fetch não tem prazo: uma consulta pendurada numa conexão morta pararia o laço inteiro (a próxima
// rodada só sai depois desta). Passado o prazo, conta como falha e o laço segue; a resposta
// atrasada, se vier, cai num `vivo` que já é outro ou é descartada pelo reducer.
const PRAZO_DA_CONSULTA_MS = 10_000;
const SEM_RESPOSTA = "SEM_RESPOSTA";
const FORA_DO_CONTRATO = "RESPOSTA_INESPERADA";
// Um 5xx do proxy pode chegar com o pedido ainda a caminho do backend: a conferência espera um
// pouco antes de perguntar, para não concluir "não chegou" cedo demais.
const ESPERA_ANTES_DE_CONFERIR_MS = 1500;
// O turno que ficou rodando quando a Home saiu da tela é vigiado mais devagar (home/useChat vigia).
const INTERVALO_VIGIA_MS = 2000;

function comPrazo(promessa, ms) {
  let timer;
  const limite = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(Object.assign(new Error("consulta sem resposta"), { codigo: SEM_RESPOSTA })), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

const codigoDaFalha = (e) => (e?.codigo === SEM_RESPOSTA || e?.codigo === FORA_DO_CONTRATO ? e.codigo : codigoDe(e));
const foraDoContrato = (mensagem) => Object.assign(new Error(mensagem), { codigo: FORA_DO_CONTRATO });

// ─── O que a aba guarda (sessionStorage) ─────────────────────────────
// As bolhas que falharam e ainda não viraram nota (o texto do Carlos só existe nelas) e o "assistente
// desligado". Storage bloqueado ou cheio não quebra a tela: a falha vai ao console, uma vez.

const CHAVE_LOCAIS = "fields.chat.locais";
const CHAVE_DESLIGADO = "fields.chat.desligado";

function armazem() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // acesso ao storage bloqueado (aba privada, política do navegador)
  }
}

function lerGuardado(chave) {
  try {
    const bruto = armazem()?.getItem(chave);
    return bruto ? JSON.parse(bruto) : null;
  } catch (e) {
    avisarUmaVez("CHAT_GUARDADO_ILEGIVEL", "não deu para ler o que a aba guardou do chat", { chave, tipo: e?.name ?? typeof e });
    return null;
  }
}

function gravarGuardado(chave, valor) {
  try {
    const s = armazem();
    if (!s) return;
    if (valor === null || valor === undefined) s.removeItem(chave);
    else s.setItem(chave, JSON.stringify(valor));
  } catch (e) {
    avisarUmaVez("CHAT_GUARDADO_FALHOU", "não deu para guardar o chat na aba; uma bolha que falhou some se a tela trocar", {
      chave,
      tipo: e?.name ?? typeof e,
    });
  }
}

const estadoComOGuardado = () => ({ ...ESTADO_INICIAL, desligado: lerGuardado(CHAVE_DESLIGADO) === true });

// ─── A vigia dos turnos que ficaram rodando quando a Home saiu ───────
// A consulta da Home morre com ela, mas o turno segue no servidor — e o que ele escrever tem de
// chegar à lista do App (a nota que o agente criou, a entrada que ele excluiu). A vigia é do módulo
// (sobrevive à Home), consulta devagar, avisa `aoMudar` quando um turno termina mexendo nos dados e
// para quando a Home volta (a consulta é dela de novo), quando tudo terminou, ou quando desiste.

const vigia = { turnos: new Map(), timer: null, geracao: 0, aoMudar: null };

function pararVigia() {
  vigia.geracao += 1;
  clearTimeout(vigia.timer);
  vigia.timer = null;
  vigia.turnos.clear();
}

function vigiar(itens, aoMudar) {
  if (itens.length === 0) return;
  for (const it of itens) vigia.turnos.set(it.id, { ...it, falhas: 0 });
  vigia.aoMudar = aoMudar;
  if (vigia.timer === null) {
    const geracao = vigia.geracao;
    vigia.timer = setTimeout(() => rodadaDaVigia(geracao), INTERVALO_VIGIA_MS);
  }
}

async function rodadaDaVigia(geracao) {
  for (const [id, it] of [...vigia.turnos]) {
    let desistiu = null;
    try {
      const turno = normalizarTurno(await comPrazo(api.getTurno(id), PRAZO_DA_CONSULTA_MS));
      if (geracao !== vigia.geracao) return;
      if (!turno || turno.turno_id !== id) throw foraDoContrato("GET /agente/turnos/:id fora do contrato");
      it.falhas = 0;
      if (ehTerminal(turno.status)) {
        vigia.turnos.delete(id);
        if (turno.acoes.length > 0 || it.desfazer) vigia.aoMudar?.();
        continue;
      }
    } catch (e) {
      if (geracao !== vigia.geracao) return;
      const codigo = codigoDaFalha(e);
      it.falhas += 1;
      if (codigo === "NAO_ENCONTRADO" || it.falhas >= FALHAS_ATE_PARAR) desistiu = codigo;
    }
    if (!desistiu && Date.now() - it.desde > LIMITE_CONSULTA_MS) desistiu = "DEMORA";
    if (desistiu) {
      vigia.turnos.delete(id);
      avisar("CHAT_VIGIA_DESISTIU", "parei de vigiar um turno que ficou rodando fora da Home; a lista pode estar velha", {
        turno_id: id,
        motivo: desistiu,
      });
    }
  }
  if (geracao !== vigia.geracao) return;
  vigia.timer = null;
  if (vigia.turnos.size > 0) vigia.timer = setTimeout(() => rodadaDaVigia(geracao), INTERVALO_VIGIA_MS);
}

/**
 * O chat da Home falando com a API — o reducer e as regras moram em home/chat.js; aqui só entram a
 * rede, o relógio, o storage da aba, os toasts e o log. Nunca loga o texto do Carlos nem a
 * resposta: só evento, turno_id e código.
 *
 * A consulta é periódica (1 s), sem WebSocket: o rewrite da Vercel não faz upgrade (plano §4). Ela
 * vive num efeito chaveado pela LISTA de turnos em andamento — entrou ou saiu um, o laço recomeça
 * com a lista nova; desmontou a Home, ele para (e volta com o GET da conversa na próxima visita), e
 * o que ficou rodando passa para a vigia do módulo.
 *
 * `onCreated(entry)` é o aoCriar do App: o "Salvar como nota" passa por ele para a lista de notas e
 * o toast "Salvo como …" serem os mesmos da caixa de captura.
 * `onDadosMudaram()` é o carregar do App: chamado quando um turno (ou um desfazer) mexeu nos dados,
 * com a Home na tela ou não.
 */
export function useChat({ onCreated, onDadosMudaram }) {
  const [estado, despachar] = useReducer(reduzirChat, undefined, estadoComOGuardado);
  const estadoRef = useRef(estado);
  estadoRef.current = estado;
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const onDadosMudaramRef = useRef(onDadosMudaram);
  onDadosMudaramRef.current = onDadosMudaram;
  const montado = useRef(false);
  const restaurou = useRef(false);
  const conferirRef = useRef(null);
  const toast = useToast();
  const falha = useFalha();

  const avisarMudanca = useCallback(() => onDadosMudaramRef.current?.(), []);

  // A Home voltou: a consulta dos turnos é dela de novo. Saiu: o que ainda roda vai para a vigia.
  useEffect(() => {
    montado.current = true;
    pararVigia();
    return () => {
      montado.current = false;
      const rodando = estadoRef.current.turnos
        .filter((t) => t.status === EM_ANDAMENTO && t.turno_id)
        .map((t) => ({ id: t.turno_id, desde: t.consulta?.desde ?? Date.now(), desfazer: ehComandoDesfazer(t.entrada) }));
      vigiar(rodando, avisarMudanca);
    };
  }, [avisarMudanca]);

  // ── A conversa ──
  const recarregar = useCallback(async () => {
    despachar({ type: "CONVERSA_PEDIDA" });
    try {
      const corpo = await api.getConversa({ canal: "web", limite: LIMITE_CONVERSA });
      const lista = Array.isArray(corpo?.turnos) ? corpo.turnos : [];
      if (!Array.isArray(corpo?.turnos)) {
        avisar("CHAT_CONVERSA_FORMA", "GET /agente/conversa sem a lista de turnos; o fio fica vazio", {});
      }
      const ilegiveis = lista.filter((t) => !normalizarTurno(t)).length;
      if (ilegiveis > 0) avisar("CHAT_TURNO_ILEGIVEL", "turnos sem turno_id ficaram fora do fio", { n: ilegiveis });
      despachar({ type: "CONVERSA_CARREGADA", turnos: lista, agora: Date.now() });
    } catch (e) {
      avisar("CHAT_CONVERSA_FALHOU", "não deu para carregar a conversa", camposDoErro(e));
      despachar({ type: "CONVERSA_FALHOU" });
    }
    // Depois da PRIMEIRA carga (boa ou não), voltam as bolhas que a aba guardou; a incerta confere
    // de novo — o pedido pode ter chegado enquanto a tela estava fora.
    if (!restaurou.current) {
      restaurou.current = true;
      const locais = locaisDoGuardado(lerGuardado(CHAVE_LOCAIS));
      despachar({ type: "LOCAIS_RESTAURADOS", locais });
      if (locais.length > 0) avisar("CHAT_BOLHAS_RESTAURADAS", "mensagens que não chegaram ao assistente voltaram ao fio", { n: locais.length });
      for (const t of locais) {
        if (t.incerto) {
          despachar({ type: "VERIFICAR", chave: t.chave });
          conferirRef.current?.(t.chave);
        }
      }
    }
  }, []);

  useEffect(() => {
    recarregar();
  }, [recarregar]);

  // Um "desfazer" que a tela não viu responder: o fio inteiro relê, para os chips riscados aparecerem.
  useEffect(() => {
    if (estado.releituras > 0) recarregar();
  }, [estado.releituras, recarregar]);

  // O agente (ou um desfazer) mexeu nos dados: a lista do App relê.
  const mudancasVistas = useRef(estado.mudancas);
  useEffect(() => {
    if (estado.mudancas === mudancasVistas.current) return;
    mudancasVistas.current = estado.mudancas;
    avisarMudanca();
  }, [estado.mudancas, avisarMudanca]);

  // ── O que a aba guarda ──
  useEffect(() => {
    // Antes da restauração o fio ainda não tem as bolhas guardadas: gravar agora as apagaria.
    if (!estado.locaisRestaurados) return;
    const locais = locaisParaGuardar(estado.turnos);
    gravarGuardado(CHAVE_LOCAIS, locais.length > 0 ? locais : null);
  }, [estado.turnos, estado.locaisRestaurados]);

  useEffect(() => {
    gravarGuardado(CHAVE_DESLIGADO, estado.desligado ? true : null);
  }, [estado.desligado]);

  // ── A consulta dos turnos em andamento ──
  const consultando = aConsultar(estado).join("|");
  useEffect(() => {
    if (!consultando) return undefined;
    const ids = consultando.split("|");
    let vivo = true;
    let timer = null;
    const rodada = async () => {
      for (const id of ids) {
        try {
          const turno = normalizarTurno(await comPrazo(api.getTurno(id), PRAZO_DA_CONSULTA_MS));
          if (!vivo) return;
          if (!turno || turno.turno_id !== id) {
            avisar("CHAT_CONSULTA_FORMA", "GET /agente/turnos/:id fora do contrato", { turno_id: id });
            despachar({ type: "CONSULTA_FALHOU", turnoId: id, codigo: FORA_DO_CONTRATO, agora: Date.now() });
            continue;
          }
          if (!STATUS_DO_SERVIDOR.includes(turno.status)) {
            avisarUmaVez("CHAT_STATUS_DESCONHECIDO", "status de turno fora do contrato; tratado como fim", { status: turno.status });
          }
          despachar({ type: "ATUALIZADO", turno, agora: Date.now() });
        } catch (e) {
          if (!vivo) return;
          const codigo = codigoDaFalha(e);
          avisar("CHAT_CONSULTA_FALHOU", "a consulta do turno falhou", { turno_id: id, ...camposDoErro(e), codigo });
          despachar({ type: "CONSULTA_FALHOU", turnoId: id, codigo, agora: Date.now() });
        }
      }
      if (vivo) timer = setTimeout(rodada, INTERVALO_CONSULTA_MS);
    };
    timer = setTimeout(rodada, INTERVALO_CONSULTA_MS);
    return () => {
      vivo = false;
      clearTimeout(timer);
    };
  }, [consultando]);

  // Quando a tela desiste de um turno, o console diz qual e por quê — uma vez.
  useEffect(() => {
    for (const t of estado.turnos) {
      if (t.consulta?.parada) {
        avisarUmaVez("CHAT_CONSULTA_PARADA", "a tela parou de consultar o turno", { turno_id: t.turno_id, motivo: t.consulta.parada });
      }
      if (t.status === PERDIDO) {
        avisarUmaVez("CHAT_TURNO_PERDIDO", "o servidor não conhece o turno consultado (404)", { turno_id: t.turno_id });
      }
    }
  }, [estado.turnos]);

  // ── Enviar ──
  const postar = useCallback(
    async (chave, texto, vinculo) => {
      try {
        const corpo = await api.chatAgente(texto, vinculo ? { tarefa_id: vinculo.tarefa.id } : undefined);
        const r = respostaDoEnvio(corpo);
        if (r.tipo === "ACEITO") {
          despachar({ type: "ACEITO", chave, turnoId: r.turnoId, agora: Date.now() });
          // A Home saiu enquanto o POST voava: ninguém consulta este turno, então a vigia consulta.
          if (!montado.current) {
            vigiar([{ id: r.turnoId, desde: Date.now(), desfazer: false }], avisarMudanca);
          }
        } else if (r.tipo === "RESPONDIDO") {
          despachar({ type: "RESPONDIDO", chave, turno: r.turno, desfazer: r.desfazer, em: agoraIso() });
          if (!montado.current && (r.turno.acoes.length > 0 || (r.desfazer?.desfeitas ?? []).length > 0)) avisarMudanca();
        } else {
          // Um 2xx: o servidor aceitou, só a forma veio torta. A tela procura o turno em vez de
          // oferecer reenviar (que faria tudo duas vezes).
          avisar("CHAT_RESPOSTA_INESPERADA", "POST /agente/chat sem turno_id e sem turno; a tela vai procurar o turno", {});
          despachar({ type: "ENVIO_FALHOU", chave, codigo: FORA_DO_CONTRATO, incerto: true });
          conferirRef.current?.(chave);
        }
      } catch (e) {
        const codigo = codigoDe(e);
        const incerto = falhaIncerta(codigo, e?.status);
        if (codigo === "AGENTE_DESLIGADO") {
          avisar("CHAT_AGENTE_DESLIGADO", "o servidor está sem o assistente; a tela oferece salvar como nota", {});
        } else if (incerto) {
          avisar("CHAT_ENVIO_INCERTO", "não dá para saber se a mensagem chegou; a tela confere antes de oferecer reenviar", camposDoErro(e));
        } else {
          avisar("CHAT_ENVIO_FALHOU", "a mensagem não chegou ao assistente (recusa clara)", camposDoErro(e));
        }
        despachar({ type: "ENVIO_FALHOU", chave, codigo, status: e?.status, incerto });
        if (incerto) conferirRef.current?.(chave, { espera: ESPERA_ANTES_DE_CONFERIR_MS });
      }
    },
    [avisarMudanca],
  );

  /**
   * Confere no servidor se o envio incerto da bolha `chave` (já em VERIFICANDO) virou turno: GET
   * /conversa com poucos turnos. Achou → a bolha adota o turno (VERIFICADO). Não achou → a bolha fica
   * NAO_ENVIADO conferida e os botões aparecem; com `reenviarSeAusente` (o "Tentar de novo"), reenvia.
   * A conferência que falha não libera nada: fica o "Verificar de novo".
   */
  const conferir = useCallback(
    async (chave, { espera = 0, reenviarSeAusente = false } = {}) => {
      if (espera > 0) await new Promise((r) => setTimeout(r, espera));
      let lista;
      try {
        const corpo = await comPrazo(api.getConversa({ canal: "web", limite: LIMITE_VERIFICACAO }), PRAZO_DA_CONSULTA_MS);
        if (!Array.isArray(corpo?.turnos)) throw foraDoContrato("GET /agente/conversa sem a lista de turnos");
        lista = corpo.turnos;
      } catch (e) {
        avisar("CHAT_CONFERENCIA_FALHOU", "não deu para conferir se a mensagem chegou; a tela não oferece reenviar", {
          ...camposDoErro(e),
          codigo: codigoDaFalha(e),
        });
        despachar({ type: "VERIFICACAO_FALHOU", chave });
        return;
      }
      const antes = estadoRef.current;
      const local = antes.turnos.find((t) => t.chave === chave);
      // Outro caminho (o GET da conversa inteira) já resolveu esta bolha enquanto a conferência voava.
      if (!local || local.status !== VERIFICANDO) return;
      const achado = turnoAdotavel(antes.turnos, chave, lista);
      despachar({ type: "VERIFICADO", chave, turnos: lista, agora: Date.now() });
      if (achado) {
        avisar("CHAT_ENVIO_ADOTADO", "a mensagem tinha chegado; a bolha adotou o turno do servidor", {
          turno_id: achado.turno_id,
          status: achado.status,
        });
        return;
      }
      avisar("CHAT_ENVIO_AUSENTE", "a mensagem não está no servidor", { reenviando: reenviarSeAusente });
      if (reenviarSeAusente) {
        despachar({ type: "REENVIAR", chave, agora: Date.now() });
        postar(chave, local.entrada, local.contexto);
      }
    },
    [postar],
  );
  conferirRef.current = conferir;

  /** Manda um texto como turno novo. `vinculo` = {tarefa, frente, projeto} do TaskPicker, ou null. */
  const enviar = useCallback(
    (texto, vinculo = null) => {
      const chave = novaChave();
      despachar({ type: "ENVIAR", chave, texto, contexto: vinculo, agora: Date.now() });
      postar(chave, texto, vinculo);
    },
    [postar],
  );

  const tentarDeNovo = useCallback(
    (chave) => {
      const atual = estadoRef.current;
      const t = atual.turnos.find((x) => x.chave === chave);
      if (!t || !podeTentarDeNovo(t, opcoesDeRetentar(atual, t))) return;
      if (ehFalhaLocal(t.status)) {
        if (t.incerto) {
          // Já foi conferida, mas um pedido em voo pode ter chegado depois: confere de novo, e só
          // reenvia se o turno continuar ausente.
          despachar({ type: "VERIFICAR", chave });
          conferir(chave, { reenviarSeAusente: true });
          return;
        }
        // Nunca chegou ao servidor: a mesma bolha sai de novo.
        despachar({ type: "REENVIAR", chave, agora: Date.now() });
        postar(chave, t.entrada, t.contexto);
        return;
      }
      const nova = novaChave();
      despachar({ type: "RETENTAR", chave, nova, agora: Date.now() });
      postar(nova, t.entrada, t.contexto);
    },
    [postar, conferir],
  );

  /** "Verificar de novo" de uma bolha incerta: só confere, nunca reenvia. */
  const verificarEnvio = useCallback(
    (chave) => {
      const t = estadoRef.current.turnos.find((x) => x.chave === chave);
      if (!t || t.status !== NAO_ENVIADO || !t.incerto) return;
      despachar({ type: "VERIFICAR", chave });
      conferir(chave);
    },
    [conferir],
  );

  const retomarConsulta = useCallback((turnoId) => {
    despachar({ type: "CONSULTA_RETOMADA", turnoId, agora: Date.now() });
  }, []);

  // ── Desfazer pelo chip ──
  const desfazer = useCallback(
    async (turnoId, idx) => {
      despachar({ type: "DESFAZER_PEDIDO", turnoId, idx });
      try {
        const corpo = await api.desfazerAgente(turnoId, idx);
        const desfeitas = Array.isArray(corpo?.desfeitas) && corpo.desfeitas.length > 0 ? corpo.desfeitas : [{ idx }];
        despachar({ type: "DESFEITO", turnoId, desfeitas, em: agoraIso() });
        toast.show({ message: desfeitas.length > 1 ? `${desfeitas.length} ações desfeitas.` : "Desfeito.", tone: "success" });
      } catch (e) {
        const codigo = codigoDe(e);
        despachar({ type: "DESFAZER_FALHOU", turnoId, idx, codigo, em: agoraIso() });
        if (codigo === "DESFAZER_JA_FEITO") {
          // Outra porta (o WhatsApp, o comando "desfazer", outra aba) chegou antes: o chip só se acerta.
          avisar("CHAT_DESFAZER_JA_FEITO", "a ação já estava desfeita; chip atualizado", { turno_id: turnoId, idx });
          toast.show({ message: mensagemDoDesfazer(codigo) });
        } else {
          falha("CHAT_DESFAZER_FALHOU", mensagemDoDesfazer(codigo), e, { turno_id: turnoId, idx });
        }
      }
    },
    [toast, falha],
  );

  // ── Nova conversa ──
  const novaConversa = useCallback(async () => {
    if (estadoRef.current.novaConversa === "PEDINDO") return;
    despachar({ type: "NOVA_CONVERSA_PEDIDA" });
    try {
      await api.novaConversa("web");
      despachar({ type: "NOVA_CONVERSA_FEITA" });
      toast.show({ message: "Conversa nova: o assistente começa do zero na próxima mensagem." });
    } catch (e) {
      despachar({ type: "NOVA_CONVERSA_FALHOU" });
      falha("CHAT_NOVA_CONVERSA_FALHOU", "Não deu para começar uma conversa nova.", e);
    }
  }, [toast, falha]);

  // ── Sem o assistente: a caixa de captura de antes (parseInput) ──
  // O mesmo caminho do InputBar: o prefixo escolhe o tipo, e o vínculo vira UM comentário da tarefa.
  const registrarNota = useCallback(
    async (texto, vinculo) => {
      const { type, body } = parseInput(texto);
      const { entry } = await api.createEntry({
        type,
        title: body.slice(0, 80) + (body.length > 80 ? "…" : ""),
        content: body,
        tags: [], // sem date: o backend grava o dia de hoje em São Paulo
      });
      onCreatedRef.current?.(entry);
      if (vinculo) {
        try {
          await comentar({ tipo: "TAREFA", id: vinculo.tarefa.id }, body, vinculo.tarefa.comments);
        } catch (e) {
          falha("VINCULO_TAREFA_FALHOU", "A nota foi criada, mas não chegou à tarefa.", e);
        }
      }
      return entry;
    },
    [falha],
  );

  /** A bolha que não chegou ao assistente vira nota (ou evento, lembrete… pelo prefixo). */
  const salvarComoNota = useCallback(
    async (chave) => {
      const t = estadoRef.current.turnos.find((x) => x.chave === chave);
      if (!t || !podeSalvarComoNota(t) || t.salvandoNota) return;
      despachar({ type: "NOTA_SALVANDO", chave });
      try {
        const entry = await registrarNota(t.entrada, t.contexto);
        despachar({ type: "NOTA_SALVA", chave, nota: { id: entry?.id ?? null, type: entry?.type ?? null } });
      } catch (e) {
        despachar({ type: "NOTA_FALHOU", chave });
        falha("ENTRADA_CRIAR_FALHOU", "Não foi possível salvar como nota.", e);
      }
    },
    [registrarNota, falha],
  );

  /** O composer com o assistente desligado: grava direto. true = gravou (a caixa pode limpar). */
  const salvarDireto = useCallback(
    async (texto, vinculo) => {
      try {
        await registrarNota(texto, vinculo);
        despachar({ type: "CAPTURA_FEITA" });
        return true;
      } catch (e) {
        // O texto fica na caixa: nada do que o Carlos escreveu se perde.
        falha("ENTRADA_CRIAR_FALHOU", "Não foi possível registrar. O texto continua na caixa.", e);
        return false;
      }
    },
    [registrarNota, falha],
  );

  const reativar = useCallback(() => despachar({ type: "REATIVAR" }), []);

  return {
    estado,
    ocupado: ocupado(estado),
    recarregar,
    enviar,
    tentarDeNovo,
    verificarEnvio,
    retomarConsulta,
    desfazer,
    novaConversa,
    salvarComoNota,
    salvarDireto,
    reativar,
  };
}
