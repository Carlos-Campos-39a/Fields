const BASE = "/api";

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${method} ${path} → ${res.status}`);
  return res.json();
}

export const api = {
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
