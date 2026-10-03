// A migração comentarios_v1 e a política de falha, com um banco falso: roda sem Postgres. O que
// se cobra aqui é a LÓGICA — o que é copiado, como uma colisão é remapeada, quando se volta atrás
// e em que modo o app sobe. A mesma migração contra Postgres real está em integracao.test.js.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MIGRACAO_COMENTARIOS, aplicarMigracoes, migrarComentarios, repararDivergencia } from "../src/db/migracoes.js";
import { definirSaida } from "../src/lib/log.js";

let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });
const evento = (nome) => logs.find((l) => l.evento === nome);

const TABELA = { entries: "ENTRADA", tasks: "TAREFA", meetings: "REUNIAO" };

/**
 * Banco falso com as respostas que a migração espera. `fontes` = {ENTRADA: [{id, created_at,
 * legado}], TAREFA: [...], REUNIAO: [...]}. Os INSERTs em comentarios respeitam o PK (o id já
 * gravado devolve zero linhas, como o ON CONFLICT DO NOTHING). `ajuste(sql, params)` sobrepõe.
 */
function bancoFalso({ fontes = {}, aplicada = false, ajuste = () => undefined } = {}) {
  const chamadas = [];
  const gravados = new Map();
  const query = async (sql, params = []) => {
    const s = sql.trim();
    chamadas.push({ sql: s, params });
    const sobreposto = await ajuste(s, params, chamadas);
    if (sobreposto !== undefined) return sobreposto;

    if (s.startsWith("SELECT 1 FROM migracoes")) return { rows: aplicada ? [{ "?column?": 1 }] : [] };
    const fonte = /^SELECT id, (?:threads|comments) AS legado, created_at FROM (\w+)/.exec(s);
    if (fonte) return { rows: fontes[TABELA[fonte[1]]] ?? [] };
    if (s.startsWith("INSERT INTO comentarios")) {
      if (gravados.has(params[0])) return { rows: [] };
      const linha = { id: params[0], alvo_tipo: params[1], alvo_id: params[2], texto: params[3], criado_em: params[4], origem: params[5] };
      gravados.set(params[0], linha);
      return { rows: [linha] };
    }
    const soma = /^SELECT COALESCE\(SUM\(.*\)\), 0\)::int AS n FROM (\w+)$/s.exec(s);
    if (soma) {
      const n = (fontes[TABELA[soma[1]]] ?? []).reduce((a, p) => a + (Array.isArray(p.legado) ? p.legado.length : 0), 0);
      return { rows: [{ n }] };
    }
    if (s.startsWith("SELECT COUNT(*)::int AS n FROM comentarios WHERE alvo_tipo")) {
      return { rows: [{ n: [...gravados.values()].filter((l) => l.alvo_tipo === params[0]).length }] };
    }
    if (/^SELECT COUNT\(\*\)::int AS n FROM \w+ f/.test(s)) return { rows: [{ n: 0 }] };
    if (s.includes("UNION ALL")) return { rows: [] }; // repararDivergencia: nenhum órfão
    return { rows: [], rowCount: 0 };
  };
  return { chamadas, gravados, query, connect: async () => ({ query, release() {} }) };
}

const pai = (id, legado, created_at = new Date("2026-09-01T08:00:00Z")) => ({ id, legado, created_at });
const sqls = (db) => db.chamadas.map((c) => c.sql);

