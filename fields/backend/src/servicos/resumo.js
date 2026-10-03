// O resumo do dia e os próximos compromissos. Composição pura dos serviços de cada tabela — nenhum
// SQL aqui (o de cada tabela mora no serviço dela, e a leitura de tarefa passa pelas views).
//
// Um formato só, e três consumidores: a ferramenta ResumoDoDia do agente, o GET /api/resumo-do-dia
// (o card "Hoje" da Home) e, na A4, o resumo da manhã no WhatsApp. Se cada um montasse o seu, o
// card e o assistente discordariam sobre o que vence hoje — e ninguém reportaria isso como defeito.

import { sucesso } from "../lib/erros.js";
import { somarDias } from "../lib/datas.js";
import { TIPOS_AGENDADOS } from "../dominio/enums.js";
import { reuniaoDoAgente } from "./serializadores.js";
import { listarReunioes } from "./reunioes.js";
import { buscarTarefas } from "./tarefas.js";
import { buscarEntradas } from "./entradas.js";

const porHora = (chave) => (a, b) => String(a[chave] ?? "").localeCompare(String(b[chave] ?? ""));

/**
 * O dia `data` (YYYY-MM-DD): reuniões do dia; tarefas abertas que vencem no dia OU já venceram
 * (com `atrasada`); lembretes e eventos do dia. Quem chama resolve o "hoje" (no fuso de Brasília).
 */
export async function resumoDoDia(db, ctx, data) {
  // Em sequência, não em Promise.all: dentro de um tx o `db` é UM cliente, e o pg 8.21+ avisa (o 9
  // recusa) query concorrente no mesmo cliente.
  const reunioes = await listarReunioes(db, ctx, { from: data, to: data });
  const tarefas = await buscarTarefas(db, ctx, { prazoAte: data, abertas: true, limite: 50 });
  const entradas = await buscarEntradas(db, ctx, { tipos: [...TIPOS_AGENDADOS], de: data, ate: data, limite: 50 });
  return sucesso({
    data,
    reunioes: reunioes.map(reuniaoDoAgente).sort(porHora("inicio")),
    tarefas: tarefas.map((t) => ({ ...t, atrasada: t.prazo < data })),
    lembretes: entradas.map(({ trecho: _t, ...e }) => e).sort(porHora("hora")),
  });
}

/** De `de` até `de + dias` (inclusivo): reuniões, eventos/lembretes e prazos de tarefas abertas. */
export async function proximosCompromissos(db, ctx, { de, dias = 7 }) {
  const ate = somarDias(de, dias);
  const reunioes = await listarReunioes(db, ctx, { from: de, to: ate });
  const entradas = await buscarEntradas(db, ctx, { tipos: [...TIPOS_AGENDADOS], de, ate, limite: 50 });
  const prazos = await buscarTarefas(db, ctx, { prazoDe: de, prazoAte: ate, abertas: true, limite: 50 });
  const cronologico = (dataDe, horaDe) => (a, b) =>
    `${a[dataDe] ?? ""} ${a[horaDe] ?? ""}`.localeCompare(`${b[dataDe] ?? ""} ${b[horaDe] ?? ""}`);
  return sucesso({
    de, ate,
    reunioes: reunioes.map(reuniaoDoAgente),
    entradas: entradas.map(({ trecho: _t, ...e }) => e).sort(cronologico("data", "hora")),
    prazos,
  });
}
