import express from "express";
import { v4 as uuidv4 } from "uuid";
import { aw, ctxDe } from "../lib/rota.js";
import { OPERATIONS } from "../agente/ontologia.js";
import { catalogo } from "../agente/catalogo.js";
import { executeRead, executeWrite } from "../agente/ferramentas.js";

// A2 · as operações da ontologia por HTTP — a porta do MCP (Bearer → origem 'mcp') e, pela tela,
// da web (cookie → origem 'web'). O MESMO executeRead/executeWrite do motor do chat: o MCP não tem
// caminho próprio até o banco.
//
//   GET  /api/ops        → {versao, ops} (catalogo.js), só as operações LIGADAS, na ordem da ontologia.
//   POST /api/ops/:name  → {resultado, acao?} | {erro, codigo, ...}
//
// Uma escrita aqui é um turno de uma ação só (agente_turnos, canal mcp ou web), criado no mesmo tx
// da escrita: é o que dá a ela um turno_id + idx para o POST /api/agente/desfazer. `desfazivel` diz
// se ESSE endpoint consegue inverter — não que o chamador alcance a volta: o cliente MCP não chama o
// desfazer, e por isso o servidor MCP não repassa a marca, e o prompt do canal mcp diz o que não
// tem volta por lá (ontologia.js, _voltaNoMcp).

// Código → status HTTP. Recusa de domínio é 404/409/422; nunca 500 (só ERRO_INTERNO, que é falha).
const STATUS_DO_CODIGO = {
  OPERACAO_INDISPONIVEL: 404,
  ARGUMENTOS_INVALIDOS: 400,
  NAO_ENCONTRADO: 404,
  NAO_ENCONTRADA: 404,
  MEMORIA_CHEIA: 409,
  AMBIGUO: 409,
  COMENTARIOS_INDISPONIVEIS: 409,
  COMENTARIOS_DESATUALIZADOS: 409,
  ERRO_INTERNO: 500,
};

/** Resposta de erro do contrato: {erro, codigo, ...}; o código vai ao HTTP_REQ como motivo. */
export function responderErro(res, corpo, status = STATUS_DO_CODIGO[corpo.codigo] ?? 422) {
  res.locals.motivo = corpo.codigo;
  return res.status(status).json(corpo);
}

export function rotasOps({ db, estado }) {
  const r = express.Router();

  r.get("/ops", (_req, res) => {
    res.json(catalogo());
  });

  r.post("/ops/:name", aw(async (req, res) => {
    const nome = req.params.name;
    const ctx = { db, ...ctxDe(req, estado), agora: new Date() };
    const op = OPERATIONS.find((o) => o.name === nome);

    // Nome desconhecido ou desligado cai no executeRead, que recusa com OPERACAO_INDISPONIVEL e
    // loga — o portão é um só, e é o do executor.
    const saida = op?.tipo === "WRITE"
      ? await executeWrite(nome, req.body, {
        ...ctx, turnoId: uuidv4(), canal: req.origem === "mcp" ? "mcp" : "web",
      })
      : await executeRead(nome, req.body, ctx);

    if (saida.erro) return responderErro(res, saida);
    if (!saida.acao) return res.json({ resultado: saida.resultado });
    const { turno_id, idx, acao, resumo, desfazivel } = saida.acao;
    return res.json({ resultado: saida.resultado, acao: { turno_id, idx, acao, resumo, desfazivel } });
  }));

  return r;
}