test("copia os três alvos preservando id, texto e data; grava a migração no mesmo tx", async () => {
  const db = bancoFalso({ fontes: {
    ENTRADA: [pai("e1", [{ id: "1696334400000", text: "nota", createdAt: "2026-10-01T10:00:00.000Z" }])],
    TAREFA: [pai("t1", [{ id: "u-1", text: "tarefa", created_at: "2026-10-02T10:00:00.000Z" }]), pai("t2", [])],
    REUNIAO: [pai("r1", [{ id: "1696334400001", text: "reunião", created_at: "2026-10-03T10:00:00.000Z" }])],
  } });
  assert.equal(await migrarComentarios(db), true);

  assert.deepEqual([...db.gravados.values()].map((l) => [l.id, l.alvo_tipo, l.alvo_id, l.texto, l.criado_em, l.origem]), [
    ["1696334400000", "ENTRADA", "e1", "nota", "2026-10-01T10:00:00.000Z", "sistema"],
    ["u-1", "TAREFA", "t1", "tarefa", "2026-10-02T10:00:00.000Z", "sistema"],
    ["1696334400001", "REUNIAO", "r1", "reunião", "2026-10-03T10:00:00.000Z", "sistema"],
  ]);
  const ordem = sqls(db);
  assert.equal(ordem[1], "BEGIN");
  assert.ok(ordem.includes("LOCK TABLE migracoes IN EXCLUSIVE MODE"));
  assert.ok(ordem.includes("LOCK TABLE entries, tasks, meetings IN SHARE MODE"), "a instância antiga não escreve no vão");
  assert.ok(ordem.indexOf("LOCK TABLE entries, tasks, meetings IN SHARE MODE") < ordem.findIndex((s) => s.startsWith("INSERT INTO comentarios")));
  const insercao = db.chamadas.find((c) => c.sql.startsWith("INSERT INTO migracoes"));
  assert.deepEqual(insercao.params, [MIGRACAO_COMENTARIOS]);
  assert.ok(ordem.indexOf(insercao.sql) < ordem.indexOf("COMMIT"), "a linha de migracoes entra ANTES do COMMIT");
  assert.ok(!ordem.some((s) => /^UPDATE (entries|tasks|meetings)/.test(s)), "as colunas legadas não são tocadas");

  const aplicada = evento("MIGRACAO_APLICADA");
  assert.deepEqual([aplicada.nome, aplicada.entradas, aplicada.tarefas, aplicada.reunioes, aplicada.remapeados, aplicada.reparados],
    ["comentarios_v1", 1, 1, 1, 0, 0]);
  assert.ok(!JSON.stringify(logs).includes("nota"), "texto de comentário nunca vai ao log");
});

test("id que colide entre alvos é remapeado para alvo_tipo:alvo_id:id — nenhum comentário cai", async () => {
  const db = bancoFalso({ fontes: {
    ENTRADA: [pai("e1", [{ id: "c1", text: "da entrada", createdAt: "2026-10-01T10:00:00.000Z" }])],
    TAREFA: [pai("t1", [{ id: "c1", text: "da tarefa", created_at: "2026-10-02T10:00:00.000Z" }])],
    REUNIAO: [pai("r1", [
      { id: "c1", text: "da reunião", created_at: "2026-10-03T10:00:00.000Z" },
      { id: "c1", text: "repetido no mesmo array", created_at: "2026-10-03T11:00:00.000Z" },
    ])],
  } });
  assert.equal(await migrarComentarios(db), true);
  assert.deepEqual([...db.gravados.keys()], ["c1", "TAREFA:t1:c1", "REUNIAO:r1:c1", "REUNIAO:r1:c1:2"]);
  assert.deepEqual([...db.gravados.values()].map((l) => l.texto),
    ["da entrada", "da tarefa", "da reunião", "repetido no mesmo array"]);
  const remap = evento("MIGRACAO_COMENTARIO_ID_REMAPEADO");
  assert.deepEqual([remap.entradas, remap.tarefas, remap.reunioes], [0, 1, 2]);
  assert.equal(evento("MIGRACAO_APLICADA").remapeados, 3);
});

