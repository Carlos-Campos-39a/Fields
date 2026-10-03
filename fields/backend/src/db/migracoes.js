// Migrações de DADO, one-shot, registradas na tabela `migracoes` (o nome é a chave; a linha é o
// "já rodou"). Rodam no boot, depois do schema e do seed.
//
// POLÍTICA DE FALHA — o oposto do schema: uma migração de dado que falha NÃO derruba o servidor.
// Volta atrás inteira (uma transação só), loga MIGRACAO_FALHOU e o boot segue; o app recebe no
// `estado` que ela não rodou e trabalha no modo anterior. Trocar "comentário que não migrou", que
// tem backup e conserto, por "Fields fora do ar" é estritamente pior. A próxima subida tenta de novo.
//
// comentarios_v1 — copia entries.threads, tasks.comments e meetings.comments para `comentarios`:
//   - preserva id, texto e data; o que falta é REPARADO e contado (sem id → uuid; sem data → a data
//     de criação do pai), nunca descartado;
//   - id que já existe (os ids legados de entrada e reunião são Date.now(), únicos só dentro do
//     próprio array) vai com `${alvo_tipo}:${alvo_id}:${id}` — nenhum comentário cai por colisão;
//   - confere DENTRO da transação que a tabela tem exatamente os itens das fontes (total por alvo e
//     por linha); divergência lança, e o ROLLBACK desfaz a cópia;
//   - as colunas jsonb NÃO são tocadas: ficam como backup.
// Depois dela não há rollback limpo: a versão A0 voltaria a ler o jsonb congelado no instante da
// migração — sem os comentários criados depois, e com os excluídos depois de volta.
//
// E o que a A0 escrever no jsonb depois da migração — a instância antiga durante a troca de deploy,
// ou um rollback do Railway para a A0 — é REPARADO na volta (repararDivergencia): no boot e mais
// uma vez REPARO_POS_DEPLOY_MS depois de abrir a porta (server.js). O reparo é só ADITIVO: recupera
// as INCLUSÕES feitas na A0, não as exclusões nem as edições. Um comentário apagado durante um
// rollback para a A0 reaparece na volta para a A1 — reaparecer é melhor que sumir.

import { tx } from "./pool.js";
import { log } from "../lib/log.js";
import { ALVOS_COMENTARIO } from "../dominio/enums.js";
import { COLUNA_LEGADA, itensDaColunaLegada, lerItemLegado } from "../dominio/comentarios_legado.js";
import { CAMPOS_AUDITADOS_COMENTARIO, inserirSemPerder } from "../servicos/comentarios.js";
import { registrar } from "../servicos/historico.js";

export const MIGRACAO_COMENTARIOS = "comentarios_v1";

// O Railway mantém o deploy anterior servindo até o healthcheck do novo passar (healthcheckTimeout
// = 60 s, railway.toml) e só então o desliga. Dois minutos depois de abrir a porta, a sobreposição
// acabou: o que a instância antiga ainda gravou no jsonb já está lá para o reparo achar.
export const REPARO_POS_DEPLOY_MS = 120_000;

// Quem grava a linha recuperada é o próprio servidor; quem escreveu o texto, o jsonb nunca guardou.
const CTX_SISTEMA = Object.freeze({ origem: "sistema", turnoId: null });

const PG_CODIGO = /^[0-9A-Z]{5}$/; // SQLSTATE: seguro de logar, ao contrário da mensagem do pg
const CHAVE_LOG = Object.freeze({ ENTRADA: "entradas", TAREFA: "tarefas", REUNIAO: "reunioes" });

/** Recusa da própria migração (dado ilegível, contagem que não fecha). `detalhes` vai ao log: sem texto nem id. */
export class ErroMigracao extends Error {
  constructor(motivo, detalhes = {}) {
    super(`migração recusada: ${motivo}`);
    this.name = "ErroMigracao";
    this.motivo = motivo;
    this.detalhes = detalhes;
  }
}

