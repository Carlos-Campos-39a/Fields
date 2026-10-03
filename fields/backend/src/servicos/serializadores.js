// Linha do Postgres → objeto da API. Movidos literalmente do server.js monolítico: o formato do
// JSON de hoje é contrato com o front e com o MCP. Transformação pura, sem log.

export function toMeeting(r) {
  return { id: r.id, title: r.title, date: r.date, startTime: r.start_time, endTime: r.end_time, description: r.description, comments: r.comments ?? [], must: r.must ?? "", createdAt: r.created_at };
}
export function toProject(r) {
  return { id: r.id, name: r.name, status: r.status, holder: r.holder };
}
export function toFrente(r) {
  return { id: r.id, projectId: r.project_id, name: r.name };
}
export function toTask(r) {
  return { id: r.id, frenteId: r.frente_id, name: r.name, acao: r.acao, status: r.status, stakeholder: r.stakeholder, deadline: r.deadline, holder: r.holder, comments: r.comments ?? [], kanbanStatus: r.kanban_status ?? "A fazer", startDate: r.start_date ?? null };
}
export function toEntry(row) {
  return {
    id:        row.id,
    type:      row.type,
    title:     row.title,
    content:   row.content,
    tags:      row.tags      ?? [],
    date:      row.date,
    time:      row.time,
    pinned:    row.pinned,
    threads:   row.threads   ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
