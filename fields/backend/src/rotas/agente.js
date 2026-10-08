import express from "express";
import { z } from "zod";
import { aw, ctxDe } from "../lib/rota.js";
import { executeRead, camposDoErro, erroDe } from "../agente/ferramentas.js";
import { desfazerTurno } from "../agente/desfazer.js";
import { responderErro } from "./ops.js";

// A2 · o que a tela (e, na A4, o resumo da manhã) pede ao agente sem passar pelo modelo.
//   GET  /api/resumo-do-dia?data=AAAA-MM-DD → {resultado} — o MESMO da ferramenta ResumoDoDia
//                                             (passa pelo executeRead: um formato só).
//   POST /api/agente/desfazer {turno_id, idx?} → {desfeitas:[{idx, resumo}]} | {erro, codigo}
//                                             Sem LLM: inverte o que o turno anotou.

const CORPO_DESFAZER = z.strictObject({
  turno_id: z.string().min(1),
  idx: z.number().int().min(0).optional(),
});

export function rotasAgente({ db, estado }) {
  const r = express.Router();

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

  return r;
}
