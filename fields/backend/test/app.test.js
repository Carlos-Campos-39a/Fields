// criarApp com db falso: roda sem Postgres. Cobre a fronteira HTTP — auth, CSRF, rate limit,
// tratador de erro, log — e as duas correções de bug no que elas mandam ao banco.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { criarApp, ROTAS_PUBLICAS } from "../src/app.js";
import { carregarConfig } from "../src/config.js";
import { emitirCookieSessao, gerarHashSenha } from "../src/auth/sessao.js";
import { definirSaida } from "../src/lib/log.js";

const SENHA = "senha certa de teste";
const TOKEN = "token-do-mcp-de-teste-0123456789abcdef";
const config = carregarConfig({
  DATABASE_URL: "postgres://nao-usado",
  FIELDS_SENHA_HASH: await gerarHashSenha(SENHA),
  FIELDS_SEGREDO_SESSAO: "segredo-de-sessao-de-teste-0123456789",
  FIELDS_API_TOKEN: TOKEN,
});
const BEARER = { Authorization: `Bearer ${TOKEN}` };
const JSON_CT = { "Content-Type": "application/json" };

// ─── Infra de teste ───
let logs = [];
before(() => definirSaida((_nivel, linha) => logs.push(JSON.parse(linha))));
after(() => definirSaida(null));
beforeEach(() => { logs = []; });

/** db falso: registra cada query e responde com o que `responder` devolver. */
function dbFalso(responder = () => undefined) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      return (await responder(sql, params)) ?? { rows: [], rowCount: 0 };
    },
  };
}

async function subir(db = dbFalso()) {
  const app = criarApp({ config, db });
  const servidor = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const chamar = async (metodo, caminho, { headers = {}, body } = {}) => {
    const res = await fetch(base + caminho, { method: metodo, headers, body, redirect: "manual" });
    const texto = await res.text();
    let json; try { json = texto ? JSON.parse(texto) : undefined; } catch { json = undefined; }
    return { status: res.status, headers: res.headers, texto, json };
  };
  const fechar = () => new Promise((ok) => servidor.close(ok));
  return { app, db, chamar, fechar };
}

const linhaEntrada = (id = randomUUID()) => ({
  id, type: "note", title: "T", content: "C", tags: ["a"], date: "2026-10-03", time: null,
  pinned: false, threads: [], created_at: new Date("2026-10-03T12:00:00Z"), updated_at: new Date("2026-10-03T12:00:00Z"),
});

// O HTTP_REQ sai no "finish" da resposta: um tique depois do fetch, ele já está em `logs`.
const esperarLogs = () => new Promise((ok) => setImmediate(ok));

// ─── Rotas públicas e fechadas ───
test("/api/health responde 200 sem credencial", async () => {
  const s = await subir();
  try {
    const r = await s.chamar("GET", "/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.db, "postgres");
    assert.ok(!Number.isNaN(Date.parse(r.json.time)));
  } finally { await s.fechar(); }
});

test("/api/entries sem credencial → 401, e o banco nem é tocado", async () => {
  const s = await subir();
  try {
    const r = await s.chamar("GET", "/api/entries");
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: "nao_autenticado" });
    assert.equal(s.db.chamadas.length, 0);
    const negado = logs.find((l) => l.evento === "AUTH_NEGADO");
    assert.equal(negado.motivo, "SEM_CREDENCIAL");
    assert.equal(negado.rota, "/api/entries");
  } finally { await s.fechar(); }
});

test("AUTH_NEGADO e HTTP_REQ levam o TEMPLATE da rota, nunca o id", async () => {
  const s = await subir();
  const id = randomUUID();
  try {
    await s.chamar("PATCH", `/api/tasks/${id}`, { headers: JSON_CT, body: "{}" });
    await esperarLogs();
    const negado = logs.find((l) => l.evento === "AUTH_NEGADO");
    assert.equal(negado.rota, "/api/tasks/:id");
    const req = logs.find((l) => l.evento === "HTTP_REQ");
    assert.equal(req.rota, "/api/tasks/:id");
    assert.equal(req.status, 401);
    assert.equal(typeof req.duration_ms, "number");
    assert.ok(!JSON.stringify(logs).includes(id), "o id não pode aparecer em linha nenhuma");
  } finally { await s.fechar(); }
});