test("item sem id ou sem data é reparado e contado; a data que falta é a de criação do pai", async () => {
  const criadoPai = new Date("2026-08-15T12:00:00Z");
  const db = bancoFalso({ fontes: {
    ENTRADA: [pai("e1", [{ text: "sem id", createdAt: "2026-10-01T10:00:00.000Z" }, { id: "x", text: "sem data" }], criadoPai)],
  } });
  assert.equal(await migrarComentarios(db), true);
  const [semId, semData] = [...db.gravados.values()];
  assert.match(semId.id, /^[0-9a-f-]{36}$/);
  assert.equal(semData.criado_em, "2026-08-15T12:00:00.000Z");
  const reparado = evento("MIGRACAO_COMENTARIO_REPARADO");
  assert.deepEqual([reparado.nivel, reparado.itens, reparado.id_gerado, reparado.data_padrao], ["warn", 2, 1, 1]);
  assert.equal(evento("MIGRACAO_APLICADA").reparados, 2);
});

test("item ilegível → ROLLBACK, MIGRACAO_FALHOU, e o app sobe no modo LEGADO (sem lançar)", async () => {
  const db = bancoFalso({ fontes: {
    ENTRADA: [pai("e1", [{ id: "ok", text: "bom", createdAt: "2026-10-01T10:00:00.000Z" }])],
    TAREFA: [pai("t1", [{ id: "ruim", text: 42 }])],
  } });
  const estado = await aplicarMigracoes(db);
  assert.deepEqual(estado, { comentariosMigrados: false });
  assert.ok(Object.isFrozen(estado));
  assert.ok(sqls(db).includes("ROLLBACK"));
  assert.ok(!sqls(db).includes("COMMIT"));
  assert.ok(!sqls(db).some((s) => s.startsWith("INSERT INTO migracoes")));
  const falhou = evento("MIGRACAO_FALHOU");
  assert.equal(falhou.nivel, "erro");
  assert.deepEqual([falhou.nome, falhou.erro, falhou.motivo, falhou.alvo_tipo], ["comentarios_v1", "ErroMigracao", "ITEM_INVALIDO", "TAREFA"]);
  assert.equal(evento("MIGRACAO_APLICADA"), undefined);
});

test("coluna legada que não é array → falha com motivo COLUNA_NAO_ARRAY", async () => {
  const db = bancoFalso({ fontes: { REUNIAO: [pai("r1", { nao: "é array" })] } });
  assert.equal(await migrarComentarios(db), false);
  assert.deepEqual([evento("MIGRACAO_FALHOU").motivo, evento("MIGRACAO_FALHOU").alvo_tipo], ["COLUNA_NAO_ARRAY", "REUNIAO"]);
});

test("JSON null na coluna legada conta como vazio (é o que o GET mostrava)", async () => {
  const db = bancoFalso({ fontes: { ENTRADA: [pai("e1", null)] } });
  assert.equal(await migrarComentarios(db), true);
  assert.equal(db.gravados.size, 0);
});

test("contagem que não fecha → CONTAGEM_DIVERGENTE e ROLLBACK", async () => {
  const db = bancoFalso({
    fontes: { ENTRADA: [pai("e1", [{ id: "a", text: "a", createdAt: "2026-10-01T10:00:00.000Z" }])] },
    ajuste: (s) => (s.startsWith("SELECT COALESCE(SUM(") && s.endsWith("FROM entries") ? { rows: [{ n: 2 }] } : undefined),
  });
  assert.equal(await migrarComentarios(db), false);
  const falhou = evento("MIGRACAO_FALHOU");
  assert.deepEqual([falhou.motivo, falhou.alvo_tipo, falhou.esperado, falhou.copiado], ["CONTAGEM_DIVERGENTE", "ENTRADA", 2, 1]);
  assert.ok(sqls(db).includes("ROLLBACK"));
});

test("contagem por alvo que não fecha → CONTAGEM_POR_ALVO_DIVERGENTE", async () => {
  const db = bancoFalso({
    ajuste: (s) => (/^SELECT COUNT\(\*\)::int AS n FROM tasks f/.test(s) ? { rows: [{ n: 1 }] } : undefined),
  });
  assert.equal(await migrarComentarios(db), false);
  assert.equal(evento("MIGRACAO_FALHOU").motivo, "CONTAGEM_POR_ALVO_DIVERGENTE");
});

