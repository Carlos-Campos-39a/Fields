// O schema da A1 sem banco: os CHECKs vêm dos enums, e as leituras de frentes/tarefas passam pelas
// views (a varredura). O comportamento contra Postgres real está em integracao.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DDL_A1, DDL_A2, DDL_BASE, listaSql } from "../src/db/schema.js";
import {
  ACOES_HISTORICO, ALVOS_COMENTARIO, CANAIS, COLUNAS_KANBAN, COLUNA_FEITO, ENTIDADES, MEMORIA_ARQUIVADA,
  MEMORIA_ATIVA, ORIGENS, STATUS, STATUS_CONCLUIDO, STATUS_MEMORIA, TIPOS_AGENDADOS, TIPOS_ENTRADA,
} from "../src/dominio/enums.js";
import { MEMORIA_TEXTO_MAX } from "../src/dominio/limites.js";

test("listaSql monta a lista do CHECK a partir do enum (e escapa aspas)", () => {
  assert.equal(listaSql(["ENTRADA", "TAREFA"]), "'ENTRADA','TAREFA'");
  assert.equal(listaSql(["d'água"]), "'d''água'");
});

test("cada CHECK da A1 é exatamente a lista do enum correspondente", () => {
  const checks = {
    comentarios_alvo_tipo_check: ["alvo_tipo", ALVOS_COMENTARIO],
    comentarios_origem_check: ["origem", ORIGENS],
    historico_entidade_tipo_check: ["entidade_tipo", ENTIDADES],
    historico_acao_check: ["acao", ACOES_HISTORICO],
    historico_origem_check: ["origem", ORIGENS],
  };
  for (const [nome, [coluna, valores]] of Object.entries(checks)) {
    const esperado = `CONSTRAINT ${nome} CHECK (${coluna} IN (${listaSql(valores)}))`;
    assert.ok(DDL_A1.includes(esperado), `${nome}: ${esperado}`);
  }
  assert.equal((DDL_A1.match(/CHECK \(/g) ?? []).length, Object.keys(checks).length, "nenhum CHECK fora da lista acima");
});

test("enums da A1: alvo de comentário é entidade; COMENTARIO é entidade; origem tem as cinco portas", () => {
  for (const alvo of ALVOS_COMENTARIO) assert.ok(ENTIDADES.includes(alvo), alvo);
  assert.ok(ENTIDADES.includes("COMENTARIO"));
  assert.deepEqual([...ORIGENS], ["web", "mcp", "agente", "whatsapp", "sistema"]);
  assert.deepEqual([...ACOES_HISTORICO], ["CRIADO", "ATUALIZADO", "EXCLUIDO", "RESTAURADO"]);
  for (const lista of [ALVOS_COMENTARIO, ENTIDADES, ORIGENS, ACOES_HISTORICO]) assert.ok(Object.isFrozen(lista));
});

test("a A1 é aditiva: deleted_at nas cinco tabelas, views da cascata, e o DDL da A0 intocado", () => {
  for (const tabela of ["entries", "projects", "frentes", "tasks", "meetings"]) {
    assert.match(DDL_A1, new RegExp(`ALTER TABLE ${tabela}\\s+ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`));
  }
  assert.match(DDL_A1, /CREATE OR REPLACE VIEW frentes_visiveis AS\s+SELECT f\.\* FROM frentes f JOIN projects p ON p\.id = f\.project_id\s+WHERE f\.deleted_at IS NULL AND p\.deleted_at IS NULL;/);
  assert.match(DDL_A1, /CREATE OR REPLACE VIEW tarefas_visiveis AS\s+SELECT t\.\* FROM tasks t JOIN frentes_visiveis f ON f\.id = t\.frente_id\s+WHERE t\.deleted_at IS NULL;/);
  assert.ok(DDL_A1.indexOf("frentes_visiveis AS") < DDL_A1.indexOf("tarefas_visiveis AS"), "a de tarefas depende da de frentes");
  assert.doesNotMatch(DDL_A1, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i, "nada destrutivo no boot");
  assert.doesNotMatch(DDL_A1, /CREATE TABLE (?!IF NOT EXISTS)/, "toda criação é idempotente");
  assert.doesNotMatch(DDL_BASE, /deleted_at|comentarios|historico/, "o DDL da A0 não ganhou nada");
});

// ─── Varredura: leitura de frentes e tarefas SÓ pelas views ───
// Ler `frentes` ou `tasks` direto num caminho de leitura faz a tarefa de um projeto excluído
// reaparecer. As exceções legítimas (trava de escrita, contagem da ordem) levam a marca
// "tabela-direta" na mesma linha, com o motivo.
test("serviços e rotas só leem frentes/tasks pelas views, salvo linha marcada tabela-direta", () => {
  const raiz = fileURLToPath(new URL("../src/", import.meta.url));
  const violacoes = [];
  let marcadas = 0;
  for (const pasta of ["servicos", "rotas"]) {
    for (const arquivo of readdirSync(raiz + pasta).filter((f) => f.endsWith(".js"))) {
      readFileSync(`${raiz}${pasta}/${arquivo}`, "utf8").split(/\r?\n/).forEach((linha, i) => {
        if (!/\b(FROM|JOIN)\s+(frentes|tasks)\b/i.test(linha)) return;
        if (linha.includes("tabela-direta")) { marcadas++; return; }
        violacoes.push(`${pasta}/${arquivo}:${i + 1}: ${linha.trim()}`);
      });
    }
  }
  assert.deepEqual(violacoes, []);
  assert.ok(marcadas > 0, "a varredura achou as exceções conhecidas (senão o padrão quebrou)");
});

// ─── A2 · memorias e agente_turnos ───

test("A2: os CHECKs de memorias e agente_turnos são as listas dos enums; o teto do texto vem de limites.js", () => {
  const checks = {
    memorias_status_check: ["status", STATUS_MEMORIA],
    memorias_origem_check: ["origem", ORIGENS],
    agente_turnos_canal_check: ["canal", CANAIS],
  };
  for (const [nome, [coluna, valores]] of Object.entries(checks)) {
    const esperado = `CONSTRAINT ${nome} CHECK (${coluna} IN (${listaSql(valores)}))`;
    assert.ok(DDL_A2.includes(esperado), `${nome}: ${esperado}`);
  }
  assert.ok(DDL_A2.includes(`CONSTRAINT memorias_texto_check CHECK (char_length(texto) BETWEEN 1 AND ${MEMORIA_TEXTO_MAX})`));
  assert.ok(DDL_A2.includes(`DEFAULT '${MEMORIA_ATIVA}'`));
  assert.equal((DDL_A2.match(/CHECK \(/g) ?? []).length, Object.keys(checks).length + 1, "nenhum CHECK fora da lista acima");
});

test("A2 é aditiva: só CREATE ... IF NOT EXISTS, nada destrutivo, nenhuma tabela da A0/A1 alterada", () => {
  assert.doesNotMatch(DDL_A2, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bALTER\b/i);
  assert.doesNotMatch(DDL_A2, /CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/);
  assert.deepEqual([...DDL_A2.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ["memorias", "agente_turnos"]);
});

test("enums da A2: os valores com nome são membros das listas, e todo canal é também uma origem", () => {
  assert.ok(STATUS.includes(STATUS_CONCLUIDO));
  assert.ok(COLUNAS_KANBAN.includes(COLUNA_FEITO));
  assert.ok(TIPOS_AGENDADOS.every((t) => TIPOS_ENTRADA.includes(t)));
  assert.deepEqual([MEMORIA_ATIVA, MEMORIA_ARQUIVADA], [...STATUS_MEMORIA]);
  // A escrita que chega por um canal grava histórico com a origem de mesmo nome.
  for (const canal of CANAIS) assert.ok(ORIGENS.includes(canal), canal);
  for (const lista of [TIPOS_ENTRADA, TIPOS_AGENDADOS, STATUS, COLUNAS_KANBAN, STATUS_MEMORIA, CANAIS]) assert.ok(Object.isFrozen(lista));
});