test("Bearer errado → 401 (mesmo tamanho, outro tamanho, malformado), sem lançar", async () => {
  const s = await subir();
  try {
    const casos = [
      [`Bearer ${"x".repeat(TOKEN.length)}`, "BEARER_INVALIDO"],
      ["Bearer curto", "BEARER_INVALIDO"],
      [`Bearer ${TOKEN}x`, "BEARER_INVALIDO"],
      [`Basic ${TOKEN}`, "BEARER_MALFORMADO"],
      ["Bearer", "BEARER_MALFORMADO"],
    ];
    for (const [authorization, motivo] of casos) {
      logs = [];
      const r = await s.chamar("GET", "/api/entries", { headers: { Authorization: authorization } });
      assert.equal(r.status, 401, authorization);
      assert.deepEqual(r.json, { error: "nao_autenticado" });
      assert.equal(logs.find((l) => l.evento === "AUTH_NEGADO").motivo, motivo);
    }
    assert.equal(s.db.chamadas.length, 0);
    assert.ok(!JSON.stringify(logs).includes(TOKEN), "o token nunca vai ao log");
  } finally { await s.fechar(); }
});

test("Authorization presente decide sozinho: Bearer errado + cookie válido → 401", async () => {
  const s = await subir();
  try {
    const cookie = `fields_s=${emitirCookieSessao(config.segredoSessao)}`;
    const r = await s.chamar("GET", "/api/auth/me", { headers: { Authorization: "Bearer errado", Cookie: cookie } });
    assert.equal(r.status, 401);
  } finally { await s.fechar(); }
});

test("Bearer certo → origem mcp, e a rota responde no formato de hoje", async () => {
  const linha = linhaEntrada();
  const s = await subir(dbFalso((sql) => (sql.startsWith("SELECT * FROM entries WHERE 1=1") ? { rows: [linha] } : undefined)));
  try {
    const me = await s.chamar("GET", "/api/auth/me", { headers: BEARER });
    assert.deepEqual(me.json, { autenticado: true, origem: "mcp" });
    const r = await s.chamar("GET", "/api/entries?type=note&search=T", { headers: BEARER });
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 1);
    assert.deepEqual(Object.keys(r.json.entries[0]),
      ["id", "type", "title", "content", "tags", "date", "time", "pinned", "threads", "createdAt", "updatedAt"]);
    const consulta = s.db.chamadas.at(-1);
    assert.deepEqual(consulta.params, ["note", "%t%"]);
    await esperarLogs();
    const req = logs.filter((l) => l.evento === "HTTP_REQ").at(-1);
    assert.deepEqual([req.nivel, req.metodo, req.rota, req.status, req.origem], ["info", "GET", "/api/entries", 200, "mcp"]);
  } finally { await s.fechar(); }
});

// ─── Login ───
test("login com senha errada → 401 cinco vezes; a sexta tentativa → 429, mesmo com a senha certa", async () => {
  const s = await subir();
  try {
    for (let i = 1; i <= 5; i++) {
      const r = await s.chamar("POST", "/api/auth/login", { headers: JSON_CT, body: JSON.stringify({ senha: `errada ${i}` }) });
      assert.equal(r.status, 401, `tentativa ${i}`);
      assert.deepEqual(r.json, { error: "nao_autenticado" });
    }
    const sexta = await s.chamar("POST", "/api/auth/login", { headers: JSON_CT, body: JSON.stringify({ senha: SENHA }) });
    assert.equal(sexta.status, 429);
    assert.deepEqual(sexta.json, { error: "muitas_tentativas" });
    assert.ok(Number(sexta.headers.get("retry-after")) > 0);
    assert.equal(sexta.headers.get("set-cookie"), null);
    const falhas = logs.filter((l) => l.evento === "AUTH_LOGIN_FALHA").map((l) => l.motivo);
    assert.deepEqual(falhas, ["SENHA_ERRADA", "SENHA_ERRADA", "SENHA_ERRADA", "SENHA_ERRADA", "SENHA_ERRADA", "LIMITE_IP"]);
    assert.ok(!JSON.stringify(logs).includes("errada 1"), "a senha tentada nunca vai ao log");
  } finally { await s.fechar(); }
});

