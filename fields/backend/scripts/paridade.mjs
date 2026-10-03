#!/usr/bin/env node
// Paridade entre o server.js monolítico (antigo) e o backend dividido (novo).
//
//   node scripts/paridade.mjs <BASE_ANTIGA> <BASE_NOVA> [--bearer TOKEN_NOVA] [--bearer-antiga TOKEN_ANTIGA]
//   ex.: node scripts/paridade.mjs http://localhost:3001 http://localhost:3002 --bearer "$FIELDS_API_TOKEN"
//
// Cada servidor precisa de um banco PRÓPRIO e ZERADO (o seed de 5 entradas roda no primeiro boot).
// Sem --bearer, usa FIELDS_API_TOKEN do ambiente. Só o novo recebe o Bearer.
//
// Roda a MESMA sequência de chamadas nos dois e compara status + JSON depois de normalizar:
// ids viram <id#n> (por ordem de aparição), timestamps viram <ts>, e datas perto do "hoje" de
// cada servidor viram hoje±N — o antigo calcula "hoje" em UTC e o novo em Brasília, então das
// 21h à meia-noite o mesmo seed nasce com datas diferentes; o relativo é o que tem de bater.
// O "hoje" de cada servidor é lido do próprio seed (a entrada "Arquitetura de Agentes LLM").
//
// Saída: tabela PASS / ESPERADO / DIFF por passo. Exit 1 se houver DIFF não declarado.

import { pathToFileURL } from "node:url";

const SEED_HOJE = "Arquitetura de Agentes LLM";
const MUST = "levar os números do trimestre";
// O formato que os clientes reais mandam: id próprio por item (o front usa Date.now()/uuid) e
// created_at em tarefas e reuniões. Um id repetido entre tarefa e reunião é colisão global — a A1
// guarda o segundo com id de alias, de propósito —, e não um caso de paridade.
const COMENTARIOS_TAREFA = [{ id: "c-tarefa-1", text: "comentário de paridade", created_at: "2030-01-01T12:00:00.000Z" }];
const COMENTARIOS_REUNIAO = [{ id: "c-reuniao-1", text: "comentário de paridade", created_at: "2030-01-01T12:00:00.000Z" }];
const ID_INEXISTENTE = "00000000-0000-4000-8000-000000000000";

// ─── Divergências DECLARADAS: o que mudou de propósito na A0 ───
export const DIVERGENCIAS_ESPERADAS = {
  "tarefa-comentarios": {
    motivo: "(a) PATCH /api/tasks/:id com comments: a antiga mandava o array cru ao jsonb → 500; a nova serializa → 200",
    confere: (a, n) => a.status === 500 && n.status === 200 && iguais(n.json, { success: true }),
  },
  "reuniao-criar-com-must": {
    motivo: "(b) POST /api/meetings com must: a antiga descartava (must \"\"); a nova grava",
    confere: (a, n) => a.status === 201 && n.status === 201
      && a.json?.meeting?.must === "" && n.json?.meeting?.must === MUST
      && iguais({ ...a.json.meeting, must: MUST }, n.json.meeting),
  },
  // A mesma chamada mudou duas vezes, e o harness compara as duas trocas: monolítico → A0 e A0 → A1.
  "frente-em-projeto-inexistente": {
    motivo: "(c) projeto inexistente: monolítico → A0, o corpo do 500 deixa de ecoar a mensagem do pg ({error:\"erro_interno\"}); "
      + "A0 → A1, vira 404 {error:\"Not found\"} (o serviço confere o pai antes do INSERT, em vez de estourar na FK)",
    confere: (a, n) => (a.status === 500 && n.status === 500
      && typeof a.json?.error === "string" && iguais(n.json, { error: "erro_interno" }))
      || (a.status === 500 && iguais(a.json, { error: "erro_interno" })
        && n.status === 404 && iguais(n.json, { error: "Not found" })),
  },
};

