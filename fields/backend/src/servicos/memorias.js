// A memória do assistente: o que o Carlos PEDIU para ele lembrar ("prefiro resumo curto", "a Ana só
// atende de manhã", "me cobre o relatório no dia 20"). Todo SQL de `memorias` mora aqui.
//
// Não é a conversa (que o motor guarda à parte e expira) e não é regra do sistema: entra no turno
// do usuário como bloco <memoria>, marcado como dito por ele (agente/ontologia.js, _blocoDeMemoria).
//
// Toda recusa devolve MOTIVO, nunca null mudo — e aqui o motivo é o que o assistente vai DIZER:
// "não consegui guardar" não deixa o Carlos agir; "a memória está cheia, qual pode sair?" deixa.
// Esquecer ARQUIVA: a linha continua no banco, com arquivado_em.

import { v4 as uuidv4 } from "uuid";
import { tx } from "../db/pool.js";
import { log } from "../lib/log.js";
import { recusa, sucesso } from "../lib/erros.js";
import { normalizarBusca } from "../lib/texto.js";
import { MEMORIA_ARQUIVADA, MEMORIA_ATIVA } from "../dominio/enums.js";
import { MEMORIAS_ATIVAS_MAX, MEMORIA_TEXTO_MAX } from "../dominio/limites.js";

const ISO_DATA = /^\d{4}-\d{2}-\d{2}$/;

function toMemoria(r) {
  return { memoria_id: r.id, texto: r.texto, lembrar_em: r.lembrar_em ?? null };
}

/** As linhas ATIVAS, da mais antiga à mais nova — o que o motor põe no bloco <memoria> do turno. */
export async function listarAtivas(db, _ctx) {
  const { rows } = await db.query(
    "SELECT * FROM memorias WHERE status = $1 ORDER BY criado_em, id", [MEMORIA_ATIVA]
  );
  return rows.map(toMemoria);
}

/**
 * Guarda uma linha. Recusas: TEXTO_OBRIGATORIO, TEXTO_LONGO_DEMAIS (não trunca: metade de um
 * lembrete seria lida como lembrete inteiro daqui a três semanas), DATA_INVALIDA e MEMORIA_CHEIA
 * (não descarta a mais antiga por conta própria).
 *
 * O teto é contado sob um advisory lock da transação: o MCP e o chat podem pedir ao mesmo tempo, e
 * sem a trava os dois contariam 19 e gravariam a 21ª.
 */
export async function lembrar(db, ctx, { texto, lembrar_em = null } = {}) {
  const limpo = typeof texto === "string" ? texto.trim() : "";
  if (!limpo) return recusa("TEXTO_OBRIGATORIO");
  if (limpo.length > MEMORIA_TEXTO_MAX) {
    log.warn("MEMORIA_LEMBRAR", { motivo: "TEXTO_LONGO_DEMAIS", tamanho: limpo.length, limite: MEMORIA_TEXTO_MAX });
    return { ...recusa("TEXTO_LONGO_DEMAIS"), limite: MEMORIA_TEXTO_MAX };
  }
  if (lembrar_em != null && !ISO_DATA.test(String(lembrar_em))) return recusa("DATA_INVALIDA");

  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('fields:memorias'))");
    const { rows: [{ ativas }] } = await c.query(
      "SELECT COUNT(*)::int AS ativas FROM memorias WHERE status = $1", [MEMORIA_ATIVA]
    );
    if (ativas >= MEMORIAS_ATIVAS_MAX) {
      // Sai antes de qualquer escrita: logar aqui não mente sobre algo que voltou atrás.
      log.warn("MEMORIA_LEMBRAR", { motivo: "MEMORIA_CHEIA", ativas, limite: MEMORIAS_ATIVAS_MAX });
      return { ...recusa("MEMORIA_CHEIA"), limite: MEMORIAS_ATIVAS_MAX };
    }
    const { rows: [linha] } = await c.query(
      `INSERT INTO memorias (id, texto, lembrar_em, origem) VALUES ($1, $2, $3, $4) RETURNING *`,
      [uuidv4(), limpo, lembrar_em, ctx.origem]
    );
    return sucesso(toMemoria(linha));
  });
}

/**
 * Arquiva a linha ATIVA que contém `trecho` (sem caixa e sem acento — o Carlos cita de memória,
 * "aquilo da Ana"). Nenhuma → NAO_ENCONTRADA. Mais de uma → AMBIGUO, com os textos candidatos: o
 * assistente pergunta qual, em vez de arquivar a errada.
 *
 * Por trecho e não por id: a conversa não tem o id na mão, e o prompt proíbe mostrá-lo.
 */
export async function esquecer(db, _ctx, { trecho } = {}) {
  const alvo = normalizarBusca(trecho).trim();
  if (!alvo) return recusa("TRECHO_OBRIGATORIO");

  return tx(db, async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM memorias WHERE status = $1 ORDER BY criado_em, id FOR UPDATE", [MEMORIA_ATIVA]
    );
    const achadas = rows.filter((m) => normalizarBusca(m.texto).includes(alvo));
    if (achadas.length === 0) {
      log.warn("MEMORIA_ESQUECER", { motivo: "NAO_ENCONTRADA", ativas: rows.length });
      return recusa("NAO_ENCONTRADA");
    }
    if (achadas.length > 1) {
      log.warn("MEMORIA_ESQUECER", { motivo: "AMBIGUO", candidatas: achadas.length });
      return { ...recusa("AMBIGUO"), candidatos: achadas.map((m) => m.texto) };
    }
    const { rows: [linha] } = await c.query(
      "UPDATE memorias SET status = $2, arquivado_em = NOW() WHERE id = $1 RETURNING *",
      [achadas[0].id, MEMORIA_ARQUIVADA]
    );
    return sucesso(toMemoria(linha));
  });
}