export async function migracaoAplicada(db, nome) {
  const { rows } = await db.query("SELECT 1 FROM migracoes WHERE nome = $1", [nome]);
  return rows.length > 0;
}

/** Todas as migrações de dado, em ordem. Devolve o `estado` do app (congelado). */
export async function aplicarMigracoes(db) {
  const comentariosMigrados = await migrarComentarios(db);
  return Object.freeze({ comentariosMigrados });
}

const porAlvo = (contagem) =>
  Object.fromEntries(ALVOS_COMENTARIO.map((alvo) => [CHAVE_LOG[alvo], contagem[alvo] ?? 0]));
const soma = (contagem) => Object.values(contagem).reduce((a, n) => a + n, 0);

/**
 * true → `comentarios` é a verdade; false → modo legado (a migração falhou e voltou atrás).
 * Só LANÇA quando nem dá para saber em que estado o banco está (a leitura de `migracoes` falhou):
 * aí o boot cai, como em qualquer falha de banco no boot — adivinhar o modo seria pior.
 */
export async function migrarComentarios(db) {
  const nome = MIGRACAO_COMENTARIOS;
  if (await migracaoAplicada(db, nome)) {
    log.info("MIGRACAO_JA_APLICADA", { nome });
    await repararDivergencia(db, { momento: "boot" });
    return true;
  }

  const inicio = process.hrtime.bigint();
  let resumo;
  try {
    resumo = await tx(db, (c) => copiarComentarios(c, nome));
  } catch (err) {
    log.erro("MIGRACAO_FALHOU", {
      nome,
      erro: err?.name ?? typeof err,
      pg_codigo: PG_CODIGO.test(err?.code ?? "") ? err.code : undefined,
      motivo: err instanceof ErroMigracao ? err.motivo : undefined,
      ...(err instanceof ErroMigracao ? err.detalhes : {}),
    });
    // O COMMIT pode ter chegado ao banco e a resposta não: o modo sai do banco, não do palpite.
    const aplicada = await migracaoAplicada(db, nome);
    if (aplicada) log.warn("MIGRACAO_CONFIRMADA_APOS_ERRO", { nome });
    return aplicada;
  }

  if (resumo.concorrente) {
    log.info("MIGRACAO_JA_APLICADA", { nome, concorrente: true });
    return true;
  }

  // Os avisos saem DEPOIS do COMMIT: log de algo que voltou atrás mente.
  if (soma(resumo.remapeados) > 0) {
    log.warn("MIGRACAO_COMENTARIO_ID_REMAPEADO", { nome, ...porAlvo(resumo.remapeados) });
  }
  if (soma(resumo.reparos) > 0) {
    // Um campo por tipo de reparo (id_gerado, data_padrao…): ver lerItemLegado.
    const porReparo = Object.fromEntries(Object.entries(resumo.reparos).map(([k, n]) => [k.toLowerCase(), n]));
    log.warn("MIGRACAO_COMENTARIO_REPARADO", { nome, itens: resumo.itensReparados, ...porReparo });
  }
  if (resumo.comExtras > 0) {
    // Chave que não é id/text/data fica só no backup jsonb. Vão os NOMES das chaves, nunca valores.
    log.warn("MIGRACAO_COMENTARIO_CAMPOS_EXTRAS", { nome, itens: resumo.comExtras, campos: resumo.camposExtras });
  }
  log.info("MIGRACAO_APLICADA", {
    nome,
    ...porAlvo(resumo.copiados),
    remapeados: soma(resumo.remapeados),
    reparados: resumo.itensReparados,
    duration_ms: Math.round(Number(process.hrtime.bigint() - inicio) / 1e5) / 10,
  });
  return true;
}

