import express from "express";
import { CANAIS } from "../dominio/enums.js";
import { ENUMS_COBERTOS, NODES, OPERATIONS, RELATIONSHIPS, ROTULOS, systemPrompt } from "../agente/ontologia.js";
import { responderErro } from "./ops.js";

// A2 · a ontologia como dado, para quem não é o motor:
//   GET /api/ontologia               → entidades, relações, rótulos, enums e operações. O front lê
//                                      os rótulos e as listas DAQUI (useOntologia), em vez de manter
//                                      as suas — no CRM havia duas cópias e nenhum teste entre elas.
//   GET /api/ontologia/prompt?canal= → o system prompt congelado daquele canal, em texto. O MCP o
//                                      serve como o prompt `assistente-fields`.

// Montado uma vez: tudo aqui só muda com restart (a flag é lida no import).
const ONTOLOGIA = Object.freeze({
  nodes: NODES,
  relationships: RELATIONSHIPS,
  rotulos: ROTULOS,
  enums: Object.fromEntries(ENUMS_COBERTOS.map(([chave, valores]) => [chave, [...valores]])),
  operations: OPERATIONS.map(({ name, tipo, acao, resumo }) => ({ name, tipo, acao: acao ?? null, resumo })),
});

export function rotasOntologia() {
  const r = express.Router();

  r.get("/ontologia", (_req, res) => {
    res.json(ONTOLOGIA);
  });

  r.get("/ontologia/prompt", (req, res) => {
    const canal = req.query.canal;
    if (!CANAIS.includes(canal)) {
      return responderErro(res, { erro: `canal inválido (use ${CANAIS.join(", ")})`, codigo: "CANAL_INVALIDO" }, 400);
    }
    res.type("text/plain; charset=utf-8").send(systemPrompt({ canal }));
  });

  return r;
}
