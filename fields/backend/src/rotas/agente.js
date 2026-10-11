import express from "express";
import { z } from "zod";
import { aw, ctxDe } from "../lib/rota.js";
import { CANAIS_DO_MOTOR } from "../dominio/enums.js";
import { executeRead, camposDoErro, erroDe } from "../agente/ferramentas.js";
import { desfazerTurno } from "../agente/desfazer.js";
import { criarCliente } from "../agente/cliente.js";
import { ehComandoDesfazer, iniciarTurno, lojaSql, novaConversa, rodarTurno } from "../agente/motor.js";
import { log } from "../lib/log.js";
import { responderErro } from "./ops.js";

// A2 · o que a tela (e, na A4, o resumo da manhã) pede ao agente sem passar pelo modelo.
//   GET  /api/resumo-do-dia?data=AAAA-MM-DD → {resultado} — o MESMO da ferramenta ResumoDoDia
//                                             (passa pelo executeRead: um formato só).
//   POST /api/agente/desfazer {turno_id, idx?} → {desfeitas:[{idx, resumo}]} | {erro, codigo}
//                                             Sem LLM: inverte o que o turno anotou.
//
// A2b · o chat da tela — contrato FIXO com a R3 (Home = o chat):
//   POST /api/agente/chat {texto, contexto?:{tarefa_id}}
//        → 202 {turno_id}: o turno roda em segundo plano, neste processo; a tela consulta /turnos/:id.
//        → 200 <turno> quando o texto é o comando "desfazer" (síncrono, sem modelo), com
//          desfazer:{turno_id, desfeitas:[{idx, resumo}]} (ou {codigo} quando não deu).
//        → 503 {erro, codigo:"AGENTE_DESLIGADO"} sem AGENTE_HABILITADO (a tela salva como nota).
//   GET  /api/agente/turnos/:id → <turno> | 404 NAO_ENCONTRADO
//   GET  /api/agente/conversa?canal=web&limite=30 → {turnos:[<turno>…]}, do mais antigo ao mais novo
//   POST /api/agente/nova-conversa {canal?} → {encerrada}: a próxima mensagem abre sessão nova.
//
//   <turno> = {turno_id, status, motivo, texto, acoes:[{idx, acao, resumo, desfazivel, desfeito_em}],
//              progresso:{n_tools}} + entrada, sessao_id, criado_em, concluido_em (servicos/turnos.js).
//   status: EM_ANDAMENTO | CONCLUIDO | ESGOTADO | FALHOU | RECUSADO.

const CORPO_DESFAZER = z.strictObject({
  turno_id: z.string().min(1),
  idx: z.number().int().min(0).optional(),
});

// O que o Carlos digita na tela. O teto é generoso (uma nota colada inteira), e existe porque o texto
// vai inteiro ao modelo em toda chamada do turno.
export const TEXTO_CHAT_MAX = 10_000;