test("rajada concorrente de logins errados não passa do teto: a tentativa em voo já conta", async () => {
  const N = 50;
  let s = await subir();
  const errada = (i, headers = {}) => s.chamar("POST", "/api/auth/login", {
    headers: { ...JSON_CT, ...headers }, body: JSON.stringify({ senha: `rajada ${i}` }),
  });
  try {
    // mesmo IP: a régua por IP (5) segura a rajada inteira, antes de qualquer scrypt terminar
    const mesmoIp = await Promise.all(Array.from({ length: N }, (_, i) => errada(i)));
    const status = mesmoIp.map((r) => r.status);
    assert.equal(status.filter((x) => x === 401).length, 5, "só 5 senhas chegam a ser testadas");
    assert.equal(status.filter((x) => x === 429).length, N - 5);
    const depois = await s.chamar("POST", "/api/auth/login", { headers: JSON_CT, body: JSON.stringify({ senha: SENHA }) });
    assert.equal(depois.status, 429, "a senha certa também espera a janela");
  } finally { await s.fechar(); }

  s = await subir();
  try {
    // IP variando (X-Forwarded-For, trust proxy): o teto global (30) segura
    const ipsVariados = await Promise.all(Array.from({ length: N }, (_, i) => errada(i, { "X-Forwarded-For": `10.0.${i}.1` })));
    const status = ipsVariados.map((r) => r.status);
    assert.ok(status.filter((x) => x === 401).length <= 30, "no máximo 30 senhas testadas por hora");
    assert.equal(status.filter((x) => x === 401).length, 30);
    assert.equal(status.filter((x) => x === 429).length, N - 30);
    assert.ok(logs.some((l) => l.evento === "AUTH_LOGIN_FALHA" && l.motivo === "LIMITE_GLOBAL"));
  } finally { await s.fechar(); }
});

test("login certo → 204 + cookie HttpOnly; Secure; SameSite=Lax; 30 dias — e o cookie autentica", async () => {
  const s = await subir();
  try {
    const r = await s.chamar("POST", "/api/auth/login", { headers: JSON_CT, body: JSON.stringify({ senha: SENHA }) });
    assert.equal(r.status, 204);
    const setCookie = r.headers.get("set-cookie");
    assert.match(setCookie, /^fields_s=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=2592000/);
    assert.match(setCookie, /Path=\//);
    assert.ok(logs.some((l) => l.evento === "AUTH_LOGIN_OK"));

    const cookie = setCookie.split(";")[0];
    const me = await s.chamar("GET", "/api/auth/me", { headers: { Cookie: cookie } });
    assert.deepEqual(me.json, { autenticado: true, origem: "web" });

    const sair = await s.chamar("POST", "/api/auth/logout", { headers: { Cookie: cookie, ...JSON_CT } });
    assert.equal(sair.status, 204);
    assert.match(sair.headers.get("set-cookie"), /^fields_s=;.*Expires=Thu, 01 Jan 1970/);
  } finally { await s.fechar(); }
});

test("login sem senha → 400 e não conta como tentativa", async () => {
  const s = await subir();
  try {
    for (let i = 0; i < 6; i++) {
      const r = await s.chamar("POST", "/api/auth/login", { headers: JSON_CT, body: "{}" });
      assert.equal(r.status, 400);
    }
    const ok = await s.chamar("POST", "/api/auth/login", { headers: JSON_CT, body: JSON.stringify({ senha: SENHA }) });
    assert.equal(ok.status, 204);
  } finally { await s.fechar(); }
});

test("cookie adulterado ou expirado → 401", async () => {
  const s = await subir();
  try {
    const [payload, sig] = emitirCookieSessao(config.segredoSessao).split(".");
    const adulterado = await s.chamar("GET", "/api/auth/me", { headers: { Cookie: `fields_s=${payload}x.${sig}` } });
    assert.equal(adulterado.status, 401);
    const velho = emitirCookieSessao(config.segredoSessao, Date.now() - 31 * 24 * 3600 * 1000);
    const expirado = await s.chamar("GET", "/api/auth/me", { headers: { Cookie: `fields_s=${velho}` } });
    assert.equal(expirado.status, 401);
    assert.equal(logs.filter((l) => l.evento === "AUTH_NEGADO").at(-1).motivo, "COOKIE_EXPIRADO");
  } finally { await s.fechar(); }
});

// ─── CSRF ───
test("mutação por cookie com text/plain → 415, sem tocar o banco", async () => {
  const s = await subir();
  try {
    const cookie = `fields_s=${emitirCookieSessao(config.segredoSessao)}`;
    const corpo = JSON.stringify({ title: "x", content: "y" });
    const r = await s.chamar("POST", "/api/entries", { headers: { Cookie: cookie, "Content-Type": "text/plain" }, body: corpo });
    assert.equal(r.status, 415);
    assert.deepEqual(r.json, { error: "content_type_invalido" });
    const del = await s.chamar("DELETE", `/api/entries/${randomUUID()}`, { headers: { Cookie: cookie } });
    assert.equal(del.status, 415, "DELETE sem Content-Type também é mutação");
    assert.equal(s.db.chamadas.length, 0);
    assert.equal(logs.find((l) => l.evento === "AUTH_NEGADO").motivo, "CONTENT_TYPE_NAO_JSON");

    // com application/json passa e chega à regra da rota (corpo legado de hoje)
    const ok = await s.chamar("POST", "/api/entries", { headers: { Cookie: cookie, "Content-Type": "application/json; charset=utf-8" }, body: "{}" });
    assert.equal(ok.status, 400);
    assert.deepEqual(ok.json, { error: "title and content are required" });
  } finally { await s.fechar(); }
});

test("Bearer é isento da exigência de JSON", async () => {
  const s = await subir();
  try {
    const r = await s.chamar("DELETE", `/api/tasks/${randomUUID()}`, { headers: BEARER });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { success: true });
  } finally { await s.fechar(); }
});

