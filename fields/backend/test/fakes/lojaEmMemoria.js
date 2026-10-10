// A persistência do motor em memória — a mesma forma de motor.lojaSql(db), para o teste de unidade
// rodar sem Postgres. As decisões que importam NÃO são reimplementadas aqui: a renovação de sessão é
// sessoes.motivoDeRenovacao e o formato da tela é turnos.turnoPublico (as mesmas funções da loja
// SQL). O que a de verdade faz com SQL, a integração (motor_integracao.test.js) confere.
//
// As mensagens são guardadas como TEXTO (JSON.stringify) e relidas com JSON.parse, como a coluna
// `content TEXT` — o teste do invariante de prefixo passa pela mesma ida e volta que a produção.

import { motivoDeRenovacao } from "../../src/agente/sessoes.js";
import { turnoPublico } from "../../src/servicos/turnos.js";

export function lojaEmMemoria({ relogio = () => new Date(), memorias = [] } = {}) {
  const turnos = new Map();
  const sessoes = [];
  const mensagens = [];
  let nSessao = 0;

  const ativa = (canal) => sessoes.find((s) => s.canal === canal && s.status === "ATIVA") ?? null;
  const encerrar = (s, motivo) => {
    if (!s || s.status !== "ATIVA") return false;
    Object.assign(s, { status: "ENCERRADA", motivo, encerrado_em: relogio() });
    return true;
  };
  // Só os turnos da conversa, como DO_MOTOR em servicos/turnos.js: com sessão, ou ainda na fila.
  const doCanal = (canal) => [...turnos.values()].filter((t) => t.canal === canal && (t.sessao_id !== null || t.status === "EM_ANDAMENTO"))
    .sort((a, b) => a.criado_em - b.criado_em || a.ordem - b.ordem);

  return {
    turnos, sessoes, mensagens, memorias,

    async abrirTurno({ id, canal, entrada }) {
      turnos.set(id, {
        id, canal, sessao_id: null, status: "EM_ANDAMENTO", motivo: null, entrada, resposta: null, acoes: [],
        metricas: null, criado_em: relogio(), concluido_em: null, ordem: turnos.size,
      });
    },
    async vincularSessao(turnoId, sessaoId) { turnos.get(turnoId).sessao_id = sessaoId; },
    async registrarProgresso(turnoId, n) {
      const t = turnos.get(turnoId);
      t.metricas = { ...(t.metricas ?? {}), n_tools: n };
    },
    async concluirTurno(turnoId, { status, motivo, resposta, metricas }) {
      const t = turnos.get(turnoId);
      if (t.status !== "EM_ANDAMENTO") return false;
      Object.assign(t, { status, motivo, resposta, metricas: { ...(t.metricas ?? {}), ...metricas }, concluido_em: relogio() });
      return true;
    },
    async obterTurnoPublico(turnoId) {
      const t = turnos.get(turnoId);
      return t ? turnoPublico(t) : null;
    },
    async listarConversa(canal, limite) { return doCanal(canal).slice(-limite).map(turnoPublico); },
    async ultimoTurnoDesfazivel(canal, janelaMin, { exceto = null } = {}) {
      const limite = relogio().getTime() - janelaMin * 60_000;
      const candidatos = doCanal(canal).filter((t) => t.id !== exceto && t.sessao_id !== null && t.criado_em.getTime() > limite &&
        t.acoes.some((a) => a.desfazivel && !a.desfeito_em));
      return candidatos.at(-1)?.id ?? null;
    },
    async turnosParaRecap(canal, { limite = 5, exceto = null } = {}) {
      return doCanal(canal).filter((t) => t.status !== "EM_ANDAMENTO" && t.sessao_id !== null && t.id !== exceto).slice(-limite);
    },

    async obterOuRenovar({ canal, promptVersao, modelo, agora, ociosaHoras }) {
      const atual = ativa(canal);
      let motivo;
      if (atual) {
        motivo = motivoDeRenovacao(atual, { promptVersao, modelo, agora, ociosaHoras });
        if (!motivo) {
          const lidas = mensagens.filter((m) => m.sessao_id === atual.id).sort((a, b) => a.seq - b.seq)
            .map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
          return { sessao: atual, mensagens: lidas, nova: false, motivo: null };
        }
        encerrar(atual, motivo);
      } else {
        motivo = sessoes.filter((s) => s.canal === canal).at(-1)?.motivo ?? "PRIMEIRA";
      }
      const sessao = {
        id: `sessao-${++nSessao}`, canal, prompt_versao: promptVersao, modelo, status: "ATIVA", motivo: null,
        n_mensagens: 0, ultimo_input_tokens: 0, criado_em: relogio(), ultima_atividade_em: relogio(), encerrado_em: null,
      };
      sessoes.push(sessao);
      return { sessao, mensagens: [], nova: true, motivo };
    },
    async acrescentarMensagens(sessaoId, turnoId, novas, { inputTokens = null } = {}) {
      const s = sessoes.find((x) => x.id === sessaoId);
      for (const m of novas) {
        mensagens.push({ sessao_id: sessaoId, seq: s.n_mensagens++, role: m.role, content: JSON.stringify(m.content), turno_id: turnoId });
      }
      s.ultima_atividade_em = relogio();
      if (inputTokens != null) s.ultimo_input_tokens = inputTokens;
    },
    async encerrarSessao(sessaoId, motivo) { return encerrar(sessoes.find((s) => s.id === sessaoId), motivo); },
    async encerrarAtiva(canal, motivo) { return encerrar(ativa(canal), motivo); },
    async memoriasAtivas() { return memorias; },

    // Só do teste: o que o executeWrite faz no banco (registrarAcao, no tx da escrita).
    anotarAcao(turnoId, acao) {
      const t = turnos.get(turnoId);
      const completa = { desfeito_em: null, ...acao, idx: t.acoes.length };
      t.acoes.push(completa);
      return { turno_id: turnoId, ...completa };
    },
    historicoDe(sessaoId) {
      return mensagens.filter((m) => m.sessao_id === sessaoId).sort((a, b) => a.seq - b.seq)
        .map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
    },
  };
}

/**
 * O executor de teste: responde por nome de ferramenta e grava cada chamada (nome, argumentos e o
 * ctx que o motor montou). Uma resposta com `acao` é anotada no turno, como a escrita de verdade.
 * `respostas[nome]` pode ser um objeto ({resultado} | {erro, codigo} | {resultado, acao}) ou uma
 * função (args, ctx) → objeto.
 */
export function executorFalso(loja, respostas = {}) {
  const chamadas = [];
  const executar = async (nome, args, ctx) => {
    chamadas.push({ nome, args, ctx: { origem: ctx.origem, turnoId: ctx.turnoId, canal: ctx.canal, comentariosMigrados: ctx.comentariosMigrados } });
    const r = respostas[nome];
    const saida = (typeof r === "function" ? await r(args, ctx) : r) ?? { resultado: { ok: true } };
    if (saida.acao) return { ...saida, acao: loja.anotarAcao(ctx.turnoId, saida.acao) };
    return saida;
  };
  return { executar, chamadas };
}

/** Um relógio que só anda quando o teste manda. */
export function relogioFalso(inicio = "2026-10-10T15:00:00Z") {
  let t = new Date(inicio).getTime();
  return { agora: () => new Date(t), avancar: (ms) => { t += ms; } };
}
