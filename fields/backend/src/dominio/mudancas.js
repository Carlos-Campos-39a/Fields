// O diff que o histórico grava: [{campo, de, para}] só com o que MUDOU. Transformação pura, sem
// banco e sem log — testada sem Postgres (test/mudancas.test.js).
//
// A comparação é entre a linha ANTES (SELECT ... FOR UPDATE) e a linha DEPOIS (RETURNING *), nunca
// entre o payload e a linha: o payload traz "2" onde a coluna guarda 2, e um diff contra ele
// registraria mudança onde o banco não mudou nada.

/** Valor como vai para o jsonb: Date vira ISO, undefined vira null; o resto passa como está. */
export function valorDeHistorico(v) {
  if (v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return v;
}

// Forma canônica para COMPARAR: objetos com chaves ordenadas (o jsonb não guarda a ordem das
// chaves, então {a,b} e {b,a} são o mesmo valor), arrays na ordem (a ordem de tags e de
// comentários é dado).
function canonico(v) {
  const x = valorDeHistorico(v);
  if (Array.isArray(x)) return x.map(canonico);
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonico(x[k])]));
  }
  return x;
}

/** Igualdade por valor JSON: arrays e objetos comparados pelo conteúdo, não pela referência. */
export function mesmoValor(a, b) {
  return JSON.stringify(canonico(a)) === JSON.stringify(canonico(b));
}

/**
 * mudancas de um evento do histórico.
 *  - CRIADO: só `para`, um item por campo auditado (é o retrato do nascimento).
 *  - ATUALIZADO: só os campos cujo valor mudou, com `de` e `para`. Nada mudou → [] (e quem chama
 *    não grava evento).
 *  - EXCLUIDO / RESTAURADO: a mudança de deleted_at — é o que diz QUANDO saiu, e o que o desfazer
 *    (A2) confere antes de reverter.
 */
export function calcularMudancas(acao, antes, depois, campos = []) {
  switch (acao) {
    case "CRIADO":
      return campos.map((campo) => ({ campo, para: valorDeHistorico(depois?.[campo]) }));
    case "ATUALIZADO":
      return campos
        .filter((campo) => !mesmoValor(antes?.[campo], depois?.[campo]))
        .map((campo) => ({ campo, de: valorDeHistorico(antes?.[campo]), para: valorDeHistorico(depois?.[campo]) }));
    case "EXCLUIDO":
    case "RESTAURADO":
      if (antes === null && depois === null) return [];
      return [{ campo: "deleted_at", de: valorDeHistorico(antes?.deleted_at), para: valorDeHistorico(depois?.deleted_at) }];
    default:
      throw new TypeError(`calcularMudancas: ação desconhecida (${String(acao)})`);
  }
}
