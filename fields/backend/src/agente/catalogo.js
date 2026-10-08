// O catálogo — a projeção da ontologia para FORA. O CRM não tem este arquivo: lá as ferramentas só
// iam para o LangChain (`bind_tools`). Aqui o mesmo JSON vai a três lugares:
//   - as ferramentas do Claude no motor do chat (ferramentasClaude);
//   - o GET /api/ops, que o servidor MCP lê a cada ListTools (Claude Desktop, Code, Cowork);
//   - o hash `versao`, que muda quando qualquer nome, descrição, schema ou anotação muda.
// Nenhum nome, schema ou enum é escrito aqui: tudo sai de OPERATIONS (a ordem) e de SCHEMAS.

import { createHash } from "node:crypto";
import { z } from "zod";
import { OPERATIONS } from "./ontologia.js";
import { SCHEMAS } from "./schemas.js";
import { INVERSOS } from "./desfazer.js";

// O que sai do JSON Schema — e é contrato com o MCP (GET /api/ops), não só gosto. O catálogo fica
// no subconjunto que o modo strict das ferramentas do Claude aceita: sem restrição numérica
// (minimum, maximum, multipleOf) nem de tamanho de texto ou de lista. Assim, ligar `strict` numa
// operação um dia não muda o texto do schema (nem a `versao`). `pattern` o strict ACEITA, com um
// subconjunto de regex (o HH:MM de schemas.js caberia); sai mesmo assim porque o contrato do
// catálogo o exclui, e a regra de formato chega ao modelo pela descrição do campo. `$schema` é
// ruído. A restrição continua valendo em todos os casos: o zod a aplica em
// executeRead/executeWrite e devolve ARGUMENTOS_INVALIDOS com os campos.
const PALAVRAS_REMOVIDAS = new Set([
  "$schema", "pattern", "minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
]);

// Ordem fixa das chaves de cada nó do schema: o mesmo schema produz sempre o mesmo texto, e o hash
// só muda quando o conteúdo muda. As propriedades de um objeto mantêm a ordem DECLARADA no schema
// (é a ordem em que o modelo lê os campos).
const ORDEM = ["type", "description", "enum", "const", "format", "default", "items", "anyOf", "properties", "required", "additionalProperties"];

function sanitizar(no, { raiz = false } = {}) {
  if (Array.isArray(no)) return no.map((x) => sanitizar(x));
  if (!no || typeof no !== "object") return no;
  // A descrição da RAIZ é a descrição da ferramenta: vai em `description` da operação, não aqui.
  const chaves = Object.keys(no).filter((k) => !PALAVRAS_REMOVIDAS.has(k) && !(raiz && k === "description"));
  const ordenadas = [
    ...ORDEM.filter((k) => chaves.includes(k)),
    ...chaves.filter((k) => !ORDEM.includes(k)).sort(),
  ];
  const out = {};
  for (const k of ordenadas) {
    if (k === "properties") {
      out.properties = Object.fromEntries(Object.entries(no.properties).map(([nome, s]) => [nome, sanitizar(s)]));
    } else if (k === "enum" || k === "required") {
      out[k] = [...no[k]];
    } else {
      out[k] = sanitizar(no[k]);
    }
  }
  // Todo objeto fechado, em qualquer profundidade: o strict exige, e um campo inventado pelo modelo
  // tem de virar erro de schema, não argumento ignorado.
  if (out.type === "object" || "properties" in out) out.additionalProperties = false;
  return out;
}

/** O JSON Schema de entrada de uma ferramenta, já sanitizado. `io: "input"`: default não é obrigatório. */
export function inputSchema(nome) {
  return sanitizar(z.toJSONSchema(SCHEMAS[nome], { io: "input" }), { raiz: true });
}

// O título curto do MCP é o trecho do resumo antes do travessão ("Nova tarefa — criar…").
const tituloDe = (resumo) => resumo.split(" — ")[0].trim();

/**
 * Anotações MCP DERIVADAS da ontologia, nunca declaradas à mão:
 *   readOnlyHint    = é leitura;
 *   destructiveHint = o inverso é RESTAURAR (a escrita exclui);
 *   idempotentHint  = o inverso é REVERTER (repetir a mesma edição dá o mesmo estado);
 *   openWorldHint   = false (nada sai do Fields).
 */