test("erro do Postgres no meio: loga o SQLSTATE, nunca a mensagem (que carrega valores)", async () => {
  const db = bancoFalso({
    fontes: { ENTRADA: [pai("e1", [{ id: "a", text: "a", createdAt: "2026-10-01T10:00:00.000Z" }])] },
    ajuste: (s) => {
      if (s.startsWith("INSERT INTO comentarios")) throw Object.assign(new Error("value too long: DADO-SENSIVEL"), { code: "22001" });
    },
  });
  assert.equal(await migrarComentarios(db), false);
  const falhou = evento("MIGRACAO_FALHOU");
  assert.deepEqual([falhou.erro, falhou.pg_codigo, falhou.motivo], ["Error", "22001", undefined]);
  assert.ok(!JSON.stringify(logs).includes("DADO-SENSIVEL"));
});

test("COMMIT que falhou mas chegou ao banco: o modo sai do banco (migrado), não do palpite", async () => {
  let commitou = false;
  const db = bancoFalso({
    ajuste: (s) => {
      if (s === "COMMIT") { commitou = true; throw Object.assign(new Error("conexão caiu"), { code: "08006" }); }
      if (s.startsWith("SELECT 1 FROM migracoes") && commitou) return { rows: [{ "?column?": 1 }] };
    },
  });
  assert.equal(await migrarComentarios(db), true);
  assert.ok(evento("MIGRACAO_FALHOU"));
  assert.ok(evento("MIGRACAO_CONFIRMADA_APOS_ERRO"));
});

test("sem como ler `migracoes` depois da falha: lança (o boot cai — adivinhar o modo seria pior)", async () => {
  let falhou = false;
  const db = bancoFalso({
    ajuste: (s) => {
      if (s === "LOCK TABLE migracoes IN EXCLUSIVE MODE") { falhou = true; throw Object.assign(new Error("x"), { code: "57P01" }); }
      if (s.startsWith("SELECT 1 FROM migracoes") && falhou) throw Object.assign(new Error("banco fora"), { code: "57P01" });
    },
  });
  await assert.rejects(migrarComentarios(db), /banco fora/);
});

test("já aplicada: não copia nada, loga MIGRACAO_JA_APLICADA e procura o que reparar", async () => {
  const db = bancoFalso({ aplicada: true, fontes: { ENTRADA: [pai("e1", [{ id: "a", text: "a" }])] } });
  assert.deepEqual(await aplicarMigracoes(db), { comentariosMigrados: true });
  assert.ok(evento("MIGRACAO_JA_APLICADA"));
  assert.ok(!sqls(db).includes("BEGIN"), "nada a reparar: nem abre transação, nem disputa trava");
  assert.equal(db.gravados.size, 0);
  assert.ok(sqls(db).some((s) => s.includes("UNION ALL")), "a procura de órfãos rodou");
  assert.equal(evento("MIGRACAO_COMENTARIO_RECUPERADO"), undefined);
  assert.equal(evento("MIGRACAO_COMENTARIO_DIVERGENTE"), undefined);
});

// Linha do SELECT de órfãos (sqlOrfaos): item do backup jsonb sem linha em `comentarios`.
const orfao = (alvo_tipo, alvo_id, item, posicao = 1) =>
  ({ ordem_alvo: 0, alvo_tipo, alvo_id, pai_criado_em: new Date("2026-09-01T08:00:00Z"), item, posicao });

