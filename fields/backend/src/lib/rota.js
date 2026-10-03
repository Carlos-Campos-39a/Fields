// Utilitários das rotas Express.

/** Express 4 não captura rejeição de handler async: aw() encaminha o erro ao tratador final. */
export const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Contexto que os serviços recebem: quem originou a ação (turnoId só existe no agente, A2) e o modo
 * dos comentários, lido da tabela `migracoes` no boot (db/schema.js → estado). O modo viaja no ctx
 * para que todo caminho até o banco — rota hoje, agente na A2 — leia e escreva no MESMO lugar.
 */
export const ctxDe = (req, estado) => ({
  origem: req.origem ?? "web",
  turnoId: null,
  comentariosMigrados: estado.comentariosMigrados,
});

// Motivo de recusa do serviço → resposta HTTP. Os cinco primeiros são os corpos do server.js
// monolítico, byte a byte: o front e o MCP comparam esses textos. Os da A1 são códigos novos, em
// snake_case como os da A0 (nao_autenticado, json_invalido).
const RESPOSTA_LEGADA = {
  NAO_ENCONTRADO: [404, { error: "Not found" }],
  NADA_A_ATUALIZAR: [400, { error: "nothing to update" }],
  NOME_OBRIGATORIO: [400, { error: "name required" }],
  TITULO_E_CONTEUDO_OBRIGATORIOS: [400, { error: "title and content are required" }],
  TITULO_E_DATA_OBRIGATORIOS: [400, { error: "title and date required" }],
  // ─── A1 ───
  COMENTARIOS_INDISPONIVEIS: [503, { error: "comentarios_indisponiveis" }], // migração falhou: modo legado
  COMENTARIOS_INVALIDOS: [400, { error: "comentarios_invalidos" }],         // array legado ilegível
  COMENTARIOS_DESATUALIZADOS: [409, { error: "comentarios_desatualizados" }], // array legado sem mais de um vivo: retrato velho
  ALVO_INVALIDO: [400, { error: "alvo_invalido" }],
  TEXTO_OBRIGATORIO: [400, { error: "texto_obrigatorio" }],
  TEXTO_LONGO_DEMAIS: [400, { error: "texto_longo_demais" }],
  TIPO_INVALIDO: [400, { error: "tipo_invalido" }],
};

/** Responde um Resultado de serviço: sucesso → status + montar(valor); recusa → corpo legado. */
export function responder(res, resultado, status = 200, montar = (v) => v) {
  if (resultado.ok) return res.status(status).json(montar(resultado.valor));
  const legado = RESPOSTA_LEGADA[resultado.motivo];
  if (!legado) throw new Error(`motivo sem resposta HTTP: ${resultado.motivo}`);
  res.locals.motivo = resultado.motivo;
  return res.status(legado[0]).json(legado[1]);
}

/**
 * DELETE de projeto, frente, tarefa e reunião: o corpo de sempre ({success:true}) mesmo quando não
 * havia o que excluir — o front e o MCP contam com isso. O serviço diz a verdade (NAO_ENCONTRADO),
 * e ela vai para o HTTP_REQ como motivo: a resposta é a legada, o log não é mudo.
 */
export function responderExclusaoLegada(res, resultado) {
  if (!resultado.ok && resultado.motivo !== "NAO_ENCONTRADO") return responder(res, resultado);
  if (!resultado.ok) res.locals.motivo = resultado.motivo;
  return res.status(200).json({ success: true });
}

// ─── Template da rota para log ────────────────────────────────
// O log nunca leva o path cru (ele carrega ids); leva o template ("/api/entries/:id"). Uma recusa
// de auth acontece ANTES do roteamento, quando req.route ainda não existe — por isso a tabela.

function compilar(template) {
  const corpo = template
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${corpo}/?$`, "i");
}

/** Lista {metodo, template, re} das rotas de routers montados em `base`, na ordem do Express. */
export function tabelaDeRotas(base, routers) {
  const tabela = [];
  for (const router of routers) {
    for (const camada of router.stack) {
      if (!camada.route) continue;
      const template = base + camada.route.path;
      for (const metodo of Object.keys(camada.route.methods)) {
        tabela.push({ metodo: metodo.toUpperCase(), template, re: compilar(template) });
      }
    }
  }
  return tabela;
}

export function rotaDe(req, tabela) {
  if (req.route && req.baseUrl) return req.baseUrl + req.route.path;
  const caminho = (req.originalUrl || req.url || "").split("?")[0];
  const metodo = req.method === "HEAD" ? "GET" : req.method;
  const achada = tabela.find((r) => r.metodo === metodo && r.re.test(caminho));
  return achada ? achada.template : "nao_roteada";
}
