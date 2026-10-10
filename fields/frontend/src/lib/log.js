// Log do front, no mesmo espírito do backend: um evento estável em UPPER_SNAKE (é por ele que se
// procura no console), os valores em campo nomeado, e NUNCA texto do Carlos — título, conteúdo,
// comentário — nem o corpo de uma resposta. Toda recusa e toda falha que a tela engole para não
// quebrar passa por aqui: "não salvou" sem nada no console foi o modo de falha do monólito
// (catch {} e console.error soltos).

import { ApiError, codigoDe } from "../api.js";

/** console.warn com o evento na frente e os campos num objeto. */
export function avisar(evento, mensagem, campos = {}) {
  console.warn(`[${evento}] ${mensagem}`, { evento, ...campos });
}

const avisados = new Set();

/** avisar() uma vez por (evento, campos) — para o que se repete a cada render. */
export function avisarUmaVez(evento, mensagem, campos = {}) {
  const chave = `${evento}:${JSON.stringify(campos)}`;
  if (avisados.has(chave)) return;
  avisados.add(chave);
  avisar(evento, mensagem, campos);
}

/** Os campos seguros de um erro: status e código. A mensagem e o corpo ficam de fora. */
export function camposDoErro(erro) {
  if (erro instanceof ApiError) return { status: erro.status, codigo: erro.codigo };
  return { status: 0, codigo: codigoDe(erro), tipo: erro?.name ?? typeof erro };
}
