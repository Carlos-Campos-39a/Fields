const BASE = (import.meta.env.VITE_API_URL ?? "") + "/api";

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
