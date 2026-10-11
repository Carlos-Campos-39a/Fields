import { v4 as uuidv4 } from "uuid";
import { log } from "../lib/log.js";
import { hojeISO, somarDias } from "../lib/datas.js";
import {
  ACOES_HISTORICO, ALVOS_COMENTARIO, CANAIS, ENTIDADES, EVENTO_EM_VOO, MEMORIA_ATIVA, ORIGENS, ROLES_MENSAGEM,
  SESSAO_ATIVA, STATUS_EVENTO, STATUS_MEMORIA, STATUS_SESSAO,
} from "../dominio/enums.js";
import { MEMORIA_TEXTO_MAX } from "../dominio/limites.js";
import { aplicarMigracoes } from "./migracoes.js";
import { recuperarOrfaosSemFalhar } from "../servicos/turnos.js";

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

// ─── A2b: o motor do agente — aditivo; a DDL_A2 acima fica como estava ───
//
// agente_sessoes: uma conversa do motor com o modelo, por canal. UMA ativa por canal (índice único
// parcial): duas instâncias no ar ao mesmo tempo (a sobreposição de um deploy no Railway) não abrem
// duas conversas paralelas. `prompt_versao` é o hash do system + ferramentas que a sessão usou — se
// mudar, a próxima mensagem abre outra (agente/sessoes.js). `motivo` diz por que ela acabou.
//
// agente_mensagens: o histórico EXATO que vai ao modelo, uma linha por mensagem, só INSERT. `content`
// é TEXT com o JSON como saiu da API (não jsonb): o pensamento preservado do Opus 5.5 amarra cada
// bloco de thinking aos bytes de tudo o que veio antes, e o jsonb normaliza (reordena chaves, tira
// espaço, muda número). O TEXT devolve o que entrou. Sem UPDATE e sem DELETE em lugar nenhum — a
// varredura de test/sessoes.test.js cobra.
//
// agente_turnos ganha o que o motor escreve no fim do turno: `motivo` (por que acabou como acabou),
// `resposta` (o texto mostrado) e `metricas` (chamadas, tools, tokens, duração). Os índices servem a
// consulta da conversa (canal, criado_em) e a da sessão.
export const DDL_A2B = `
    CREATE TABLE IF NOT EXISTS agente_sessoes (
      id                  TEXT PRIMARY KEY,
      canal               TEXT        NOT NULL CONSTRAINT agente_sessoes_canal_check CHECK (canal IN (${listaSql(CANAIS)})),
      prompt_versao       TEXT        NOT NULL,
      modelo              TEXT        NOT NULL,
      status              TEXT        NOT NULL DEFAULT '${SESSAO_ATIVA}' CONSTRAINT agente_sessoes_status_check CHECK (status IN (${listaSql(STATUS_SESSAO)})),
      motivo              TEXT,
      n_mensagens         INTEGER     NOT NULL DEFAULT 0,
      ultimo_input_tokens INTEGER     NOT NULL DEFAULT 0,
      criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ultima_atividade_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      encerrado_em        TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agente_sessoes_uma_ativa_idx ON agente_sessoes (canal) WHERE status = '${SESSAO_ATIVA}';

    CREATE TABLE IF NOT EXISTS agente_mensagens (
      sessao_id  TEXT        NOT NULL REFERENCES agente_sessoes(id),
      seq        INTEGER     NOT NULL,
      role       TEXT        NOT NULL CONSTRAINT agente_mensagens_role_check CHECK (role IN (${listaSql(ROLES_MENSAGEM)})),
      content    TEXT        NOT NULL,
      turno_id   TEXT,
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (sessao_id, seq)
    );

    ALTER TABLE agente_turnos ADD COLUMN IF NOT EXISTS motivo   TEXT;
    ALTER TABLE agente_turnos ADD COLUMN IF NOT EXISTS resposta TEXT;
    ALTER TABLE agente_turnos ADD COLUMN IF NOT EXISTS metricas JSONB;
    CREATE INDEX IF NOT EXISTS agente_turnos_sessao_idx ON agente_turnos (sessao_id);
    CREATE INDEX IF NOT EXISTS agente_turnos_canal_criado_idx ON agente_turnos (canal, criado_em);
`;

// ─── A3: o webhook do WhatsApp (Les Chats) — aditivo; nada das fases anteriores muda ───
//
// eventos_recebidos: a idempotência pelo wamid (o `event_id` do envelope, contrato §6.1). A linha
// nasce EM_VOO antes do turno e vira CONCLUIDO com a `resposta` — o corpo que foi devolvido, para a
// retentativa receber o mesmo. Sem ela, a 2ª entrega da Les Chats (o POST dela tem 120 s e retenta
// uma vez) rodaria o turno de novo: a tarefa criada duas vezes, e duas respostas diferentes para a
// mesma pergunta. `resposta` é jsonb porque aqui só o significado importa (é o corpo HTTP, não o
// histórico do modelo, que precisa dos bytes). A limpeza depois de 7 dias é da passada periódica
// (servicos/whatsapp.js), nunca do boot.
//
// canais_whatsapp: com quem se fala e por qual conversa da Les Chats. A Fase 2 (avisos proativos)
// manda por `conversation_id` — nunca por telefone (contrato §1.b) —, e é daqui que ela o lê.
export const DDL_A3 = `
    CREATE TABLE IF NOT EXISTS eventos_recebidos (
      event_id     TEXT PRIMARY KEY,
      status       TEXT        NOT NULL DEFAULT '${EVENTO_EM_VOO}' CONSTRAINT eventos_recebidos_status_check CHECK (status IN (${listaSql(STATUS_EVENTO)})),
      turno_id     TEXT,
      resposta     JSONB,
      tentativas   INTEGER     NOT NULL DEFAULT 1,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      concluido_em TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS eventos_recebidos_criado_idx ON eventos_recebidos (criado_em);

    CREATE TABLE IF NOT EXISTS canais_whatsapp (
      wa_id           TEXT PRIMARY KEY,
      conversation_id BIGINT      NOT NULL,
      bot_id          BIGINT,
      atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
  await db.query(DDL_A2B);
  await db.query(DDL_A3);

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
  // Dado, não schema: como as migrações, a falha aqui não derruba o boot (o log é que avisa). É a
  // 1ª passada; o server.js agenda as seguintes (o órfão de uma queda ainda é recente neste boot).
  await recuperarOrfaosSemFalhar(db, { momento: "boot" });
  log.info("DB_PRONTO", { comentarios_migrados: estado.comentariosMigrados });
  return estado;
}
