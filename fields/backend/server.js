import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "db.json");

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
}));
app.use(express.json());

// ─── DB helpers (flat JSON file) ─────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const seed = { entries: getSeedData() };
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getSeedData() {
  const today = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

  return [
    {
      id: uuidv4(),
      type: "note",
      title: "Arquitetura de Agentes LLM",
      content:
        "LangGraph permite orquestrar múltiplos agentes com estado compartilhado. Investigar como o MetaHarness pode otimizar automaticamente os prompts de cada nó do grafo.",
      tags: ["TCC", "LangChain", "IA"],
      date: today,
      time: null,
      pinned: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: uuidv4(),
      type: "event",
      title: "Apresentação McKinsey — Análise de Cobrança",
      content:
        "Revisar deck do cliente antes da reunião. Levar análise de roll-rate atualizada e resultados do A/B de SMS.",
      tags: ["Trabalho", "McKinsey"],
      date: tomorrow,
      time: "14:00",
      pinned: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: uuidv4(),
      type: "reminder",
      title: "Configurar variável ANTHROPIC_API_KEY",
      content:
        "Adicionar a nova chave no servidor de produção via variável de ambiente. Testar endpoint /v1/messages após deploy.",
      tags: ["Dev", "Infra"],
      date: tomorrow,
      time: "09:00",
      pinned: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: uuidv4(),
      type: "note",
      title: "Geometria da Verdade — Marks & Tegmark",
      content:
        "Representações lineares de veracidade no espaço de ativações. Aplicar ao estudo de estabilidade de intenção em agentes classificadores (Hipótese H2 do projeto).",
      tags: ["Pesquisa", "Interpretabilidade"],
      date: today,
      time: null,
      pinned: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: uuidv4(),
      type: "event",
      title: "Defesa do TCC",
      content:
        "Preparar slides finais com resultados comparativos SAS vs MAS. Confirmar banca e sala com orientador.",
      tags: ["TCC", "Acadêmico"],
      date: nextWeek,
      time: "10:00",
      pinned: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: uuidv4(),
      type: "note",
      title: "Consignado Privado — Vera Cruz Capital",
      content:
        "Refinamento do prompt do agente de atendimento. Mapear intenções: consulta de margem, antecipação de FGTS, portabilidade. Ajustar tom para CLT workers.",
      tags: ["Fintech", "IA"],
      date: today,
      time: null,
      pinned: false,
      createdAt: new Date().toISOString(),
    },
  ];
}

// ─── Routes ──────────────────────────────────────────────────

// GET /api/entries — list all (with optional filters)
app.get("/api/entries", (req, res) => {
  const db = readDB();
  let { type, pinned, search, sort } = req.query;
  let entries = [...db.entries];

  if (type && type !== "all") {
    if (type === "pinned") entries = entries.filter((e) => e.pinned);
    else entries = entries.filter((e) => e.type === type);
  }

  if (search) {
    const q = search.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
    );
  }

  // Sort: pinned first, then by date desc
  entries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  res.json({ entries, total: entries.length });
});

// GET /api/entries/upcoming — next events/reminders
app.get("/api/entries/upcoming", (req, res) => {
  const db = readDB();
  const today = new Date().toISOString().split("T")[0];
  const limit = parseInt(req.query.limit) || 5;

  const upcoming = db.entries
    .filter((e) => (e.type === "event" || e.type === "reminder") && e.date >= today)
    .sort((a, b) => {
      const da = a.date + (a.time || "00:00");
      const db_ = b.date + (b.time || "00:00");
      return da.localeCompare(db_);
    })
    .slice(0, limit);

  res.json({ entries: upcoming });
});

// GET /api/entries/stats
app.get("/api/entries/stats", (req, res) => {
  const db = readDB();
  const stats = { note: 0, event: 0, reminder: 0, pinned: 0, total: db.entries.length };
  db.entries.forEach((e) => {
    stats[e.type]++;
    if (e.pinned) stats.pinned++;
  });
  res.json(stats);
});

// GET /api/entries/:id
app.get("/api/entries/:id", (req, res) => {
  const db = readDB();
  const entry = db.entries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found" });

  // Related: same tags
  const related = db.entries
    .filter((e) => e.id !== entry.id && e.tags.some((t) => entry.tags.includes(t)))
    .slice(0, 4);

  res.json({ entry, related });
});

// POST /api/entries
app.post("/api/entries", (req, res) => {
  const db = readDB();
  const { type, title, content, tags, date, time, pinned } = req.body;

  if (!title || !content) return res.status(400).json({ error: "title and content are required" });

  const entry = {
    id: uuidv4(),
    type: type || "note",
    title: title.trim(),
    content: content.trim(),
    tags: Array.isArray(tags) ? tags : [],
    date: date || new Date().toISOString().split("T")[0],
    time: time || null,
    pinned: pinned || false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.entries.unshift(entry);
  writeDB(db);
  res.status(201).json({ entry });
});

// PATCH /api/entries/:id
app.patch("/api/entries/:id", (req, res) => {
  const db = readDB();
  const idx = db.entries.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const allowed = ["type", "title", "content", "tags", "date", "time", "pinned"];
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) db.entries[idx][field] = req.body[field];
  });
  db.entries[idx].updatedAt = new Date().toISOString();

  writeDB(db);
  res.json({ entry: db.entries[idx] });
});

// DELETE /api/entries/:id
app.delete("/api/entries/:id", (req, res) => {
  const db = readDB();
  const idx = db.entries.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  db.entries.splice(idx, 1);
  writeDB(db);
  res.json({ success: true });
});

// ─── Health check ─────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✦ Fields' API  →  http://localhost:${PORT}/api/health\n`);
});
