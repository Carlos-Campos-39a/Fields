// O schema da A1 sem banco: os CHECKs vêm dos enums, e as leituras de frentes/tarefas passam pelas
// views (a varredura). O comportamento contra Postgres real está em integracao.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DDL_A1, DDL_BASE, listaSql } from "../src/db/schema.js";
import { ACOES_HISTORICO, ALVOS_COMENTARIO, ENTIDADES, ORIGENS } from "../src/dominio/enums.js";

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