// ─── A sequência fixa ───
// caminho/corpo recebem o contexto do servidor (ids guardados por ele mesmo).
export const PASSOS = [
  { nome: "health", metodo: "GET", caminho: () => "/api/health" },
  { nome: "entradas-seed", metodo: "GET", caminho: () => "/api/entries",
    depois: (c, j) => { c.hoje = j?.entries?.find((e) => e.title === SEED_HOJE)?.date ?? null; c.qtdSeed = j?.total; } },
  { nome: "entrada-criar", metodo: "POST", caminho: () => "/api/entries",
    corpo: () => ({ type: "note", title: "Paridade nota", content: "conteúdo de paridade", tags: ["Paridade", "TCC"] }),
    depois: (c, j) => { c.entrada = j?.entry?.id; } },
  { nome: "entrada-obter", metodo: "GET", caminho: (c) => `/api/entries/${c.entrada}`, ordenar: ["related"] },
  { nome: "entrada-editar", metodo: "PATCH", caminho: (c) => `/api/entries/${c.entrada}`,
    corpo: () => ({ title: "Paridade nota editada", pinned: true, tags: ["Paridade"] }) },
  { nome: "lembrete-criar", metodo: "POST", caminho: () => "/api/entries",
    corpo: () => ({ type: "reminder", title: "Paridade lembrete", content: "c", date: "2030-01-01", time: "08:00" }),
    depois: (c, j) => { c.lembrete = j?.entry?.id; } },
  { nome: "entradas-por-tipo", metodo: "GET", caminho: () => "/api/entries?type=note" },
  { nome: "entradas-fixadas", metodo: "GET", caminho: () => "/api/entries?type=pinned" },
  { nome: "entradas-busca", metodo: "GET", caminho: () => "/api/entries?search=paridade" },
  { nome: "entradas-proximas", metodo: "GET", caminho: () => "/api/entries/upcoming?limit=10" },
  { nome: "entradas-stats", metodo: "GET", caminho: () => "/api/entries/stats" },
  { nome: "entrada-excluir", metodo: "DELETE", caminho: (c) => `/api/entries/${c.entrada}` },
  { nome: "lembrete-excluir", metodo: "DELETE", caminho: (c) => `/api/entries/${c.lembrete}` },
  { nome: "entrada-inexistente-404", metodo: "GET", caminho: () => `/api/entries/${ID_INEXISTENTE}` },
  { nome: "entrada-excluida-404", metodo: "DELETE", caminho: (c) => `/api/entries/${c.entrada}` },
  { nome: "entrada-sem-titulo-400", metodo: "POST", caminho: () => "/api/entries", corpo: () => ({ content: "sem título" }) },
  { nome: "projeto-criar", metodo: "POST", caminho: () => "/api/projects", corpo: () => ({ name: "Projeto paridade" }),
    depois: (c, j) => { c.projeto = j?.project?.id; } },
  { nome: "projeto-sem-nome-400", metodo: "POST", caminho: () => "/api/projects", corpo: () => ({}) },
  { nome: "frente-criar", metodo: "POST", caminho: (c) => `/api/projects/${c.projeto}/frentes`, corpo: () => ({ name: "Frente paridade" }),
    depois: (c, j) => { c.frente = j?.frente?.id; } },
  { nome: "frente-em-projeto-inexistente", metodo: "POST", caminho: () => `/api/projects/${ID_INEXISTENTE}/frentes`, corpo: () => ({ name: "órfã" }) },
  { nome: "tarefa-criar", metodo: "POST", caminho: (c) => `/api/frentes/${c.frente}/tasks`,
    corpo: () => ({ name: "Tarefa paridade", acao: "Fazer algo", stakeholder: "Fulano", deadline: "2030-02-01", holder: "Nós" }),
    depois: (c, j) => { c.tarefa = j?.task?.id; } },
  { nome: "tarefa-editar-campos", metodo: "PATCH", caminho: (c) => `/api/tasks/${c.tarefa}`,
    corpo: () => ({ status: "Em andamento", kanban_status: "Fazendo", start_date: "2030-01-20", deadline: "2030-02-10", holder: "Eles" }) },
  { nome: "tarefa-editar-vazio-400", metodo: "PATCH", caminho: (c) => `/api/tasks/${c.tarefa}`, corpo: () => ({}) },
  { nome: "projeto-editar", metodo: "PATCH", caminho: (c) => `/api/projects/${c.projeto}`, corpo: () => ({ status: "Pendente", holder: "" }) },
  { nome: "projeto-editar-vazio-400", metodo: "PATCH", caminho: (c) => `/api/projects/${c.projeto}`, corpo: () => ({}) },
  { nome: "frente-editar", metodo: "PATCH", caminho: (c) => `/api/frentes/${c.frente}`, corpo: () => ({ name: "Frente renomeada" }) },
  // A árvore é lida ANTES do comentário: depois dele, os dois servidores divergem de propósito (a).
  { nome: "projetos-arvore", metodo: "GET", caminho: () => "/api/projects" },
  { nome: "tarefa-comentarios", metodo: "PATCH", caminho: (c) => `/api/tasks/${c.tarefa}`, corpo: () => ({ comments: COMENTARIOS_TAREFA }) },
  { nome: "reuniao-criar-com-must", metodo: "POST", caminho: () => "/api/meetings",
    corpo: () => ({ title: "Reunião paridade", date: "2030-03-04", start_time: "10:00", end_time: "11:00", description: "pauta", must: MUST }),
    depois: (c, j) => { c.reuniao = j?.meeting?.id; } },
  { nome: "reuniao-sem-data-400", metodo: "POST", caminho: () => "/api/meetings", corpo: () => ({ title: "sem data" }) },
  { nome: "reuniao-editar", metodo: "PATCH", caminho: (c) => `/api/meetings/${c.reuniao}`, corpo: () => ({ comments: COMENTARIOS_REUNIAO, must: "must editado" }) },
  { nome: "reuniao-inexistente-404", metodo: "PATCH", caminho: () => `/api/meetings/${ID_INEXISTENTE}`, corpo: () => ({ title: "x" }) },
  { nome: "reunioes-intervalo", metodo: "GET", caminho: () => "/api/meetings?from=2030-03-01&to=2030-03-31" },
  { nome: "reunioes-desde", metodo: "GET", caminho: () => "/api/meetings?from=2030-03-01" },
  { nome: "reuniao-excluir", metodo: "DELETE", caminho: (c) => `/api/meetings/${c.reuniao}` },
  { nome: "tarefa-excluir", metodo: "DELETE", caminho: (c) => `/api/tasks/${c.tarefa}` },
  { nome: "frente-excluir", metodo: "DELETE", caminho: (c) => `/api/frentes/${c.frente}` },
  { nome: "projeto-excluir", metodo: "DELETE", caminho: (c) => `/api/projects/${c.projeto}` },
  { nome: "projetos-depois", metodo: "GET", caminho: () => "/api/projects" },
  { nome: "entradas-final", metodo: "GET", caminho: () => "/api/entries" },
];

