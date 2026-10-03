// O formato LEGADO dos comentários — arrays jsonb inteiros dentro da entidade — e a ponte entre ele
// e a tabela `comentarios` (A1). Transformação pura, sem banco e sem log: a migração
// (db/migracoes.js) e o adaptador do PATCH legado (servicos/comentarios.js) usam as mesmas regras,
// e test/comentarios_legado.test.js as cobre sem Postgres.
//
// Cada alvo tinha a SUA chave de data, e o GET de hoje é contrato com o front e com o MCP:
//   entries.threads  = [{id, text, createdAt}]
//   tasks.comments   = [{id, text, created_at}]
//   meetings.comments= [{id, text, created_at}]

import { randomUUID } from "node:crypto";

export const CHAVE_DATA_LEGADA = Object.freeze({ ENTRADA: "createdAt", TAREFA: "created_at", REUNIAO: "created_at" });

/** Onde mora o array legado de cada alvo. Depois da migração ele é BACKUP: ninguém escreve nele. */
export const COLUNA_LEGADA = Object.freeze({
  ENTRADA: Object.freeze({ tabela: "entries", coluna: "threads" }),
  TAREFA: Object.freeze({ tabela: "tasks", coluna: "comments" }),
  REUNIAO: Object.freeze({ tabela: "meetings", coluna: "comments" }),
});

const CHAVES_CONHECIDAS = new Set(["id", "text", "createdAt", "created_at"]);

// Quantos ids derivados se tentam antes de cair num uuid (ver candidatosDeId).
export const MAX_CANDIDATOS = 10;

/** Date | string → ISO ("2026-10-03T12:00:00.000Z"), o formato que o front grava com toISOString(). */
export function isoDe(v) {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

// Data legada aproveitável → ISO; senão null. O ano fica entre 1 e 9999: fora disso o JS aceita e
// o timestamptz do Postgres recusa — e uma recusa dentro da migração derrubaria a rodada inteira.
function dataValida(v) {
  if (typeof v !== "string" && typeof v !== "number") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const ano = d.getUTCFullYear();
  if (ano < 1 || ano > 9999) return null;
  return d.toISOString();
}

/** Linha de `comentarios` → item no formato legado do alvo: mesmas chaves, na ordem que o jsonb devolvia. */
export function paraFormatoLegado(alvoTipo, linha) {
  const chave = CHAVE_DATA_LEGADA[alvoTipo];
  if (!chave) throw new TypeError(`paraFormatoLegado: alvo desconhecido (${String(alvoTipo)})`);
  return { id: linha.id, text: linha.texto, [chave]: isoDe(linha.criado_em) };
}

/** Valor da coluna jsonb → itens. JSON null conta como vazio: é o que o GET sempre mostrou (`?? []`). */
export function itensDaColunaLegada(valor) {
  if (valor === null || valor === undefined) return { ok: true, itens: [] };
  if (!Array.isArray(valor)) return { ok: false, motivo: "COLUNA_NAO_ARRAY" };
  return { ok: true, itens: valor };
}

/**
 * Lê um item legado. Nunca descarta: o que falta é reparado e NOMEADO em `reparos` (quem chama
 * conta e loga); o que não dá para ler — não é objeto, ou `text` não é string — é recusa, porque
 * inventar o texto de um comentário seria pior que não migrar.
 *
 * reparos: ID_NUMERICO (id número vira string), ID_GERADO (sem id → uuid), DATA_OUTRA_CHAVE (a data
 * veio na chave do outro alvo — a paridade da A0 gravou `createdAt` em task), DATA_PADRAO (sem data
 * legível → `dataPadrao`), DATA_REFORMATADA (legível, mas não no formato do toISOString: o instante
 * se preserva, o texto muda).
 */
export function lerItemLegado(alvoTipo, item, { dataPadrao, gerarId = randomUUID } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, motivo: "ITEM_INVALIDO" };
  if (typeof item.text !== "string") return { ok: false, motivo: "ITEM_INVALIDO" };
  const reparos = [];

  let id;
  if (typeof item.id === "string" && item.id !== "") id = item.id;
  else if (typeof item.id === "number" && Number.isFinite(item.id)) { id = String(item.id); reparos.push("ID_NUMERICO"); }
  else { id = gerarId(); reparos.push("ID_GERADO"); }

  const chave = CHAVE_DATA_LEGADA[alvoTipo];
  if (!chave) throw new TypeError(`lerItemLegado: alvo desconhecido (${String(alvoTipo)})`);
  const outra = chave === "createdAt" ? "created_at" : "createdAt";
  let bruto = item[chave];
  if (bruto == null && item[outra] != null) { bruto = item[outra]; reparos.push("DATA_OUTRA_CHAVE"); }
  let criadoEm = dataValida(bruto);
  if (criadoEm === null) {
    criadoEm = isoDe(dataPadrao);
    reparos.push("DATA_PADRAO");
  } else if (criadoEm !== bruto) {
    reparos.push("DATA_REFORMATADA");
  }

  const extras = Object.keys(item).filter((k) => !CHAVES_CONHECIDAS.has(k));
  return { ok: true, id, texto: item.text, criadoEm, reparos, extras };
}

/** O primeiro id derivado: o que a migração usa quando o id original já existe em OUTRO alvo. */
export const aliasDe = (alvoTipo, alvoId, id) => `${alvoTipo}:${alvoId}:${id}`;

