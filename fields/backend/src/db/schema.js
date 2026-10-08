import { v4 as uuidv4 } from "uuid";
import { log } from "../lib/log.js";
import { hojeISO, somarDias } from "../lib/datas.js";
import { ACOES_HISTORICO, ALVOS_COMENTARIO, CANAIS, ENTIDADES, MEMORIA_ATIVA, ORIGENS, STATUS_MEMORIA } from "../dominio/enums.js";
import { MEMORIA_TEXTO_MAX } from "../dominio/limites.js";
import { aplicarMigracoes } from "./migracoes.js";

// Schema e seed. Tudo idempotente: roda a cada boot, e um statement que falha DERRUBA o boot (o
// healthcheck do Railway segura o deploy anterior no ar). Migração de DADO é outra coisa: mora em
// db/migracoes.js, e a falha dela não derruba nada (ver initDB).

/** Lista SQL ('A','B') a partir de um enum de dominio/enums.js — o CHECK nunca repete os valores. */
export function listaSql(valores) {
  return valores.map((v) => `'${String(v).replaceAll("'", "''")}'`).join(",");
}

// ─── A0: movido LITERALMENTE do server.js monolítico (mesmos CREATE/ALTER) ───
// A tabela `migracoes` registra migrações de dado one-shot (a partir da A1): o nome é a chave, e a
// presença da linha é o "já rodou".
export const DDL_BASE = `
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
`;

// ─── A1: domínio desfazível — aditivo, nada do A0 muda ───
//
// deleted_at nas cinco tabelas: excluir vira carimbo (servicos/exclusao.js).
//
// As views são a CASCATA LÓGICA: projeto excluído esconde as frentes, frente excluída (ou de
// projeto excluído) esconde as tarefas — sem carimbar os filhos, então restaurar o pai devolve
// tudo, e o filho excluído sozinho continua excluído. Leitura de frentes/tarefas passa SÓ por elas
// (test/schema.test.js varre os serviços).
//   ATENÇÃO: o `*` expande na CRIAÇÃO da view. Coluna NOVA em frentes/tasks: o ALTER vem antes
//   daqui, e o CREATE OR REPLACE acrescenta a coluna no fim (permitido). Mudar o TIPO ou REMOVER
//   uma coluna dessas tabelas exige `DROP VIEW tarefas_visiveis, frentes_visiveis` antes — o
//   CREATE OR REPLACE falha, e falha de schema derruba o boot.
//
// comentarios: uma linha por comentário (era array jsonb dentro da entidade; a cópia é a migração
// comentarios_v1). historico: o diff de cada escrita, gravado pelos serviços no mesmo tx.
//   Os CHECKs são montados dos enums. Valor NOVO num enum exige migração própria do CHECK
//   (ALTER TABLE ... DROP CONSTRAINT <nome>, ADD CONSTRAINT <nome> CHECK (...)): o CREATE TABLE IF
//   NOT EXISTS não reescreve o CHECK de tabela existente. Por isso os nomes são explícitos.
export const DDL_A1 = `
    ALTER TABLE entries  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE frentes  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE tasks    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE OR REPLACE VIEW frentes_visiveis AS
      SELECT f.* FROM frentes f JOIN projects p ON p.id = f.project_id
      WHERE f.deleted_at IS NULL AND p.deleted_at IS NULL;
    CREATE OR REPLACE VIEW tarefas_visiveis AS
      SELECT t.* FROM tasks t JOIN frentes_visiveis f ON f.id = t.frente_id
      WHERE t.deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS comentarios (
      id          TEXT PRIMARY KEY,
      alvo_tipo   TEXT        NOT NULL CONSTRAINT comentarios_alvo_tipo_check CHECK (alvo_tipo IN (${listaSql(ALVOS_COMENTARIO)})),
      alvo_id     TEXT        NOT NULL,
      texto       TEXT        NOT NULL,
      criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at  TIMESTAMPTZ,
      origem      TEXT        NOT NULL DEFAULT 'web' CONSTRAINT comentarios_origem_check CHECK (origem IN (${listaSql(ORIGENS)}))
    );
    CREATE INDEX IF NOT EXISTS comentarios_alvo_idx ON comentarios (alvo_tipo, alvo_id) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS historico (
      id            BIGSERIAL PRIMARY KEY,
      entidade_tipo TEXT        NOT NULL CONSTRAINT historico_entidade_tipo_check CHECK (entidade_tipo IN (${listaSql(ENTIDADES)})),
      entidade_id   TEXT        NOT NULL,
      acao          TEXT        NOT NULL CONSTRAINT historico_acao_check CHECK (acao IN (${listaSql(ACOES_HISTORICO)})),
      mudancas      JSONB       NOT NULL DEFAULT '[]',
      origem        TEXT        NOT NULL CONSTRAINT historico_origem_check CHECK (origem IN (${listaSql(ORIGENS)})),
      turno_id      TEXT,
      desfaz_id     BIGINT      REFERENCES historico(id),
      criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS historico_entidade_idx ON historico (entidade_tipo, entidade_id, id DESC);
`;