// ─── Erros ───
test("500 nunca devolve nem loga a mensagem do erro", async () => {
  const s = await subir(dbFalso(() => { throw new Error("invalid input syntax: DADO-SENSIVEL-123"); }));
  try {
    const r = await s.chamar("GET", "/api/entries", { headers: BEARER });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: "erro_interno" });
    assert.ok(!r.texto.includes("DADO-SENSIVEL"));
    await esperarLogs();
    const erro = logs.find((l) => l.evento === "HTTP_ERRO");
    assert.equal(erro.rota, "/api/entries");
    assert.equal(erro.erro, "Error");
    assert.ok(!JSON.stringify(logs).includes("DADO-SENSIVEL"), "a mensagem não vai ao log");
  } finally { await s.fechar(); }
});

test("JSON malformado → 400 json_invalido (não 500)", async () => {
  const s = await subir();
  try {
    const r = await s.chamar("POST", "/api/entries", { headers: { ...BEARER, ...JSON_CT }, body: "{nao é json" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "json_invalido" });
  } finally { await s.fechar(); }
});

test("respostas legadas de recusa continuam byte a byte", async () => {
  const s = await subir();
  const h = { headers: { ...BEARER, ...JSON_CT } };
  try {
    const casos = [
      ["GET", `/api/entries/${randomUUID()}`, undefined, 404, { error: "Not found" }],
      ["DELETE", `/api/entries/${randomUUID()}`, undefined, 404, { error: "Not found" }],
      ["PATCH", `/api/entries/${randomUUID()}`, "{}", 404, { error: "Not found" }],
      ["POST", "/api/projects", "{}", 400, { error: "name required" }],
      ["PATCH", `/api/projects/${randomUUID()}`, "{}", 400, { error: "nothing to update" }],
      ["POST", `/api/projects/${randomUUID()}/frentes`, "{}", 400, { error: "name required" }],
      ["PATCH", `/api/frentes/${randomUUID()}`, "{}", 400, { error: "nothing to update" }],
      ["POST", `/api/frentes/${randomUUID()}/tasks`, "{}", 400, { error: "name required" }],
      ["PATCH", `/api/tasks/${randomUUID()}`, "{}", 400, { error: "nothing to update" }],
      ["POST", "/api/meetings", JSON.stringify({ title: "x" }), 400, { error: "title and date required" }],
      ["PATCH", `/api/meetings/${randomUUID()}`, JSON.stringify({ title: "x" }), 404, { error: "Not found" }],
      ["PATCH", `/api/projects/${randomUUID()}`, JSON.stringify({ name: "x" }), 200, { success: true }],
      ["DELETE", `/api/projects/${randomUUID()}`, undefined, 200, { success: true }],
    ];
    for (const [metodo, caminho, body, status, json] of casos) {
      const r = await s.chamar(metodo, caminho, { ...h, body });
      assert.equal(r.status, status, `${metodo} ${caminho}`);
      assert.deepEqual(r.json, json, `${metodo} ${caminho}`);
    }
  } finally { await s.fechar(); }
});

// ─── Correções de bug ───
test("PATCH /api/tasks/:id manda comments ao jsonb como JSON, não como array do Postgres", async () => {
  const s = await subir();
  try {
    const comments = [{ id: "c1", text: "primeiro comentário", createdAt: "2026-10-03T12:00:00.000Z" }];
    const r = await s.chamar("PATCH", `/api/tasks/${randomUUID()}`, {
      headers: { ...BEARER, ...JSON_CT }, body: JSON.stringify({ comments, status: "Em andamento" }),
    });
    assert.equal(r.status, 200);
    const update = s.db.chamadas.find((c) => c.sql.startsWith("UPDATE tasks"));
    assert.match(update.sql, /status = \$1,comments = \$2 WHERE id=\$3/);
    assert.equal(typeof update.params[1], "string");
    assert.deepEqual(JSON.parse(update.params[1]), comments);
  } finally { await s.fechar(); }
});

