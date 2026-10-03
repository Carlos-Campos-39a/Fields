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
