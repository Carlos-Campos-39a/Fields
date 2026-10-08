// Busca de texto sem caixa e sem acento — "reuniao" acha "Reunião", "cafe" acha "Café".
//
// Duas metades que precisam concordar: normalizarBusca() no JS (o termo, e a memória, que filtra em
// memória) e sqlSemAcento() no Postgres (as colunas). O Postgres do Railway não tem a extensão
// unaccent, e criá-la exigiria superusuário; o translate() cobre o alfabeto do português e do
// francês, que é o que o Fields guarda.

// Só letras que o NFD decompõe (letra + diacrítico): é o que a metade do JS faz. Ligaduras como œ e
// æ ficam de fora de propósito — o JS não as decompõe, e mapeá-las só aqui faria "cœur" deixar de
// achar "cœur".
const COM_ACENTO = "áàâãäåéèêëíìîïóòôõöúùûüçñýÿ";
const SEM_ACENTO = "aaaaaaeeeeiiiiooooouuuucnyy";

/** Minúsculo e sem diacrítico. null/undefined → "". */
export function normalizarBusca(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Expressão SQL da coluna normalizada. `expr` é SEMPRE um nome de coluna escrito no código, nunca
 * entrada de fora — entra no SQL por interpolação.
 */
export function sqlSemAcento(expr) {
  return `translate(lower(${expr}), '${COM_ACENTO}', '${SEM_ACENTO}')`;
}

/** Padrão LIKE de "contém", com o termo normalizado e os curingas do usuário escapados. */
export function padraoContem(texto) {
  return `%${normalizarBusca(texto).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
