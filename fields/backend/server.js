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

// ─── Helper: row → entry object ──────────────────────────────
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