async function copiarComentarios(c, nome) {
  // Duas instâncias subindo juntas não migram duas vezes: a segunda espera a trava, relê e acha a
  // linha. (Sem isso, a segunda copiaria tudo de novo — cada id já gravado pela primeira viraria um
  // alias, um comentário duplicado — até bater no PK de `migracoes` e voltar atrás.)
  // Teto de espera para as travas desta transação. Sem ele, um pedido de trava enfileirado prende
  // toda escrita nova da instância antiga (na fila do Postgres, o ROW EXCLUSIVE seguinte espera atrás
  // do SHARE pendente) enquanto uma transação longa dela não termina. Estourou: a migração volta
  // atrás, o boot segue no modo legado e a próxima subida tenta de novo.
  await c.query("SET LOCAL lock_timeout = '5s'");
  await c.query("LOCK TABLE migracoes IN EXCLUSIVE MODE");
  if (await migracaoAplicada(c, nome)) return { concorrente: true };

  // Congela as fontes durante a cópia. No deploy, a instância ANTIGA continua no ar até o
  // healthcheck da nova passar, e ela escreve nas colunas jsonb: com a trava, essa escrita espera
  // o COMMIT em vez de cair no vão entre o SELECT e o INSERT.
  await c.query("LOCK TABLE entries, tasks, meetings IN SHARE MODE");

  const copiados = { ENTRADA: 0, TAREFA: 0, REUNIAO: 0 };
  const remapeados = { ENTRADA: 0, TAREFA: 0, REUNIAO: 0 };
  const reparos = {};
  const camposExtras = new Set();
  let itensReparados = 0;
  let comExtras = 0;

  // Ordem fixa (alvo; dentro dele, pai mais antigo primeiro): numa colisão de id, quem fica com o
  // id original é sempre o mesmo, rodada após rodada.
  for (const alvoTipo of ALVOS_COMENTARIO) {
    const { tabela, coluna } = COLUNA_LEGADA[alvoTipo];
    const { rows } = await c.query(`SELECT id, ${coluna} AS legado, created_at FROM ${tabela} ORDER BY created_at, id`);
    for (const pai of rows) {
      const coluna_ = itensDaColunaLegada(pai.legado);
      if (!coluna_.ok) throw new ErroMigracao(coluna_.motivo, { alvo_tipo: alvoTipo });
      for (const item of coluna_.itens) {
        const lido = lerItemLegado(alvoTipo, item, { dataPadrao: pai.created_at });
        if (!lido.ok) throw new ErroMigracao(lido.motivo, { alvo_tipo: alvoTipo });

        // origem 'sistema': quem gravou a LINHA foi a migração; quem escreveu o texto (front ou
        // MCP) o array legado nunca guardou.
        const { remapeado } = await inserirSemPerder(c, {
          alvoTipo, alvoId: pai.id, id: lido.id, texto: lido.texto, criadoEm: lido.criadoEm, origem: "sistema",
        });
        copiados[alvoTipo]++;
        if (remapeado) remapeados[alvoTipo]++;
        if (lido.reparos.length) itensReparados++;
        for (const r of lido.reparos) reparos[r] = (reparos[r] ?? 0) + 1;
        if (lido.extras.length) {
          comExtras++;
          for (const k of lido.extras) if (camposExtras.size < 10) camposExtras.add(String(k).slice(0, 40));
        }
      }
    }
  }

  await conferirCopia(c, copiados);
  await c.query("INSERT INTO migracoes (nome) VALUES ($1)", [nome]);
  return { concorrente: false, copiados, remapeados, reparos, itensReparados, comExtras, camposExtras: [...camposExtras] };
}

// Expressão SQL do tamanho de um array legado: JSON null conta 0, como o GET sempre mostrou.
const tamanhoSql = (expr) => `(CASE WHEN jsonb_typeof(${expr}) = 'array' THEN jsonb_array_length(${expr}) ELSE 0 END)`;