// ─── Normalização ───
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const CHAVES_TS = new Set(["createdAt", "updatedAt", "created_at", "updated_at"]);
const JANELA_RELATIVA_DIAS = 60;

const diasEntre = (de, ate) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000);

/** Normaliza um JSON de resposta no contexto de UM servidor ({ids: Map, hoje}). */
export function normalizar(valor, ctx, chave = null) {
  if (Array.isArray(valor)) return valor.map((v) => normalizar(v, ctx));
  if (valor && typeof valor === "object") {
    const saida = {};
    for (const [k, v] of Object.entries(valor)) saida[k] = normalizar(v, ctx, k);
    return saida;
  }
  if (typeof valor !== "string") return valor;
  if (CHAVES_TS.has(chave) || (chave === "time" && TIMESTAMP.test(valor))) return "<ts>";
  if (UUID.test(valor) && valor !== ID_INEXISTENTE) {
    if (!ctx.ids.has(valor)) ctx.ids.set(valor, `<id#${ctx.ids.size + 1}>`);
    return ctx.ids.get(valor);
  }
  if (chave === "date" && DATA.test(valor) && ctx.hoje) {
    const n = diasEntre(ctx.hoje, valor);
    if (Math.abs(n) <= JANELA_RELATIVA_DIAS) return n === 0 ? "hoje" : `hoje${n > 0 ? "+" : ""}${n}`;
  }
  return valor;
}

function ordenarPor(json, chaves) {
  if (!json || !chaves) return json;
  const copia = { ...json };
  for (const k of chaves) {
    if (Array.isArray(copia[k])) copia[k] = [...copia[k]].sort((x, y) => String(x.title).localeCompare(String(y.title)));
  }
  return copia;
}

const canonico = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const iguais = (a, b) => canonico(a) === canonico(b);