test("POST /api/meetings grava o must", async () => {
  const s = await subir(dbFalso((sql, params) => {
    if (sql.startsWith("SELECT * FROM meetings WHERE id")) {
      return { rows: [{ id: params[0], title: "R", date: "2026-10-05", start_time: "10:00", end_time: "", description: "", comments: [], must: "levar números", created_at: new Date() }] };
    }
  }));
  try {
    const r = await s.chamar("POST", "/api/meetings", {
      headers: { ...BEARER, ...JSON_CT }, body: JSON.stringify({ title: "R", date: "2026-10-05", start_time: "10:00", must: "levar números" }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.meeting.must, "levar números");
    const insert = s.db.chamadas.find((c) => c.sql.startsWith("INSERT INTO meetings"));
    assert.match(insert.sql, /must\) VALUES/);
    assert.equal(insert.params.at(-1), "levar números");
  } finally { await s.fechar(); }
});

test("POST /api/entries sem data usa o hoje de Brasília", async () => {
  const { hojeISO } = await import("../src/lib/datas.js");
  const s = await subir(dbFalso((sql, params) => (sql.startsWith("SELECT * FROM entries WHERE id") ? { rows: [linhaEntrada(params[0])] } : undefined)));
  try {
    const r = await s.chamar("POST", "/api/entries", { headers: { ...BEARER, ...JSON_CT }, body: JSON.stringify({ title: " T ", content: " C " }) });
    assert.equal(r.status, 201);
    const insert = s.db.chamadas.find((c) => c.sql.startsWith("INSERT INTO entries"));
    assert.equal(insert.params[2], "T");
    assert.equal(insert.params[5], hojeISO());
  } finally { await s.fechar(); }
});

// ─── Guardas reflexivas ───
test("as URLs são exatamente as de antes, mais as três de auth", async () => {
  const s = await subir();
  try {
    const rotas = s.app.locals.rotas.map((r) => `${r.metodo} ${r.template}`).sort();
    assert.deepEqual(rotas, [
      "DELETE /api/entries/:id", "DELETE /api/frentes/:id", "DELETE /api/meetings/:id",
      "DELETE /api/projects/:id", "DELETE /api/tasks/:id",
      "GET /api/auth/me", "GET /api/entries", "GET /api/entries/:id", "GET /api/entries/stats",
      "GET /api/entries/upcoming", "GET /api/health", "GET /api/meetings", "GET /api/projects",
      "PATCH /api/entries/:id", "PATCH /api/frentes/:id", "PATCH /api/meetings/:id",
      "PATCH /api/projects/:id", "PATCH /api/tasks/:id",
      "POST /api/auth/login", "POST /api/auth/logout", "POST /api/entries",
      "POST /api/frentes/:frenteId/tasks", "POST /api/meetings", "POST /api/projects",
      "POST /api/projects/:projectId/frentes",
    ]);
  } finally { await s.fechar(); }
});

test("toda rota fora de ROTAS_PUBLICAS responde 401 sem credencial", async () => {
  assert.deepEqual([...ROTAS_PUBLICAS], ["GET /api/health", "POST /api/auth/login"], "a guarda da guarda");
  const s = await subir();
  try {
    for (const { metodo, template } of s.app.locals.rotas) {
      if (ROTAS_PUBLICAS.includes(`${metodo} ${template}`)) continue;
      const caminho = template.replace(/:[A-Za-z]+/g, randomUUID());
      const r = await s.chamar(metodo, caminho, { headers: JSON_CT, body: metodo === "GET" ? undefined : "{}" });
      assert.equal(r.status, 401, `${metodo} ${template}`);
    }
    assert.equal(s.db.chamadas.length, 0);
  } finally { await s.fechar(); }
});

test("sem CORS: nenhum cabeçalho Access-Control, nem no preflight", async () => {
  const s = await subir();
  try {
    const r = await s.chamar("GET", "/api/health", { headers: { Origin: "https://evil.example" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    const pre = await s.chamar("OPTIONS", "/api/entries", {
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
    assert.notEqual(pre.status, 200);
  } finally { await s.fechar(); }
});

test("rota desconhecida autenticada → 404, logada como nao_roteada", async () => {
  const s = await subir();
  try {
    const r = await s.chamar("GET", "/api/nada/aqui", { headers: BEARER });
    assert.equal(r.status, 404);
    await esperarLogs();
    assert.equal(logs.find((l) => l.evento === "HTTP_REQ").rota, "nao_roteada");
  } finally { await s.fechar(); }
});