test("já aplicada com item no backup sem linha na tabela → RECUPERADO: vira linha (sistema, CRIADO), sob a trava, sem tocar o jsonb", async () => {
  const db = bancoFalso({
    aplicada: true,
    ajuste: (s) => (s.includes("UNION ALL") ? { rows: [
      orfao("ENTRADA", "e1", { id: "c1", text: "escrito na A0", createdAt: "2026-10-03T10:00:00.000Z" }),
      orfao("TAREFA", "t1", { id: "u-9", text: "também na A0", created_at: "2026-10-03T11:00:00.000Z" }),
      orfao("TAREFA", "t1", { id: "u-10", text: "sem data" }, 2),
    ] } : undefined),
  });
  db.gravados.set("c1", { id: "c1", alvo_tipo: "REUNIAO", alvo_id: "r1" }); // o id já existe em OUTRO alvo
  assert.equal(await migrarComentarios(db), true);

  assert.deepEqual([...db.gravados.values()].slice(1).map((l) => [l.id, l.alvo_tipo, l.alvo_id, l.texto, l.criado_em, l.origem]), [
    ["ENTRADA:e1:c1", "ENTRADA", "e1", "escrito na A0", "2026-10-03T10:00:00.000Z", "sistema"],
    ["u-9", "TAREFA", "t1", "também na A0", "2026-10-03T11:00:00.000Z", "sistema"],
    ["u-10", "TAREFA", "t1", "sem data", "2026-09-01T08:00:00.000Z", "sistema"],
  ]);
  const ordem = sqls(db);
  const trava = ordem.indexOf("LOCK TABLE migracoes IN EXCLUSIVE MODE");
  assert.ok(trava > ordem.indexOf("BEGIN"), "a trava é da transação do reparo");
  assert.ok(ordem.findIndex((s, i) => i > trava && s.includes("UNION ALL")) > trava, "relê os órfãos DEPOIS da trava");
  assert.ok(ordem.includes("COMMIT"));
  assert.ok(!ordem.some((s) => /^UPDATE (entries|tasks|meetings)/.test(s)), "o jsonb não é reescrito");
  assert.ok(!ordem.some((s) => /^UPDATE comentarios|^DELETE/.test(s)), "nada é removido nem alterado");

  const historico = db.chamadas.filter((c) => c.sql.startsWith("INSERT INTO historico"));
  assert.deepEqual(historico.map((c) => [c.params[0], c.params[1], c.params[2], c.params[4]]), [
    ["COMENTARIO", "ENTRADA:e1:c1", "CRIADO", "sistema"], ["COMENTARIO", "u-9", "CRIADO", "sistema"], ["COMENTARIO", "u-10", "CRIADO", "sistema"],
  ]);

  const rec = evento("MIGRACAO_COMENTARIO_RECUPERADO");
  assert.deepEqual([rec.nivel, rec.momento, rec.entradas, rec.tarefas, rec.reunioes, rec.remapeados, rec.reparados],
    ["warn", "boot", 1, 2, 0, 1, 1]);
  assert.equal(evento("MIGRACAO_COMENTARIO_DIVERGENTE"), undefined);
  assert.ok(!JSON.stringify(logs).includes("na A0"), "texto de comentário nunca vai ao log");
});

test("reparo: item ilegível no backup não é inventado — fica no jsonb e sai em MIGRACAO_COMENTARIO_DIVERGENTE", async () => {
  const db = bancoFalso({
    aplicada: true,
    ajuste: (s) => (s.includes("UNION ALL") ? { rows: [
      orfao("REUNIAO", "r1", { id: "ruim", text: 42 }),
      orfao("REUNIAO", "r1", { id: "bom", text: "ok", created_at: "2026-10-03T10:00:00.000Z" }, 2),
    ] } : undefined),
  });
  assert.equal(await migrarComentarios(db), true);
  assert.deepEqual([...db.gravados.keys()], ["bom"]);
  const div = evento("MIGRACAO_COMENTARIO_DIVERGENTE");
  assert.deepEqual([div.nivel, div.motivo, div.entradas, div.tarefas, div.reunioes], ["warn", "ITEM_INVALIDO", 0, 0, 1]);
  assert.equal(evento("MIGRACAO_COMENTARIO_RECUPERADO").reunioes, 1);
});

