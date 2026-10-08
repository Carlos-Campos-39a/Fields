// Linha do Postgres → objeto da API. Movidos literalmente do server.js monolítico: o formato do
// JSON de hoje é contrato com o front e com o MCP. Transformação pura, sem log.
//
// A1: os arrays de comentário (`threads` da entrada, `comments` da tarefa e da reunião) podem vir
// de fora da linha — montados da tabela `comentarios` quando a migração rodou. Sem o argumento,
// vale a coluna jsonb, como sempre (é o modo legado). As chaves e a ordem delas não mudam, e
// deleted_at nunca sai daqui.

export function toMeeting(r, comments) {
  return { id: r.id, title: r.title, date: r.date, startTime: r.start_time, endTime: r.end_time, description: r.description, comments: comments ?? r.comments ?? [], must: r.must ?? "", createdAt: r.created_at };
}
export function toProject(r) {
  return { id: r.id, name: r.name, status: r.status, holder: r.holder };
}
export function toFrente(r) {
  return { id: r.id, projectId: r.project_id, name: r.name };
}
export function toTask(r, comments) {
  return { id: r.id, frenteId: r.frente_id, name: r.name, acao: r.acao, status: r.status, stakeholder: r.stakeholder, deadline: r.deadline, holder: r.holder, comments: comments ?? r.comments ?? [], kanbanStatus: r.kanban_status ?? "A fazer", startDate: r.start_date ?? null };
}
export function toEntry(row, threads) {
  return {
    id:        row.id,
    type:      row.type,
    title:     row.title,
    content:   row.content,
    tags:      row.tags      ?? [],
    date:      row.date,
    time:      row.time,
    pinned:    row.pinned,
    threads:   threads ?? row.threads ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── A2 · o formato que o AGENTE lê ───
// Não é contrato de rota: é o que as ferramentas devolvem ao modelo (e ao MCP). Chaves em português,
// e o id SEMPRE ao lado do nome — o modelo encadeia leitura → escrita pelo id, e o prompt proíbe
// mostrá-lo; sem o id aqui, ele teria de perguntar ao Carlos, que é o que o prompt também proíbe.

const vazioViraNull = (v) => (v === "" || v === undefined ? null : v);

/** Linha de tarefa (com frente_nome, projeto_id e projeto_nome do JOIN) → tarefa do agente. */
export function tarefaDoAgente(r) {
  return {
    tarefa_id: r.id, nome: r.name, acao: vazioViraNull(r.acao),
    status: r.status, coluna: r.kanban_status,
    prazo: vazioViraNull(r.deadline), inicio: vazioViraNull(r.start_date),
    holder: r.holder, stakeholder: vazioViraNull(r.stakeholder),
    frente_id: r.frente_id, frente: r.frente_nome ?? null,
    projeto_id: r.projeto_id ?? null, projeto: r.projeto_nome ?? null,
  };
}

/** Linha de entries → entrada do agente. O conteúdo vai como trecho: a lista é para escolher. */
export function entradaDoAgente(r) {
  const conteudo = r.content ?? "";
  return {
    entrada_id: r.id, tipo: r.type, titulo: r.title,
    data: vazioViraNull(r.date), hora: vazioViraNull(r.time),
    tags: r.tags ?? [], fixada: Boolean(r.pinned),
    trecho: conteudo.length > 200 ? `${conteudo.slice(0, 200)}…` : conteudo,
  };
}

/** Reunião no formato da API (toMeeting) → reunião do agente. */
export function reuniaoDoAgente(m) {
  return {
    reuniao_id: m.id, titulo: m.title, data: m.date,
    inicio: vazioViraNull(m.startTime), fim: vazioViraNull(m.endTime),
    pauta: vazioViraNull(m.description), must: vazioViraNull(m.must),
  };
}

/** Array legado de comentários ({text, createdAt|created_at}) → [{texto, criado_em}]. */
export function comentariosDoAgente(lista) {
  return (Array.isArray(lista) ? lista : []).map((c) => ({
    texto: c?.text ?? "", criado_em: c?.createdAt ?? c?.created_at ?? null,
  }));
}
