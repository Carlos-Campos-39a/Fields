#!/usr/bin/env node
/**
 * Fields' MCP Server
 * Permite agentes de IA operar a plataforma Fields' via Model Context Protocol.
 * Transporte: stdio (compatível com Claude Desktop, Claude Code, e qualquer cliente MCP)
 *
 * Configuração em claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "fields": {
 *       "command": "node",
 *       "args": ["/caminho/para/fields-project/fields/mcp/server.js"],
 *       "env": { "FIELDS_API_URL": "https://SEU-APP.railway.app/api" }
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Config ──────────────────────────────────────────────────
const BASE = process.env.FIELDS_API_URL;
if (!BASE) {
  console.error("❌  FIELDS_API_URL não definida. Exemplo: https://meu-app.railway.app/api");
  process.exit(1);
}

// ─── HTTP helper ─────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ─── MCP Server ───────────────────────────────────────────────
const server = new McpServer({
  name: "fields",
  version: "1.0.0",
});

// ════════════════════════════════════════════════════════════════
// RESOURCES — leitura de contexto geral
// ════════════════════════════════════════════════════════════════

server.resource(
  "overview",
  "fields://overview",
  { mimeType: "application/json", description: "Resumo geral da plataforma: projetos, tasks pendentes e próximas reuniões" },
  async () => {
    const [{ projects }, { entries }, { entries: upcoming }] = await Promise.all([
      api("GET", "/projects"),
      api("GET", "/entries?type=all"),
      api("GET", "/entries/upcoming?limit=5"),
    ]);

    const totalTasks   = projects.flatMap(p => p.frentes.flatMap(f => f.tasks)).length;
    const pendingTasks = projects.flatMap(p => p.frentes.flatMap(f => f.tasks)).filter(t => t.status !== "Concluído").length;

    const overview = {
      projects: projects.map(p => ({
        id: p.id, name: p.name, status: p.status,
        frentes: p.frentes.map(f => ({ id: f.id, name: f.name, taskCount: f.tasks.length })),
      })),
      tasks: { total: totalTasks, pending: pendingTasks },
      recentEntries: entries.slice(0, 5).map(e => ({ id: e.id, type: e.type, title: e.title, date: e.date })),
      upcomingEvents: upcoming.map(e => ({ id: e.id, type: e.type, title: e.title, date: e.date, time: e.time })),
    };

    return { contents: [{ uri: "fields://overview", mimeType: "application/json", text: JSON.stringify(overview, null, 2) }] };
  }
);

// ════════════════════════════════════════════════════════════════
// ENTRIES — notas, eventos, lembretes
// ════════════════════════════════════════════════════════════════

server.tool(
  "list_entries",
  "Lista entradas do Fields' (notas, eventos, lembretes). Suporta filtro por tipo e busca por texto.",
  {
    type:   z.enum(["all", "note", "event", "reminder", "pinned"]).optional().describe("Filtro de tipo"),
    search: z.string().optional().describe("Busca por texto no título ou conteúdo"),
    limit:  z.number().int().min(1).max(100).optional().describe("Máximo de resultados (padrão: 20)"),
  },
  async ({ type, search, limit = 20 }) => {
    const qs = new URLSearchParams();
    if (type && type !== "all") qs.set("type", type);
    if (search) qs.set("search", search);
    const { entries } = await api("GET", `/entries${qs.toString() ? "?" + qs : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(entries.slice(0, limit), null, 2) }] };
  }
);

server.tool(
  "get_entry",
  "Retorna uma entrada específica pelo ID, incluindo threads/anotações.",
  { id: z.string().describe("ID da entrada") },
  async ({ id }) => {
    const { entry } = await api("GET", `/entries/${id}`);
    return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
  }
);

server.tool(
  "create_entry",
  "Cria uma nova entrada no Fields' (nota, evento ou lembrete).",
  {
    type:    z.enum(["note", "event", "reminder"]).describe("Tipo da entrada"),
    title:   z.string().min(1).describe("Título"),
    content: z.string().describe("Conteúdo / descrição"),
    date:    z.string().optional().describe("Data no formato YYYY-MM-DD (padrão: hoje)"),
    time:    z.string().optional().describe("Hora no formato HH:MM (para eventos e lembretes)"),
    tags:    z.array(z.string()).optional().describe("Lista de tags"),
    pinned:  z.boolean().optional().describe("Fixar entrada"),
  },
  async ({ type, title, content, date, time, tags, pinned }) => {
    const { entry } = await api("POST", "/entries", {
      type, title, content,
      date:   date || new Date().toISOString().split("T")[0],
      time:   time || null,
      tags:   tags || [],
      pinned: pinned || false,
    });
    return { content: [{ type: "text", text: `✓ Entrada criada: ${entry.id}\n\n${JSON.stringify(entry, null, 2)}` }] };
  }
);

server.tool(
  "update_entry",
  "Atualiza campos de uma entrada existente.",
  {
    id:      z.string().describe("ID da entrada"),
    title:   z.string().optional(),
    content: z.string().optional(),
    date:    z.string().optional().describe("YYYY-MM-DD"),
    time:    z.string().optional().describe("HH:MM"),
    tags:    z.array(z.string()).optional(),
    pinned:  z.boolean().optional(),
  },
  async ({ id, ...patch }) => {
    await api("PATCH", `/entries/${id}`, patch);
    return { content: [{ type: "text", text: `✓ Entrada ${id} atualizada.` }] };
  }
);

server.tool(
  "delete_entry",
  "Remove permanentemente uma entrada.",
  { id: z.string().describe("ID da entrada") },
  async ({ id }) => {
    await api("DELETE", `/entries/${id}`);
    return { content: [{ type: "text", text: `✓ Entrada ${id} removida.` }] };
  }
);

server.tool(
  "add_thread",
  "Adiciona uma anotação/comentário ao thread de uma entrada.",
  {
    entry_id: z.string().describe("ID da entrada"),
    text:     z.string().min(1).describe("Texto da anotação"),
  },
  async ({ entry_id, text }) => {
    const { entry } = await api("GET", `/entries/${entry_id}`);
    const threads = entry.threads || [];
    const note = { id: Date.now().toString(), text, createdAt: new Date().toISOString() };
    await api("PATCH", `/entries/${entry_id}`, { threads: [...threads, note] });
    return { content: [{ type: "text", text: `✓ Anotação adicionada à entrada ${entry_id}.` }] };
  }
);

// ════════════════════════════════════════════════════════════════
// PROJECTS — projetos, frentes, tasks
// ════════════════════════════════════════════════════════════════

server.tool(
  "list_projects",
  "Lista todos os projetos com frentes e tasks. Inclui status, holder e kanban_status de cada task.",
  {},
  async () => {
    const { projects } = await api("GET", "/projects");
    return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
  }
);

server.tool(
  "create_project",
  "Cria um novo projeto.",
  {
    name:   z.string().min(1).describe("Nome do projeto"),
    status: z.enum(["Em andamento", "Pendente", "Marcado", "Em definição", "Não iniciado", "Concluído"]).optional(),
    holder: z.enum(["Nós", "Eles"]).optional(),
  },
  async ({ name, status = "Em andamento", holder = "Nós" }) => {
    const { project } = await api("POST", "/projects", { name, status, holder });
    return { content: [{ type: "text", text: `✓ Projeto criado: ${project.id}\n\n${JSON.stringify(project, null, 2)}` }] };
  }
);

server.tool(
  "create_frente",
  "Cria uma frente de trabalho dentro de um projeto.",
  {
    project_id: z.string().describe("ID do projeto pai"),
    name:       z.string().min(1).describe("Nome da frente"),
  },
  async ({ project_id, name }) => {
    const { frente } = await api("POST", `/projects/${project_id}/frentes`, { name });
    return { content: [{ type: "text", text: `✓ Frente criada: ${frente.id}\n\n${JSON.stringify(frente, null, 2)}` }] };
  }
);

server.tool(
  "create_task",
  "Cria uma task dentro de uma frente.",
  {
    frente_id:   z.string().describe("ID da frente"),
    name:        z.string().min(1).describe("Nome da task"),
    acao:        z.string().optional().describe("Ação específica"),
    status:      z.enum(["Em andamento", "Pendente", "Marcado", "Em definição", "Não iniciado", "Concluído"]).optional(),
    stakeholder: z.string().optional(),
    deadline:    z.string().optional().describe("Data limite YYYY-MM-DD"),
    holder:      z.enum(["Nós", "Eles", ""]).optional(),
  },
  async ({ frente_id, name, acao = "", status = "Pendente", stakeholder = "", deadline, holder = "" }) => {
    const { task } = await api("POST", `/frentes/${frente_id}/tasks`, { name, acao, status, stakeholder, deadline, holder });
    return { content: [{ type: "text", text: `✓ Task criada: ${task.id}\n\n${JSON.stringify(task, null, 2)}` }] };
  }
);

server.tool(
  "update_task",
  "Atualiza campos de uma task: status, kanban_status, datas, stakeholder, comentários, etc.",
  {
    task_id:      z.string().describe("ID da task"),
    name:         z.string().optional(),
    acao:         z.string().optional(),
    status:       z.enum(["Em andamento", "Pendente", "Marcado", "Em definição", "Não iniciado", "Concluído"]).optional(),
    kanban_status: z.enum(["A fazer", "Fazendo", "Espera", "Feito"]).optional().describe("Coluna no Kanban"),
    stakeholder:  z.string().optional(),
    deadline:     z.string().optional().describe("YYYY-MM-DD"),
    start_date:   z.string().optional().describe("YYYY-MM-DD"),
    holder:       z.string().optional(),
  },
  async ({ task_id, ...patch }) => {
    // Remove undefined fields
    const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await api("PATCH", `/tasks/${task_id}`, body);
    return { content: [{ type: "text", text: `✓ Task ${task_id} atualizada com: ${JSON.stringify(body)}` }] };
  }
);

server.tool(
  "add_task_comment",
  "Adiciona um comentário a uma task específica. O comentário aparece no balão da task na aba Projetos.",
  {
    task_id: z.string().describe("ID da task"),
    text:    z.string().min(1).describe("Texto do comentário"),
  },
  async ({ task_id, text }) => {
    // Fetch current task to get existing comments
    const { projects } = await api("GET", "/projects");
    let currentComments = [];
    for (const proj of projects) {
      for (const frente of proj.frentes) {
        const task = frente.tasks.find(t => t.id === task_id);
        if (task) { currentComments = task.comments || []; break; }
      }
    }
    const newComment = { id: crypto.randomUUID(), text, created_at: new Date().toISOString() };
    await api("PATCH", `/tasks/${task_id}`, { comments: [...currentComments, newComment] });
    return { content: [{ type: "text", text: `✓ Comentário adicionado à task ${task_id}.` }] };
  }
);

server.tool(
  "delete_task",
  "Remove uma task.",
  { task_id: z.string().describe("ID da task") },
  async ({ task_id }) => {
    await api("DELETE", `/tasks/${task_id}`);
    return { content: [{ type: "text", text: `✓ Task ${task_id} removida.` }] };
  }
);

// ════════════════════════════════════════════════════════════════
// MEETINGS — agenda semanal
// ════════════════════════════════════════════════════════════════

server.tool(
  "list_meetings",
  "Lista reuniões da agenda. Filtra por data se especificado.",
  {
    date_from: z.string().optional().describe("Data inicial YYYY-MM-DD"),
    date_to:   z.string().optional().describe("Data final YYYY-MM-DD"),
  },
  async ({ date_from, date_to }) => {
    const qs = new URLSearchParams();
    if (date_from) qs.set("from", date_from);
    if (date_to)   qs.set("to", date_to);
    const { meetings } = await api("GET", `/meetings${qs.toString() ? "?" + qs : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(meetings, null, 2) }] };
  }
);

server.tool(
  "create_meeting",
  "Cria uma reunião na agenda semanal.",
  {
    title:       z.string().min(1).describe("Título da reunião"),
    date:        z.string().describe("Data YYYY-MM-DD"),
    start_time:  z.string().optional().describe("Hora de início HH:MM"),
    end_time:    z.string().optional().describe("Hora de fim HH:MM"),
    description: z.string().optional().describe("Descrição / pauta"),
    must:        z.string().optional().describe("Campo 'Must do' — pontos críticos da reunião"),
  },
  async ({ title, date, start_time = "", end_time = "", description = "", must = "" }) => {
    const { meeting } = await api("POST", "/meetings", { title, date, start_time, end_time, description, must });
    return { content: [{ type: "text", text: `✓ Reunião criada: ${meeting.id}\n\n${JSON.stringify(meeting, null, 2)}` }] };
  }
);

server.tool(
  "add_meeting_comment",
  "Adiciona um comentário a uma reunião existente.",
  {
    meeting_id: z.string().describe("ID da reunião"),
    text:       z.string().min(1).describe("Texto do comentário"),
  },
  async ({ meeting_id, text }) => {
    const { meetings } = await api("GET", "/meetings");
    const meeting = meetings.find(m => m.id === meeting_id);
    if (!meeting) throw new Error(`Reunião ${meeting_id} não encontrada`);
    const newComment = { id: crypto.randomUUID(), text, created_at: new Date().toISOString() };
    await api("PATCH", `/meetings/${meeting_id}`, { comments: [...(meeting.comments || []), newComment] });
    return { content: [{ type: "text", text: `✓ Comentário adicionado à reunião ${meeting_id}.` }] };
  }
);

server.tool(
  "update_meeting",
  "Atualiza campos de uma reunião (título, horário, must, etc.).",
  {
    meeting_id:  z.string().describe("ID da reunião"),
    title:       z.string().optional(),
    date:        z.string().optional().describe("YYYY-MM-DD"),
    start_time:  z.string().optional().describe("HH:MM"),
    end_time:    z.string().optional().describe("HH:MM"),
    description: z.string().optional(),
    must:        z.string().optional(),
  },
  async ({ meeting_id, ...patch }) => {
    const body = Object.fromEntries(
      Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k === "start_time" ? "start_time" : k, v])
    );
    await api("PATCH", `/meetings/${meeting_id}`, body);
    return { content: [{ type: "text", text: `✓ Reunião ${meeting_id} atualizada.` }] };
  }
);

// ════════════════════════════════════════════════════════════════
// KANBAN helpers
// ════════════════════════════════════════════════════════════════

server.tool(
  "move_task_kanban",
  "Move uma task para uma coluna do Kanban (A fazer, Fazendo, Espera, Feito).",
  {
    task_id: z.string().describe("ID da task"),
    column:  z.enum(["A fazer", "Fazendo", "Espera", "Feito"]).describe("Coluna de destino"),
  },
  async ({ task_id, column }) => {
    await api("PATCH", `/tasks/${task_id}`, { kanban_status: column });
    return { content: [{ type: "text", text: `✓ Task ${task_id} movida para "${column}".` }] };
  }
);

server.tool(
  "get_kanban_board",
  "Retorna o quadro Kanban de um projeto, agrupando tasks por coluna.",
  {
    project_id: z.string().describe("ID do projeto"),
    frente_id:  z.string().optional().describe("Filtrar por frente (opcional)"),
  },
  async ({ project_id, frente_id }) => {
    const { projects } = await api("GET", "/projects");
    const proj = projects.find(p => p.id === project_id);
    if (!proj) throw new Error(`Projeto ${project_id} não encontrado`);

    const frentes = frente_id ? proj.frentes.filter(f => f.id === frente_id) : proj.frentes;
    const allTasks = frentes.flatMap(f => f.tasks.map(t => ({ ...t, frenteName: f.name })));

    const board = { "A fazer": [], "Fazendo": [], "Espera": [], "Feito": [] };
    for (const t of allTasks) board[t.kanbanStatus || "A fazer"].push(t);

    return { content: [{ type: "text", text: JSON.stringify({ project: proj.name, board }, null, 2) }] };
  }
);

// ─── Start ───────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
