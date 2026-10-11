const BASE = "/api";

// Evento global de sessão expirada/ausente. O <Gate> escuta e volta para o login.
export const EVENTO_401 = "fields:401";

// O backend devolve hoje TRÊS formatos de erro, de três épocas:
//   {error: "Not found"}                    o legado do server.js monolítico — texto humano, que o
//                                           MCP compara byte a byte, então não muda;
//   {error: "comentarios_indisponiveis"}    os códigos da A0/A1, em snake_case;
//   {erro, codigo: "NAO_ENCONTRADO"}        o contrato da A2 (/api/ops, /api/agente/*) e o
//                                           ErroDominio ({error, codigo}).
// A tela decide SEMPRE pelo `codigo`, normalizado para UPPER_SNAKE — nunca pelo texto, que é de
// gente e muda. Sem isso cada tela teria de saber de que época é a rota que chamou.
const CODIGO_DO_LEGADO = Object.freeze({
  "Not found": "NAO_ENCONTRADO",
  "nothing to update": "NADA_A_ATUALIZAR",
  "name required": "NOME_OBRIGATORIO",
  "title and content are required": "TITULO_E_CONTEUDO_OBRIGATORIOS",
  "title and date required": "TITULO_E_DATA_OBRIGATORIOS",
});

// Corpo sem código reconhecível (o 404 HTML do Express, um 502 do rewrite da Vercel): o status
// ainda diz o bastante para a tela escolher a mensagem.
const CODIGO_DO_STATUS = Object.freeze({
  400: "REQUISICAO_INVALIDA",
  401: "NAO_AUTENTICADO",
  403: "PROIBIDO",
  404: "NAO_ENCONTRADO",
  409: "CONFLITO",
  413: "CORPO_GRANDE_DEMAIS",
  415: "CONTENT_TYPE_INVALIDO",
  429: "MUITAS_TENTATIVAS",
});

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * {status, corpo} de uma resposta de erro → {codigo, detalhe}. Pura; testada em api.test.js.
 * `codigo` é sempre UPPER_SNAKE; `detalhe` é o texto do servidor quando ele não é o próprio código
 * (serve para depurar, nunca para decidir).
 */
export function normalizarErro(status, corpo) {
  const c = corpo && typeof corpo === "object" && !Array.isArray(corpo) ? corpo : null;
  const error = typeof c?.error === "string" ? c.error : null;
  const erro = typeof c?.erro === "string" ? c.erro : null;

  if (typeof c?.codigo === "string" && c.codigo.trim() !== "") {
    return { codigo: c.codigo.trim().toUpperCase(), detalhe: erro ?? error };
  }
  if (error && Object.prototype.hasOwnProperty.call(CODIGO_DO_LEGADO, error)) {
    return { codigo: CODIGO_DO_LEGADO[error], detalhe: error };
  }
  if (error && SNAKE.test(error)) {
    return { codigo: error.toUpperCase(), detalhe: null };
  }
  let codigo = CODIGO_DO_STATUS[status];
  if (!codigo) codigo = status >= 500 ? "ERRO_SERVIDOR" : `HTTP_${status}`;
  return { codigo, detalhe: erro ?? error };
}

// Erro de API com o status HTTP e o código estável (ver normalizarErro). Estende Error, então os
// catch existentes continuam valendo. A falha de REDE não vira ApiError: continua o TypeError do
// fetch — o Gate e a LoginPage distinguem "sem conexão" por isso.
export class ApiError extends Error {
  constructor(status, codigo, mensagem, corpo, detalhe = null) {
    super(mensagem);
    this.name = "ApiError";
    this.status = status;
    this.codigo = codigo;
    this.corpo = corpo;
    this.detalhe = detalhe;
  }
}

/** O código de qualquer erro vindo de req(): o da API, SEM_CONEXAO para rede, ou ERRO_DESCONHECIDO. */
export function codigoDe(erro) {
  if (erro instanceof ApiError) return erro.codigo;
  if (erro instanceof TypeError) return "SEM_CONEXAO";
  return "ERRO_DESCONHECIDO";
}

async function lerCorpo(res) {
  const texto = await res.text();
  if (!texto) return null;
  try { return JSON.parse(texto); } catch { return null; }
}

async function req(method, path, body) {
  const headers = { Accept: "application/json" };
  // Toda mutação (inclusive DELETE sem corpo) declara JSON: o backend recusa mutação sem ele.
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
  });
  const corpo = await lerCorpo(res);
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event(EVENTO_401));
    const { codigo, detalhe } = normalizarErro(res.status, corpo);
    throw new ApiError(res.status, codigo, `API ${method} ${path} → ${res.status}`, corpo, detalhe);
  }
  // 204 (login/logout) e corpo vazio viram null.
  return corpo;
}

// Os métodos novos (R2) codificam o id no caminho, e também os de UMA entrada: o id dela agora
// chega da URL (#/notas/:id, lib/useHashRoute.js), e um hash colado à mão com "/" ou "?" mudaria a
// rota chamada em vez de virar um 404. Os demais ficam como estavam (ids vêm da API, são uuid).
const seg = (v) => encodeURIComponent(v);
const comQuery = (caminho, params) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return `${caminho}${qs ? "?" + qs : ""}`;
};

