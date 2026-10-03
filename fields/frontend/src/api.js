const BASE = "/api";

// Evento global de sessão expirada/ausente. O <Gate> escuta e volta para o login.
export const EVENTO_401 = "fields:401";

// Erro de API com o status HTTP e o código estável devolvido pelo backend
// (corpo {error, codigo}). Estende Error, então os catch existentes continuam valendo.
export class ApiError extends Error {
  constructor(status, codigo, mensagem, corpo) {
    super(mensagem);
    this.name = "ApiError";
    this.status = status;
    this.codigo = codigo;
    this.corpo = corpo;
  }
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
    const codigo = corpo?.codigo ?? corpo?.error ?? corpo?.erro ?? null;
    throw new ApiError(res.status, codigo, `API ${method} ${path} → ${res.status}`, corpo);
  }
  // 204 (login/logout) e corpo vazio viram null.
  return corpo;
}

export const api = {
  // Sessão
  login:  (senha) => req("POST", "/auth/login", { senha }),
  logout: ()      => req("POST", "/auth/logout"),
  me:     ()      => req("GET",  "/auth/me"),
  // Meetings (Agenda)
  getMeetings:   (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return req("GET", `/meetings${qs ? "?" + qs : ""}`);
  },
  createMeeting: (data)        => req("POST",   "/meetings", data),
  updateMeeting: (id, data)    => req("PATCH",  `/meetings/${id}`, data),
  deleteMeeting: (id)          => req("DELETE", `/meetings/${id}`),
  // Projects
  getProjects:   ()                => req("GET",    "/projects"),
  createProject: (data)            => req("POST",   "/projects", data),
  updateProject: (id, data)        => req("PATCH",  `/projects/${id}`, data),
  deleteProject: (id)              => req("DELETE", `/projects/${id}`),
  createFrente:  (projectId, data) => req("POST",   `/projects/${projectId}/frentes`, data),
  updateFrente:  (id, data)        => req("PATCH",  `/frentes/${id}`, data),
  deleteFrente:  (id)              => req("DELETE", `/frentes/${id}`),
  createTask:    (frenteId, data)  => req("POST",   `/frentes/${frenteId}/tasks`, data),
  updateTask:    (id, data)        => req("PATCH",  `/tasks/${id}`, data),
  deleteTask:    (id)              => req("DELETE", `/tasks/${id}`),
  // Entries
  getEntries:  (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return req("GET", `/entries${qs ? "?" + qs : ""}`);
  },
  getUpcoming: (limit = 5) => req("GET", `/entries/upcoming?limit=${limit}`),
  getStats:    ()           => req("GET", "/entries/stats"),
  getEntry:    (id)         => req("GET", `/entries/${id}`),
  createEntry: (data)       => req("POST", "/entries", data),
  updateEntry: (id, data)   => req("PATCH", `/entries/${id}`, data),
  deleteEntry: (id)         => req("DELETE", `/entries/${id}`),
};