// ─── A2: ontologia e agente — aditivo, nada da A0/A1 muda ───
//
// memorias: o que o Carlos pediu para o assistente lembrar. Esquecer ARQUIVA (status + arquivado_em),
// não apaga. O teto de ativas é do serviço (servicos/memorias.js), não do banco: ele recusa com
// MEMORIA_CHEIA, e um CHECK não tem como contar linhas.
//
// agente_turnos: um pedido ao agente (um turno do chat, uma mensagem do WhatsApp, uma chamada de
// escrita do MCP). `acoes` é a lista do que ele ESCREVEU, gravada no mesmo tx de cada escrita — é a
// matéria-prima do desfazer, que inverte sem chamar LLM. `sessao_id` fica nulo até o motor (A2,
// etapa seguinte) ter sessões; `status` sem CHECK porque os estados do motor (ESGOTADO…) ainda não
// existem, e um CHECK prematuro exigiria migração no dia em que existirem.
//
// Mesma regra dos CHECKs da A1: valor novo em STATUS_MEMORIA, ORIGENS ou CANAIS exige migração
// própria do CHECK (os nomes são explícitos por isso).
export const DDL_A2 = `
    CREATE TABLE IF NOT EXISTS memorias (
      id           TEXT PRIMARY KEY,
      texto        TEXT        NOT NULL CONSTRAINT memorias_texto_check CHECK (char_length(texto) BETWEEN 1 AND ${MEMORIA_TEXTO_MAX}),
      status       TEXT        NOT NULL DEFAULT '${MEMORIA_ATIVA}' CONSTRAINT memorias_status_check CHECK (status IN (${listaSql(STATUS_MEMORIA)})),
      lembrar_em   TEXT,
      origem       TEXT        NOT NULL CONSTRAINT memorias_origem_check CHECK (origem IN (${listaSql(ORIGENS)})),
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      arquivado_em TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS memorias_status_idx ON memorias (status, criado_em);

    CREATE TABLE IF NOT EXISTS agente_turnos (
      id           TEXT PRIMARY KEY,
      canal        TEXT        NOT NULL CONSTRAINT agente_turnos_canal_check CHECK (canal IN (${listaSql(CANAIS)})),
      sessao_id    TEXT,
      status       TEXT        NOT NULL DEFAULT 'CONCLUIDO',
      entrada      TEXT,
      acoes        JSONB       NOT NULL DEFAULT '[]',
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      concluido_em TIMESTAMPTZ,
      desfeito_em  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS agente_turnos_criado_idx ON agente_turnos (criado_em DESC);
`;

/**
 * Schema → seed → migrações de dado. Devolve o `estado` que o app precisa saber do banco:
 * {comentariosMigrados} — false quando a migração comentarios_v1 falhou (MIGRACAO_FALHOU no log),
 * e o app inteiro segue no modo legado (arrays jsonb, como na A0) em vez de cair.
 */
export async function initDB(db) {
  await db.query(DDL_BASE);
  await db.query(DDL_A1);
  await db.query(DDL_A2);

  // Seed if empty (conta também as excluídas: excluir tudo não ressemeia o banco)
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

  const estado = await aplicarMigracoes(db);
  log.info("DB_PRONTO", { comentarios_migrados: estado.comentariosMigrados });
  return estado;
}