export const api = {
  // Sessão
  login:  (senha) => req("POST", "/auth/login", { senha }),
  logout: ()      => req("POST", "/auth/logout"),
  me:     ()      => req("GET",  "/auth/me"),
  // Meetings (Agenda)
  getMeetings:      (params = {}) => req("GET", comQuery("/meetings", params)),
  createMeeting:    (data)        => req("POST",   "/meetings", data),
  updateMeeting:    (id, data)    => req("PATCH",  `/meetings/${id}`, data),
  deleteMeeting:    (id)          => req("DELETE", `/meetings/${id}`),
  restaurarMeeting: (id)          => req("POST",   `/meetings/${seg(id)}/restaurar`),
  // Projects
  getProjects:      ()                => req("GET",    "/projects"),
  createProject:    (data)            => req("POST",   "/projects", data),
  updateProject:    (id, data)        => req("PATCH",  `/projects/${id}`, data),
  deleteProject:    (id)              => req("DELETE", `/projects/${id}`),
  restaurarProject: (id)              => req("POST",   `/projects/${seg(id)}/restaurar`),
  createFrente:     (projectId, data) => req("POST",   `/projects/${projectId}/frentes`, data),
  updateFrente:     (id, data)        => req("PATCH",  `/frentes/${id}`, data),
  deleteFrente:     (id)              => req("DELETE", `/frentes/${id}`),
  restaurarFrente:  (id)              => req("POST",   `/frentes/${seg(id)}/restaurar`),
  createTask:       (frenteId, data)  => req("POST",   `/frentes/${frenteId}/tasks`, data),
  updateTask:       (id, data)        => req("PATCH",  `/tasks/${id}`, data),
  deleteTask:       (id)              => req("DELETE", `/tasks/${id}`),
  restaurarTask:    (id)              => req("POST",   `/tasks/${seg(id)}/restaurar`),
  // Entries
  getEntries:     (params = {}) => req("GET", comQuery("/entries", params)),
  getUpcoming:    (limit = 5)   => req("GET", `/entries/upcoming?limit=${limit}`),
  getStats:       ()            => req("GET", "/entries/stats"),
  getEntry:       (id)          => req("GET", `/entries/${seg(id)}`),
  createEntry:    (data)        => req("POST", "/entries", data),
  updateEntry:    (id, data)    => req("PATCH", `/entries/${seg(id)}`, data),
  deleteEntry:    (id)          => req("DELETE", `/entries/${seg(id)}`),
  restaurarEntry: (id)          => req("POST", `/entries/${seg(id)}/restaurar`),
  // Comentários (A1): uma linha por comentário. Com a migração falhada, as quatro respondem 503
  // COMENTARIOS_INDISPONIVEIS e quem chama cai no PATCH do array legado (lib/comentarios.js).
  getComentarios:      (alvoTipo, alvoId) =>
    req("GET", comQuery("/comentarios", { alvo_tipo: alvoTipo, alvo_id: alvoId })),
  createComentario:    ({ alvo_tipo, alvo_id, texto }) => req("POST", "/comentarios", { alvo_tipo, alvo_id, texto }),
  deleteComentario:    (id) => req("DELETE", `/comentarios/${seg(id)}`),
  restaurarComentario: (id) => req("POST", `/comentarios/${seg(id)}/restaurar`),
  // Histórico (A1): tipo ∈ ENTRADA | PROJETO | FRENTE | TAREFA | REUNIAO | COMENTARIO
  getHistorico: (tipo, id) => req("GET", `/historico/${seg(tipo)}/${seg(id)}`),
  // Ontologia e agente (A2)
  getOntologia:   ()     => req("GET", "/ontologia"),
  getResumoDoDia: (data) => req("GET", comQuery("/resumo-do-dia", { data })),
  desfazerAgente: (turnoId, idx) =>
    req("POST", "/agente/desfazer", idx === undefined ? { turno_id: turnoId } : { turno_id: turnoId, idx }),
  // O chat da Home (A2b) — contrato FIXO da §9.2 do plano; quem lê as respostas é home/chat.js.
  //   chatAgente  → 202 {turno_id} (o turno roda em segundo plano; consulte getTurno a cada 1 s), ou
  //                 200 <turno> já pronto quando o texto é o comando "desfazer" (sem modelo).
  //                 503 AGENTE_DESLIGADO: o servidor está sem o assistente (a tela salva como nota).
  //   getTurno    → <turno> = {turno_id, status, motivo, texto, acoes, progresso:{n_tools}, …}
  //   getConversa → {turnos: [<turno>…]}, do mais antigo ao mais novo
  // `contexto` leva só o id da tarefa vinculada: o corpo é estrito no backend (z.strictObject), e o
  // nome e o caminho da tarefa são da tela.
  chatAgente: (texto, contexto) =>
    req("POST", "/agente/chat", contexto?.tarefa_id ? { texto, contexto: { tarefa_id: contexto.tarefa_id } } : { texto }),
  getTurno:     (id) => req("GET", `/agente/turnos/${seg(id)}`),
  getConversa:  ({ canal = "web", limite = 30 } = {}) => req("GET", comQuery("/agente/conversa", { canal, limite })),
  novaConversa: (canal = "web") => req("POST", "/agente/nova-conversa", { canal }),
};