/**
 * A conferência é feita pelo BANCO, independente do laço que copiou: o total por alvo tem de ser a
 * soma dos arrays das fontes (e o que o laço contou), e cada linha da fonte tem de ter exatamente
 * tantos comentários quantos itens tinha. Qualquer diferença lança → ROLLBACK.
 */
async function conferirCopia(c, copiados) {
  for (const alvoTipo of ALVOS_COMENTARIO) {
    const { tabela, coluna } = COLUNA_LEGADA[alvoTipo];
    const { rows: [fonte] } = await c.query(`SELECT COALESCE(SUM(${tamanhoSql(coluna)}), 0)::int AS n FROM ${tabela}`);
    const { rows: [copia] } = await c.query("SELECT COUNT(*)::int AS n FROM comentarios WHERE alvo_tipo = $1", [alvoTipo]);
    if (fonte.n !== copia.n || copia.n !== copiados[alvoTipo]) {
      throw new ErroMigracao("CONTAGEM_DIVERGENTE", { alvo_tipo: alvoTipo, esperado: fonte.n, copiado: copia.n, contado: copiados[alvoTipo] });
    }
    const { rows: [porLinha] } = await c.query(
      `SELECT COUNT(*)::int AS n FROM ${tabela} f
       WHERE ${tamanhoSql(`f.${coluna}`)} <> (SELECT COUNT(*) FROM comentarios c WHERE c.alvo_tipo = $1 AND c.alvo_id = f.id)`,
      [alvoTipo]
    );
    if (porLinha.n !== 0) throw new ErroMigracao("CONTAGEM_POR_ALVO_DIVERGENTE", { alvo_tipo: alvoTipo, alvos: porLinha.n });
  }
}

/**
 * Itens do backup jsonb sem linha NENHUMA em `comentarios` (nem viva, nem excluída), um por linha,
 * em ordem fixa: alvo; pai mais antigo primeiro; posição no array. O item casa com a linha pelos
 * três ids que inserirSemPerder grava: o original, o alias `${alvo_tipo}:${alvo_id}:${id}` e
 * alias:n. Item sem id fica de fora: na migração ele ganhou um uuid e não há como reconhecê-lo — e
 * todo item que a A0 grava tem id.
 */
function sqlOrfaos() {
  const partes = ALVOS_COMENTARIO.map((alvoTipo, ordem) => {
    const { tabela, coluna } = COLUNA_LEGADA[alvoTipo];
    const prefixo = `'${alvoTipo}:' || f.id || ':' || (item.valor ->> 'id')`;
    return `
      SELECT ${ordem} AS ordem_alvo, '${alvoTipo}' AS alvo_tipo, f.id AS alvo_id, f.created_at AS pai_criado_em,
             item.valor AS item, item.posicao
      FROM ${tabela} f
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(f.${coluna}) = 'array' THEN f.${coluna} ELSE '[]'::jsonb END)
        WITH ORDINALITY AS item(valor, posicao)
      WHERE COALESCE(item.valor ->> 'id', '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM comentarios c
          WHERE c.alvo_tipo = '${alvoTipo}' AND c.alvo_id = f.id
            AND (c.id = item.valor ->> 'id' OR c.id = ${prefixo}
                 OR left(c.id, length(${prefixo} || ':')) = ${prefixo} || ':'))`;
  });
  return `${partes.join("\n      UNION ALL")}
      ORDER BY ordem_alvo, pai_criado_em, alvo_id, posicao`;
}