/** Caminhos onde dois JSON divergem (para o relatório do DIFF). */
export function diferencas(a, b, caminho = "$", saida = []) {
  if (saida.length >= 10) return saida;
  if (iguais(a, b)) return saida;
  const objA = a && typeof a === "object", objB = b && typeof b === "object";
  if (objA && objB && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && a.length !== b.length) saida.push(`${caminho}: tamanho ${a.length} ≠ ${b.length}`);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diferencas(a[k], b[k], `${caminho}.${k}`, saida);
    return saida;
  }
  saida.push(`${caminho}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  return saida;
}

/** PASS | ESPERADO | DIFF, comparando as respostas já normalizadas. */
export function julgar(nome, antiga, nova) {
  if (antiga.status === nova.status && iguais(antiga.json, nova.json)) {
    return { resultado: "PASS", nota: DIVERGENCIAS_ESPERADAS[nome] ? "divergência declarada não ocorreu" : "" };
  }
  const declarada = DIVERGENCIAS_ESPERADAS[nome];
  if (declarada && declarada.confere(antiga, nova)) return { resultado: "ESPERADO", nota: declarada.motivo };
  const status = antiga.status !== nova.status ? [`status: ${antiga.status} ≠ ${nova.status}`] : [];
  return { resultado: "DIFF", nota: [...status, ...diferencas(antiga.json, nova.json)].join("\n      ") };
}

// ─── Execução ───
async function chamar(srv, passo) {
  const corpo = passo.corpo?.(srv.ctx);
  const headers = { ...srv.headers };
  if (corpo !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(srv.base + passo.caminho(srv.ctx), {
    method: passo.metodo, headers, body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const texto = await res.text();
  let json; try { json = texto ? JSON.parse(texto) : null; } catch { json = { nao_json: texto.slice(0, 200) }; }
  passo.depois?.(srv.ctx, json);
  return { status: res.status, json };
}

function argumentos(argv) {
  const pos = []; let bearer = process.env.FIELDS_API_TOKEN; let bearerAntiga = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bearer") bearer = argv[++i];
    else if (argv[i] === "--bearer-antiga") bearerAntiga = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, bearer, bearerAntiga };
}

const baseDe = (url) => url.replace(/\/+$/, "").replace(/\/api$/, "");

async function main() {
  const { pos, bearer, bearerAntiga } = argumentos(process.argv.slice(2));
  if (pos.length !== 2) {
    console.error("uso: node scripts/paridade.mjs <BASE_ANTIGA> <BASE_NOVA> [--bearer TOKEN_NOVA] [--bearer-antiga TOKEN_ANTIGA]");
    process.exit(2);
  }
  if (!bearer) {
    console.error("falta o token do servidor novo: --bearer TOKEN ou FIELDS_API_TOKEN no ambiente");
    process.exit(2);
  }
  // A antiga só recebe Bearer quando ela também exige (A0 em diante): --bearer-antiga.
  const antiga = { nome: "antiga", base: baseDe(pos[0]), headers: bearerAntiga ? { Authorization: `Bearer ${bearerAntiga}` } : {}, ctx: { ids: new Map(), hoje: null } };
  const nova = { nome: "nova", base: baseDe(pos[1]), headers: { Authorization: `Bearer ${bearer}` }, ctx: { ids: new Map(), hoje: null } };

  const linhas = [];
  for (const passo of PASSOS) {
    let ra, rn;
    try {
      ra = await chamar(antiga, passo);
      rn = await chamar(nova, passo);
    } catch (err) {
      console.error(`falha de rede no passo ${passo.nome}: ${err.message}`);
      process.exit(2);
    }
    if (passo.nome === "entradas-seed") {
      for (const srv of [antiga, nova]) {
        if (srv.ctx.qtdSeed !== 5 || !srv.ctx.hoje) {
          console.error(`AVISO: o banco do servidor ${srv.nome} não parece zerado (${srv.ctx.qtdSeed} entradas; seed "${SEED_HOJE}" ${srv.ctx.hoje ? "achado" : "ausente"}).`);
        }
      }
    }
    const na = { status: ra.status, json: normalizar(ordenarPor(ra.json, passo.ordenar), antiga.ctx) };
    const nn = { status: rn.status, json: normalizar(ordenarPor(rn.json, passo.ordenar), nova.ctx) };
    linhas.push({ passo, ra: na, rn: nn, ...julgar(passo.nome, na, nn) });
  }

  const larg = Math.max(...linhas.map((l) => l.passo.nome.length));
  console.log(`\n${"passo".padEnd(larg)}  método  antiga  nova  resultado`);
  console.log("-".repeat(larg + 34));
  for (const l of linhas) {
    console.log(`${l.passo.nome.padEnd(larg)}  ${l.passo.metodo.padEnd(6)}  ${String(l.ra.status).padEnd(6)}  ${String(l.rn.status).padEnd(4)}  ${l.resultado}`);
    if (l.nota) console.log(`      ${l.nota}`);
  }
  const conta = (r) => linhas.filter((l) => l.resultado === r).length;
  console.log(`\nPASS ${conta("PASS")} · ESPERADO ${conta("ESPERADO")} · DIFF ${conta("DIFF")}`);
  process.exit(conta("DIFF") ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