/**
 * Ids a tentar, em ordem, para gravar um comentário sem nunca perder nenhum: o original; o alias
 * `${alvo_tipo}:${alvo_id}:${id}` (colisão entre alvos — os ids legados de entrada e reunião são
 * Date.now(), únicos só dentro do próprio array); e `alias:2`, `alias:3`… (o mesmo id repetido no
 * mesmo array). Esgotada a lista, quem grava cai num uuid.
 */
export function candidatosDeId(alvoTipo, alvoId, id) {
  const base = aliasDe(alvoTipo, alvoId, id);
  const lista = [id, base];
  for (let n = 2; lista.length < MAX_CANDIDATOS; n++) lista.push(`${base}:${n}`);
  return lista;
}

/**
 * O adaptador do PATCH legado: o front e o MCP ainda mandam o array INTEIRO; a tabela guarda
 * linha a linha. Compara o array recebido com as linhas do alvo e devolve o plano.
 *
 * O array NÃO tem autoridade de conjunto completo. Os clientes de hoje só expressam dois gestos —
 * "adicionar um" ([...antigos, novo]) e "remover um" (filter) — e vários montam esse array sobre um
 * RETRATO VELHO: o picker de tarefa do QuickCapture e da ThreadSection carrega os projetos uma vez
 * por montagem, a Agenda usa o `meeting.comments` do estado carregado, a ThreadSection guarda
 * `threads` até trocar de entrada, e o MCP faz GET e depois PATCH. O retrato não conhece o que
 * nasceu depois (POST /api/comentarios, o agente da A2, o balão de outra aba) nem o que saiu depois
 * (DELETE /api/comentarios/:id). Ler o array como verdade completa excluiria os primeiros e
 * ressuscitaria os segundos — em silêncio, com a origem de quem mandou o retrato. Por isso a
 * intenção é DERIVADA:
 *   - id do array sem linha no alvo           → inserir (id e data dados; a colisão global é do banco)
 *   - mesmo id com texto diferente            → editar
 *   - id do array com linha EXCLUÍDA no alvo  → NUNCA restaura: ignorado e contado em
 *     `restaurosIgnorados`. O front antigo não tem desfazer de comentário; quem restaura é a API
 *     nova (POST /api/comentarios/:id/restaurar). O item no array é só o retrato de antes da exclusão.
 *   - linha viva cujo id sumiu do array:
 *       · se o array INSERE algo, o gesto é "adicionar": nada é removido, e as que faltam contam em
 *         `remocoesIgnoradas` (é o retrato velho, não um pedido de exclusão);
 *       · senão, o gesto é "remover um": UMA linha faltando é removida (soft) — inclusive o array
 *         vazio que apaga o último —, e MAIS DE UMA é recusa COMENTARIOS_DESATUALIZADOS, sem remover
 *         nenhuma. Nenhum cliente apaga dois de uma vez: duas faltando é retrato velho + o gesto, e
 *         não há como saber qual das duas o usuário apagou.
 * O id do array casa com a linha pelo id ou pelo alias: um comentário remapeado na migração
 * continua sendo reconhecido quando o cliente ainda o manda pelo id antigo.
 * Item repetido no array (o mesmo id duas vezes) vale uma vez só; os demais contam em `duplicados`.
 * Item ilegível → recusa COMENTARIOS_INVALIDOS, antes de qualquer escrita.
 *
 * linhas: TODAS as linhas do alvo, inclusive as excluídas — {id, texto, deleted_at}.
 * Recusa COMENTARIOS_DESATUALIZADOS leva `remocoes` (quantas linhas vivas faltavam) para o log.
 */
export function planejarArrayLegado({ alvoTipo, alvoId, linhas, novos, agora = new Date(), gerarId = randomUUID }) {
  if (!Array.isArray(novos)) return { ok: false, motivo: "COMENTARIOS_INVALIDOS" };
  const lidos = [];
  for (const item of novos) {
    const r = lerItemLegado(alvoTipo, item, { dataPadrao: agora, gerarId });
    if (!r.ok) return { ok: false, motivo: "COMENTARIOS_INVALIDOS" };
    lidos.push(r);
  }

  const porId = new Map(linhas.map((l) => [l.id, l]));
  const casadas = new Set();
  const idsInseridos = new Set();
  const plano = {
    inserir: [], editar: [], remover: [],
    duplicados: 0, camposExtras: 0, remocoesIgnoradas: 0, restaurosIgnorados: 0,
  };

  for (const n of lidos) {
    if (n.extras.length) plano.camposExtras++;
    const linha = porId.get(n.id) ?? porId.get(aliasDe(alvoTipo, alvoId, n.id));
    if (linha) {
      if (casadas.has(linha.id)) { plano.duplicados++; continue; }
      casadas.add(linha.id);
      if (linha.deleted_at) plano.restaurosIgnorados++;
      else if (linha.texto !== n.texto) plano.editar.push({ id: linha.id, de: linha.texto, para: n.texto });
      continue;
    }
    if (idsInseridos.has(n.id)) { plano.duplicados++; continue; }
    idsInseridos.add(n.id);
    plano.inserir.push({ id: n.id, texto: n.texto, criadoEm: n.criadoEm });
  }

  const faltando = linhas.filter((l) => !l.deleted_at && !casadas.has(l.id)).map((l) => ({ id: l.id, texto: l.texto }));
  if (plano.inserir.length > 0) plano.remocoesIgnoradas = faltando.length;
  else if (faltando.length > 1) return { ok: false, motivo: "COMENTARIOS_DESATUALIZADOS", remocoes: faltando.length };
  else plano.remover = faltando;
  return { ok: true, plano };
}
