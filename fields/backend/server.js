import express from "express";
import cors from "cors";
import pg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pg;
const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
};
app.options("*", cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());

// ─── PostgreSQL ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id          TEXT PRIMARY KEY,
      type        TEXT        NOT NULL DEFAULT 'note',
      title       TEXT        NOT NULL,
      content     TEXT        NOT NULL,
      tags        JSONB       NOT NULL DEFAULT '[]',
      date        TEXT,
      time        TEXT,
      pinned      BOOLEAN     NOT NULL DEFAULT false,
      threads     JSONB       NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT        NOT NULL,
      status      TEXT        NOT NULL DEFAULT 'Em andamento',
      holder      TEXT        NOT NULL DEFAULT 'Nós',
      sort_order  INTEGER     NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS frentes (
      id          TEXT PRIMARY KEY,
      project_id  TEXT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name        TEXT        NOT NULL,
      sort_order  INTEGER     NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      frente_id   TEXT        NOT NULL REFERENCES frentes(id) ON DELETE CASCADE,
      name        TEXT        NOT NULL,
      acao        TEXT        NOT NULL DEFAULT '',
      status      TEXT        NOT NULL DEFAULT 'Pendente',
      stakeholder TEXT        NOT NULL DEFAULT '',
      deadline    TEXT,
      holder      TEXT        NOT NULL DEFAULT '',
      sort_order  INTEGER     NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id          TEXT PRIMARY KEY,
      title       TEXT        NOT NULL,
      date        TEXT        NOT NULL,
      start_time  TEXT        NOT NULL DEFAULT '',
      end_time    TEXT        NOT NULL DEFAULT '',
      description TEXT        NOT NULL DEFAULT '',
      comments    JSONB       NOT NULL DEFAULT '[]',
      must        TEXT        NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS must TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comments JSONB NOT NULL DEFAULT '[]';
  `);

  // Seed if empty
  const { rows } = await pool.query("SELECT COUNT(*) FROM entries");
  if (parseInt(rows[0].count) === 0) {
    const today    = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

    const seed = [
      { type: "note",     title: "Arquitetura de Agentes LLM",           content: "LangGraph permite orquestrar múltiplos agentes com estado compartilhado. Investigar como o MetaHarness pode otimizar automaticamente os prompts de cada nó do grafo.", tags: ["TCC","LangChain","IA"],          date: today,    time: null,    pinned: true  },
      { type: "event",    title: "Apresentação McKinsey — Cobrança",      content: "Revisar deck antes da reunião. Levar análise de roll-rate e resultados do A/B de SMS.",                                                                                   tags: ["Trabalho","McKinsey"],           date: tomorrow, time: "14:00", pinned: false },
      { type: "reminder", title: "Configurar ANTHROPIC_API_KEY",          content: "Adicionar a nova chave no servidor de produção via variável de ambiente. Testar endpoint /v1/messages após deploy.",                                                        tags: ["Dev","Infra"],                   date: tomorrow, time: "09:00", pinned: false },
      { type: "note",     title: "Geometria da Verdade — Marks & Tegmark", content: "Representações lineares de veracidade no espaço de ativações. Aplicar ao estudo de estabilidade de intenção em agentes classificadores.",                                  tags: ["Pesquisa","Interpretabilidade"], date: today,    time: null,    pinned: false },
      { type: "event",    title: "Defesa do TCC",                         content: "Preparar slides finais com resultados comparativos SAS vs MAS. Confirmar banca e sala com orientador.",                                                                     tags: ["TCC","Acadêmico"],               date: nextWeek, time: "10:00", pinned: true  },
    ];

    for (const e of seed) {
      await pool.query(
        `INSERT INTO entries (id, type, title, content, tags, date, time, pinned, threads)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]')`,
        [uuidv4(), e.type, e.title, e.content, JSON.stringify(e.tags), e.date, e.time, e.pinned]
      );
    }
    console.log("DB seeded.");
  }
  console.log("✦ PostgreSQL connected.");
}