/**
 * Depois de migrado, as colunas jsonb são backup congelado: este código não escreve nelas. Item do
 * backup sem linha em `comentarios` (nem viva, nem excluída) só existe se alguém escreveu no jsonb
 * DEPOIS da migração — a instância antiga durante a troca de deploy (o LOCK SHARE da migração só
 * adia essa escrita para depois do COMMIT), ou um rollback do Railway para a A0. É comentário que
 * existe e não aparece na tela.
 *
 * O reparo é ADITIVO: grava cada um desses itens como linha nova (origem 'sistema', CRIADO no
 * histórico) e não reescreve o jsonb nem remove nada. É seguro porque nenhuma linha de
 * `comentarios` é apagada de verdade: sem linha nenhuma, o item nunca passou pela tabela. O que o
 * backup não carrega — exclusões e edições feitas na A0 — fica de fora; por isso um comentário
 * apagado na A0 reaparece.
 *
 * Roda no boot de banco já migrado e, uma vez, REPARO_POS_DEPLOY_MS depois de abrir a porta
 * (server.js). Nunca lança: a falha vira MIGRACAO_REPARO_FALHOU, e o boot (ou o processo) segue.
 */
export async function repararDivergencia(db, { momento = "boot" } = {}) {
  const nome = MIGRACAO_COMENTARIOS;
  try {
    // Leitura sem trava primeiro: no caso de todo dia (nada a reparar) ninguém disputa trava.
    const { rows: previa } = await db.query(sqlOrfaos());
    if (previa.length === 0) return;

    const resumo = await tx(db, async (c) => {
      // A MESMA trava da migração. Sem ela, duas instâncias reparando juntas leriam os mesmos
      // órfãos, e a segunda gravaria cada um outra vez com id de alias — um comentário duplicado.
      // Com ela, a segunda espera o COMMIT da primeira e relê: a leitura abaixo é posterior à trava.
      await c.query("SET LOCAL lock_timeout = '5s'"); // mesmo motivo da migração
      await c.query("LOCK TABLE migracoes IN EXCLUSIVE MODE");
      const { rows } = await c.query(sqlOrfaos());
      const recuperados = { ENTRADA: 0, TAREFA: 0, REUNIAO: 0 };
      const ilegiveis = { ENTRADA: 0, TAREFA: 0, REUNIAO: 0 };
      let remapeados = 0;
      let reparados = 0;
      for (const r of rows) {
        const lido = lerItemLegado(r.alvo_tipo, r.item, { dataPadrao: r.pai_criado_em });
        // Ilegível (text que não é string): inventar o texto seria pior que não recuperar. Fica no
        // backup, contado no aviso — e volta a ser contado a cada subida, até alguém olhar.
        if (!lido.ok) { ilegiveis[r.alvo_tipo]++; continue; }
        const { linha, remapeado } = await inserirSemPerder(c, {
          alvoTipo: r.alvo_tipo, alvoId: r.alvo_id, id: lido.id, texto: lido.texto, criadoEm: lido.criadoEm, origem: "sistema",
        });
        await registrar(c, CTX_SISTEMA, {
          entidade_tipo: "COMENTARIO", entidade_id: linha.id, acao: "CRIADO", depois: linha, campos: CAMPOS_AUDITADOS_COMENTARIO,
        });
        recuperados[r.alvo_tipo]++;
        if (remapeado) remapeados++;
        if (lido.reparos.length) reparados++;
      }
      return { recuperados, ilegiveis, remapeados, reparados };
    });

    // Depois do COMMIT: log de algo que voltou atrás mente.
    if (soma(resumo.recuperados) > 0) {
      log.warn("MIGRACAO_COMENTARIO_RECUPERADO", {
        nome, momento, ...porAlvo(resumo.recuperados), remapeados: resumo.remapeados, reparados: resumo.reparados,
      });
    }
    if (soma(resumo.ilegiveis) > 0) {
      // O que sobrou sem conserto: item no backup, sem linha, que o reparo não sabe ler.
      log.warn("MIGRACAO_COMENTARIO_DIVERGENTE", { nome, momento, motivo: "ITEM_INVALIDO", ...porAlvo(resumo.ilegiveis) });
    }
  } catch (err) {
    log.erro("MIGRACAO_REPARO_FALHOU", {
      nome, momento, erro: err?.name ?? typeof err, pg_codigo: PG_CODIGO.test(err?.code ?? "") ? err.code : undefined,
    });
  }
}