const CORPO_CHAT = z.strictObject({
  texto: z.string().trim().min(1).max(TEXTO_CHAT_MAX),
  // Só a forma de um id: vai num atributo do bloco de contexto (ontologia.contextoDoTurno).
  contexto: z.strictObject({ tarefa_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).optional(),
});

const CORPO_NOVA_CONVERSA = z.strictObject({ canal: z.enum(CANAIS_DO_MOTOR).optional() });

const CONSULTA_CONVERSA = z.object({
  canal: z.enum(CANAIS_DO_MOTOR).default("web"),
  limite: z.coerce.number().int().min(1).max(100).default(30),
});

const invalido = (res, erro) =>
  responderErro(res, { ...erroDe({ ok: false, motivo: "ARGUMENTOS_INVALIDOS" }), campos: camposDoErro(erro) }, 400);

/**
 * As dependências do motor para as rotas que rodam turno — a tela (aqui) e o WhatsApp
 * (rotas/whatsapp.js). Montadas UMA vez por app (app.js) e divididas entre as duas: um cliente do
 * modelo por processo, e a mesma loja.
 *
 * `motor` são as costuras do teste ({cliente, loja, executar, desfazer, relogio}); sem elas, o
 * cliente sai da config (criado na primeira mensagem) e a persistência é o Postgres.
 */
export function criarDepsDoMotor({ db, estado, config, motor = {} }) {
  const agente = config?.agente ?? { habilitado: false };
  const loja = motor.loja ?? lojaSql(db);
  let cliente = motor.cliente ?? null;
  const deps = () => {
    cliente ??= criarCliente(agente);
    return { db, comentariosMigrados: estado.comentariosMigrados, agente, ...motor, cliente, loja };
  };
  return { agente, loja, deps };
}

export function rotasAgente({ db, estado, config, motor = {}, depsMotor = criarDepsDoMotor({ db, estado, config, motor }) }) {
  const r = express.Router();
  const { agente, loja, deps } = depsMotor;

  r.get("/resumo-do-dia", aw(async (req, res) => {
    const args = req.query.data === undefined ? {} : { data: req.query.data };
    const saida = await executeRead("ResumoDoDia", args, { db, ...ctxDe(req, estado), agora: new Date() });
    if (saida.erro) return responderErro(res, saida);
    return res.json({ resultado: saida.resultado });
  }));

  r.post("/agente/desfazer", aw(async (req, res) => {
    const corpo = CORPO_DESFAZER.safeParse(req.body ?? {});
    if (!corpo.success) {
      return responderErro(res, { ...erroDe({ ok: false, motivo: "ARGUMENTOS_INVALIDOS" }), campos: camposDoErro(corpo.error) }, 400);
    }
    const resultado = await desfazerTurno(db, { ...ctxDe(req, estado), agora: new Date() }, {
      turnoId: corpo.data.turno_id, idx: corpo.data.idx,
    });
    if (!resultado.ok) {
      return responderErro(res, erroDe(resultado), resultado.motivo === "NAO_ENCONTRADO" ? 404 : 409);
    }
    return res.json(resultado.valor);
  }));

  // ── A2b · o chat ──

  r.post("/agente/chat", aw(async (req, res) => {
    // Antes de validar o corpo: desligado é desligado, e a tela decide pelo código (Salvar como nota).
    if (!agente.habilitado) {
      return responderErro(res, { erro: "O assistente está desligado neste servidor.", codigo: "AGENTE_DESLIGADO" }, 503);
    }
    const corpo = CORPO_CHAT.safeParse(req.body ?? {});
    if (!corpo.success) return invalido(res, corpo.error);
    const args = {
      canal: "web",
      entrada: { texto: corpo.data.texto },
      contexto: corpo.data.contexto ? { tarefaId: corpo.data.contexto.tarefa_id } : null,
    };
    // O "desfazer" não chama modelo e termina em milissegundos: a tela recebe o resultado já.
    if (ehComandoDesfazer(corpo.data.texto)) {
      return res.status(200).json(await rodarTurno(deps(), args));
    }
    const { turnoId, resultado } = await iniciarTurno(deps(), args);
    // O turno nunca rejeita (falha vira FALHOU); o catch é o cinto para o processo não cair.
    resultado.catch((err) => log.erro("AGENTE_TURNO_REJEITADO", { turno_id: turnoId, erro: err?.name }));
    return res.status(202).json({ turno_id: turnoId });
  }));

  r.get("/agente/turnos/:id", aw(async (req, res) => {
    const turno = await loja.obterTurnoPublico(req.params.id);
    if (!turno) return responderErro(res, { erro: "Turno não encontrado.", codigo: "NAO_ENCONTRADO" }, 404);
    return res.json(turno);
  }));

  r.get("/agente/conversa", aw(async (req, res) => {
    const consulta = CONSULTA_CONVERSA.safeParse(req.query ?? {});
    if (!consulta.success) return invalido(res, consulta.error);
    return res.json({ turnos: await loja.listarConversa(consulta.data.canal, consulta.data.limite) });
  }));

  r.post("/agente/nova-conversa", aw(async (req, res) => {
    const corpo = CORPO_NOVA_CONVERSA.safeParse(req.body ?? {});
    if (!corpo.success) return invalido(res, corpo.error);
    return res.json(await novaConversa(loja, corpo.data.canal ?? "web"));
  }));

  return r;
}
