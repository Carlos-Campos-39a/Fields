import { v4 as uuidv4 } from "uuid";
import { log } from "../lib/log.js";
import { hojeISO, somarDias } from "../lib/datas.js";

// Schema e seed, movidos LITERALMENTE do server.js monolítico (mesmos CREATE/ALTER, mesmo seed).
// Tudo idempotente: roda a cada boot. A tabela `migracoes` registra migrações de dado one-shot
// (a partir da A1): o nome é a chave, e a presença da linha é o "já rodou".
export async function initDB(db) {
  await db.query(`
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
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comments      JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kanban_status TEXT  NOT NULL DEFAULT 'A fazer';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date    TEXT;
    CREATE TABLE IF NOT EXISTS migracoes (
      nome        TEXT PRIMARY KEY,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed if empty
  const { rows } = await db.query("SELECT COUNT(*) FROM entries");
  if (parseInt(rows[0].count) === 0) {
    const today    = hojeISO();
    const tomorrow = somarDias(today, 1);
    const nextWeek = somarDias(today, 7);

    const seed = [
      { type: "note",     title: "Arquitetura de Agentes LLM",           content: "LangGraph permite orquestrar múltiplos agentes com estado compartilhado. Investigar como o MetaHarness pode otimizar automaticamente os prompts de cada nó do grafo.", tags: ["TCC","LangChain","IA"],          date: today,    time: null,    pinned: true  },
      { type: "event",    title: "Apresentação McKinsey — Cobrança",      content: "Revisar deck antes da reunião. Levar análise de roll-rate e resultados do A/B de SMS.",                                                                                   tags: ["Trabalho","McKinsey"],           date: tomorrow, time: "14:00", pinned: false },
      { type: "reminder", title: "Configurar ANTHROPIC_API_KEY",          content: "Adicionar a nova chave no servidor de produção via variável de ambiente. Testar endpoint /v1/messages após deploy.",                                                        tags: ["Dev","Infra"],                   date: tomorrow, time: "09:00", pinned: false },
      { type: "note",     title: "Geometria da Verdade — Marks & Tegmark", content: "Representações lineares de veracidade no espaço de ativações. Aplicar ao estudo de estabilidade de intenção em agentes classificadores.",                                  tags: ["Pesquisa","Interpretabilidade"], date: today,    time: null,    pinned: false },
      { type: "event",    title: "Defesa do TCC",                         content: "Preparar slides finais com resultados comparativos SAS vs MAS. Confirmar banca e sala com orientador.",                                                                     tags: ["TCC","Acadêmico"],               date: nextWeek, time: "10:00", pinned: true  },
    ];

    for (const e of seed) {
      await db.query(
        `INSERT INTO entries (id, type, title, content, tags, date, time, pinned, threads)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]')`,
        [uuidv4(), e.type, e.title, e.content, JSON.stringify(e.tags), e.date, e.time, e.pinned]
      );
    }
    log.info("DB_SEED", { entradas: seed.length });
  }
  log.info("DB_PRONTO");
}