test("reparo concorrente: outra instância recuperou enquanto esta esperava a trava → não grava de novo", async () => {
  let travou = false;
  const db = bancoFalso({
    aplicada: true,
    ajuste: (s) => {
      if (s === "LOCK TABLE migracoes IN EXCLUSIVE MODE") { travou = true; return { rows: [] }; }
      if (s.includes("UNION ALL")) {
        return { rows: travou ? [] : [orfao("ENTRADA", "e1", { id: "c1", text: "x", createdAt: "2026-10-03T10:00:00.000Z" })] };
      }
    },
  });
  assert.equal(await migrarComentarios(db), true);
  assert.equal(db.gravados.size, 0, "sem a releitura sob a trava, o c1 nasceria de novo como alias");
  assert.equal(evento("MIGRACAO_COMENTARIO_RECUPERADO"), undefined);
});

test("reparo que falha no meio: ROLLBACK, MIGRACAO_REPARO_FALHOU com o SQLSTATE, e o boot segue migrado", async () => {
  const db = bancoFalso({
    aplicada: true,
    ajuste: (s) => {
      if (s.includes("UNION ALL")) return { rows: [orfao("ENTRADA", "e1", { id: "c1", text: "DADO-SENSIVEL", createdAt: "2026-10-03T10:00:00.000Z" })] };
      if (s.startsWith("INSERT INTO historico")) throw Object.assign(new Error("falhou: DADO-SENSIVEL"), { code: "23514" });
    },
  });
  assert.equal(await migrarComentarios(db), true);
  assert.ok(sqls(db).includes("ROLLBACK"));
  assert.ok(!sqls(db).includes("COMMIT"));
  const falhou = evento("MIGRACAO_REPARO_FALHOU");
  assert.deepEqual([falhou.nivel, falhou.momento, falhou.pg_codigo], ["erro", "boot", "23514"]);
  assert.equal(evento("MIGRACAO_COMENTARIO_RECUPERADO"), undefined, "log de algo que voltou atrás mente");
  assert.ok(!JSON.stringify(logs).includes("DADO-SENSIVEL"));
});

test("procura de órfãos que falha não derruba o boot; o reparo agendado também nunca lança", async () => {
  const db = bancoFalso({
    aplicada: true,
    ajuste: (s) => { if (s.includes("UNION ALL")) throw Object.assign(new Error("x"), { code: "42601" }); },
  });
  assert.equal(await migrarComentarios(db), true);
  assert.equal(evento("MIGRACAO_REPARO_FALHOU").pg_codigo, "42601");
  logs = [];
  await repararDivergencia(db, { momento: "pos_deploy" }); // o caminho do setTimeout do server.js
  assert.deepEqual([evento("MIGRACAO_REPARO_FALHOU").momento, evento("MIGRACAO_REPARO_FALHOU").pg_codigo], ["pos_deploy", "42601"]);
});

test("outra instância migrou enquanto esta esperava a trava: não copia de novo, e sobe migrada", async () => {
  let travou = false;
  const db = bancoFalso({
    fontes: { ENTRADA: [pai("e1", [{ id: "a", text: "a", createdAt: "2026-10-01T10:00:00.000Z" }])] },
    ajuste: (s) => {
      if (s === "LOCK TABLE migracoes IN EXCLUSIVE MODE") { travou = true; return { rows: [] }; }
      if (s.startsWith("SELECT 1 FROM migracoes") && travou) return { rows: [{ "?column?": 1 }] };
    },
  });
  assert.equal(await migrarComentarios(db), true);
  assert.equal(db.gravados.size, 0);
  assert.ok(!sqls(db).some((s) => s.startsWith("INSERT INTO migracoes")));
  assert.equal(evento("MIGRACAO_JA_APLICADA").concorrente, true);
});