export function anotacoes(op) {
  return {
    readOnlyHint: op.tipo === "READ",
    destructiveHint: INVERSOS[op.name] === "RESTAURAR",
    idempotentHint: INVERSOS[op.name] === "REVERTER",
    openWorldHint: false,
  };
}

function montar(operacoes) {
  const ops = operacoes.map((op) => ({
    name: op.name,
    tipo: op.tipo,
    title: tituloDe(op.resumo),
    description: `${SCHEMAS[op.name].description}\n\n${op.resumo}`,
    input_schema: inputSchema(op.name),
    annotations: anotacoes(op),
  }));
  const versao = createHash("sha256").update(JSON.stringify(ops)).digest("hex");
  return { versao, ops };
}

function congelar(v) {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) congelar(x);
    Object.freeze(v);
  }
  return v;
}

// As operações não mudam sem restart (a flag é lida no import): o catálogo do processo é montado
// uma vez — e congelado, porque é o mesmo objeto para todo consumidor. `operacoes` diferente (os
// testes) monta na hora.
const CATALOGO = congelar(montar(OPERATIONS));

/** {versao, ops} — o corpo do GET /api/ops. */
export function catalogo({ operacoes } = {}) {
  return operacoes ? montar(operacoes) : CATALOGO;
}

// ── O orçamento do `strict`, que é POR REQUISIÇÃO ─────────────────────────────
//
// A documentação de structured outputs ("Schema complexity limits") põe tetos que valem para o
// request inteiro, não para cada schema: no máximo 20 ferramentas com `strict: true`, 24 parâmetros
// opcionais somados em todos os schemas strict, e 16 parâmetros com união (anyOf ou `type` em
// lista). Acima disso o request é recusado inteiro, com 400.
//
// O catálogo inteiro passa longe: 29 ferramentas, 62 opcionais, 3 uniões. Com `strict` em todas, o
// motor pararia em TODOS os canais no dia em que a escrita fosse ligada — e o modo só leitura (10
// ferramentas, 18 opcionais) cabe, o que esconderia o defeito justamente durante o rollout. Por isso
// as ferramentas saem SEM `strict`, como no CRM (bind_tools sem strict): o zod (validarArgs) é a
// autoridade e devolve ARGUMENTOS_INVALIDOS com os campos, que o modelo corrige na rodada seguinte.
//
// Se o `strict` voltar, ele volta por operação, escolhido de forma determinística (a `versao` e o
// cache dependem disso) — e o teste reflexivo mede este orçamento sobre ferramentasClaude() nos dois
// estados da flag, para uma operação nova não estourar o teto em silêncio.
export const LIMITES_STRICT = Object.freeze({ ferramentas: 20, opcionais: 24, unioes: 16 });

/** Quanto do orçamento um conjunto de ferramentas gasta: só as com `strict: true` contam. */
export function orcamentoStrict(ferramentas) {
  const gasto = { ferramentas: 0, opcionais: 0, unioes: 0 };
  const medir = (no) => {
    if (Array.isArray(no)) { no.forEach(medir); return; }
    if (!no || typeof no !== "object") return;
    const obrigatorios = new Set(no.required ?? []);
    for (const [nome, prop] of Object.entries(no.properties ?? {})) {
      if (!obrigatorios.has(nome)) gasto.opcionais++;
      if (prop && (Array.isArray(prop.anyOf) || Array.isArray(prop.type))) gasto.unioes++;
      medir(prop);
    }
    medir(no.items);
    medir(no.anyOf);
  };
  for (const f of ferramentas) {
    if (f.strict !== true) continue;
    gasto.ferramentas++;
    medir(f.input_schema);
  }
  return gasto;
}

/** As ferramentas do Claude (Messages API) — o MESMO dado do catálogo, no formato da API, sem strict. */
export function ferramentasClaude({ operacoes } = {}) {
  return catalogo({ operacoes }).ops.map((op) => ({
    name: op.name, description: op.description, input_schema: op.input_schema,
  }));
}