// ─── Helpers: row → object ───────────────────────────────────
function toMeeting(r) {
  return { id: r.id, title: r.title, date: r.date, startTime: r.start_time, endTime: r.end_time, description: r.description, comments: r.comments ?? [], must: r.must ?? "", createdAt: r.created_at };
}
function toProject(r) {
  return { id: r.id, name: r.name, status: r.status, holder: r.holder };
}
function toFrente(r) {
  return { id: r.id, projectId: r.project_id, name: r.name };
}
function toTask(r) {
  return { id: r.id, frenteId: r.frente_id, name: r.name, acao: r.acao, status: r.status, stakeholder: r.stakeholder, deadline: r.deadline, holder: r.holder, comments: r.comments ?? [] };
}
function toEntry(row) {
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

// ─── Routes ──────────────────────────────────────────────────

// GET /api/entries
app.get("/api/entries", async (req, res) => {
  try {
    const { type, search } = req.query;
    let q    = "SELECT * FROM entries WHERE 1=1";
    const params = [];

    if (type && type !== "all") {
      if (type === "pinned") {
        q += " AND pinned = true";
      } else {
        params.push(type);
        q += ` AND type = $${params.length}`;
      }
    }

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const n = params.length;
      q += ` AND (LOWER(title) LIKE $${n} OR LOWER(content) LIKE $${n} OR LOWER(tags::text) LIKE $${n})`;
    }

    q += " ORDER BY pinned DESC, created_at DESC";

    const { rows } = await pool.query(q, params);
    const entries = rows.map(toEntry);
    res.json({ entries, total: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/entries/upcoming
app.get("/api/entries/upcoming", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const limit = parseInt(req.query.limit) || 5;
    const { rows } = await pool.query(
      `SELECT * FROM entries
       WHERE type IN ('event','reminder') AND date >= $1
       ORDER BY date ASC, COALESCE(time,'00:00') ASC
       LIMIT $2`,
      [today, limit]
    );
    res.json({ entries: rows.map(toEntry) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/entries/stats
app.get("/api/entries/stats", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT type, pinned FROM entries");
    const stats = { note: 0, event: 0, reminder: 0, lang_fr: 0, lang_jp: 0, pinned: 0, total: rows.length };
    rows.forEach(r => { if (stats[r.type] !== undefined) stats[r.type]++; if (r.pinned) stats.pinned++; });
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/entries/:id
app.get("/api/entries/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM entries WHERE id = $1", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    const entry = toEntry(rows[0]);

    // Related by tags
    const { rows: rel } = await pool.query(
      `SELECT * FROM entries WHERE id != $1 AND tags ?| $2::text[] LIMIT 4`,
      [entry.id, entry.tags]
    );
    res.json({ entry, related: rel.map(toEntry) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/entries
app.post("/api/entries", async (req, res) => {
  try {
    const { type, title, content, tags, date, time, pinned } = req.body;
    if (!title || !content) return res.status(400).json({ error: "title and content are required" });

    const id = uuidv4();
    await pool.query(
      `INSERT INTO entries (id, type, title, content, tags, date, time, pinned, threads)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]')`,
      [id, type || "note", title.trim(), content.trim(),
       JSON.stringify(Array.isArray(tags) ? tags : []),
       date || new Date().toISOString().split("T")[0],
       time || null, pinned || false]
    );
    const { rows } = await pool.query("SELECT * FROM entries WHERE id = $1", [id]);
    res.status(201).json({ entry: toEntry(rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/entries/:id
app.patch("/api/entries/:id", async (req, res) => {
  try {
    const allowed = ["type", "title", "content", "tags", "date", "time", "pinned", "threads"];
    const sets = ["updated_at = NOW()"];
    const params = [];

    const colMap = { createdAt: "created_at", updatedAt: "updated_at" };
    const pgCol  = f => colMap[f] || f;

    allowed.forEach(f => {
      if (req.body[f] !== undefined) {
        params.push(["tags","threads"].includes(f) ? JSON.stringify(req.body[f]) : req.body[f]);
        sets.push(`${pgCol(f)} = $${params.length}`);
      }
    });

    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE entries SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ entry: toEntry(rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/entries/:id
app.delete("/api/entries/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM entries WHERE id = $1", [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Projects ────────────────────────────────────────────────

// GET /api/projects
app.get("/api/projects", async (req, res) => {
  try {
    const { rows: ps } = await pool.query("SELECT * FROM projects ORDER BY sort_order, created_at");
    const { rows: fs } = await pool.query("SELECT * FROM frentes ORDER BY sort_order, created_at");
    const { rows: ts } = await pool.query("SELECT * FROM tasks ORDER BY sort_order, created_at");

    const fMap = {};
    fs.forEach(f => { fMap[f.id] = { ...toFrente(f), tasks: [] }; });
    ts.forEach(t => { if (fMap[t.frente_id]) fMap[t.frente_id].tasks.push(toTask(t)); });

    const projects = ps.map(p => ({
      ...toProject(p),
      frentes: fs.filter(f => f.project_id === p.id).map(f => fMap[f.id] || { ...toFrente(f), tasks: [] }),
    }));
    res.json({ projects });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/projects
app.post("/api/projects", async (req, res) => {
  try {
    const { name, status = "Em andamento", holder = "Nós" } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = uuidv4();
    const { rows: cnt } = await pool.query("SELECT COUNT(*) FROM projects");
    await pool.query(
      "INSERT INTO projects (id, name, status, holder, sort_order) VALUES ($1,$2,$3,$4,$5)",
      [id, name, status, holder, parseInt(cnt[0].count) || 0]
    );
    const { rows } = await pool.query("SELECT * FROM projects WHERE id=$1", [id]);
    res.status(201).json({ project: { ...toProject(rows[0]), frentes: [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/projects/:id
app.patch("/api/projects/:id", async (req, res) => {
  try {
    const allowed = ["name", "status", "holder", "sort_order"];
    const sets = []; const params = [];
    allowed.forEach(f => { if (req.body[f] !== undefined) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); } });
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    params.push(req.params.id);
    await pool.query(`UPDATE projects SET ${sets.join(",")} WHERE id=$${params.length}`, params);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/projects/:id
app.delete("/api/projects/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM projects WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/projects/:projectId/frentes
app.post("/api/projects/:projectId/frentes", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = uuidv4();
    const { rows: cnt } = await pool.query("SELECT COUNT(*) FROM frentes WHERE project_id=$1", [req.params.projectId]);
    await pool.query(
      "INSERT INTO frentes (id, project_id, name, sort_order) VALUES ($1,$2,$3,$4)",
      [id, req.params.projectId, name, parseInt(cnt[0].count) || 0]
    );
    const { rows } = await pool.query("SELECT * FROM frentes WHERE id=$1", [id]);
    res.status(201).json({ frente: { ...toFrente(rows[0]), tasks: [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/frentes/:id
app.patch("/api/frentes/:id", async (req, res) => {
  try {
    const allowed = ["name", "sort_order"];
    const sets = []; const params = [];
    allowed.forEach(f => { if (req.body[f] !== undefined) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); } });
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    params.push(req.params.id);
    await pool.query(`UPDATE frentes SET ${sets.join(",")} WHERE id=$${params.length}`, params);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/frentes/:id
app.delete("/api/frentes/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM frentes WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/frentes/:frenteId/tasks
app.post("/api/frentes/:frenteId/tasks", async (req, res) => {
  try {
    const { name, acao = "", status = "Pendente", stakeholder = "", deadline = null, holder = "" } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = uuidv4();
    const { rows: cnt } = await pool.query("SELECT COUNT(*) FROM tasks WHERE frente_id=$1", [req.params.frenteId]);
    await pool.query(
      "INSERT INTO tasks (id, frente_id, name, acao, status, stakeholder, deadline, holder, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, req.params.frenteId, name, acao, status, stakeholder, deadline, holder, parseInt(cnt[0].count) || 0]
    );
    const { rows } = await pool.query("SELECT * FROM tasks WHERE id=$1", [id]);
    res.status(201).json({ task: toTask(rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/tasks/:id
app.patch("/api/tasks/:id", async (req, res) => {
  try {
    const allowed = ["name", "acao", "status", "stakeholder", "deadline", "holder", "sort_order", "comments"];
    const sets = []; const params = [];
    allowed.forEach(f => { if (req.body[f] !== undefined) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); } });
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    params.push(req.params.id);
    await pool.query(`UPDATE tasks SET ${sets.join(",")} WHERE id=$${params.length}`, params);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/tasks/:id
app.delete("/api/tasks/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM tasks WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Meetings (Agenda) ───────────────────────────────────────

// GET /api/meetings?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get("/api/meetings", async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = "SELECT * FROM meetings";
    const params = [];
    if (from && to) {
      q += " WHERE date >= $1 AND date <= $2";
      params.push(from, to);
    } else if (from) {
      q += " WHERE date >= $1";
      params.push(from);
    }
    q += " ORDER BY date, start_time, created_at";
    const { rows } = await pool.query(q, params);
    res.json({ meetings: rows.map(toMeeting) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/meetings
app.post("/api/meetings", async (req, res) => {
  try {
    const { title, date, start_time = "", end_time = "", description = "" } = req.body;
    if (!title || !date) return res.status(400).json({ error: "title and date required" });
    const id = uuidv4();
    await pool.query(
      "INSERT INTO meetings (id, title, date, start_time, end_time, description, comments) VALUES ($1,$2,$3,$4,$5,$6,'[]')",
      [id, title, date, start_time, end_time, description]
    );
    const { rows } = await pool.query("SELECT * FROM meetings WHERE id=$1", [id]);
    res.status(201).json({ meeting: toMeeting(rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/meetings/:id
app.patch("/api/meetings/:id", async (req, res) => {
  try {
    const allowed = ["title", "date", "start_time", "end_time", "description", "comments", "must"];
    const sets = []; const params = [];
    allowed.forEach(f => {
      if (req.body[f] !== undefined) {
        params.push(f === "comments" ? JSON.stringify(req.body[f]) : req.body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    });
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE meetings SET ${sets.join(",")} WHERE id=$${params.length} RETURNING *`, params
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ meeting: toMeeting(rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/meetings/:id
app.delete("/api/meetings/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM meetings WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/health
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", db: "postgres", time: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`\n  ✦ Fields' API  →  http://0.0.0.0:${PORT}/api/health\n`);
    });
  })
  .catch(err => {
    console.error("Failed to connect to PostgreSQL:", err.message);
    process.exit(1);
  });
