// O card "Hoje" da Home: o corpo de GET /api/resumo-do-dia → as linhas que a tela desenha. Puro.
//
// O resumo é o MESMO da ferramenta ResumoDoDia do agente (backend/src/servicos/resumo.js): se o
// card montasse o próprio, ele e o assistente discordariam sobre o que vence hoje. Por isso aqui só
// se arruma para a tela — nada de filtro ou regra de "o que é de hoje".
//   reunioes  [{reuniao_id, titulo, data, inicio, fim, pauta, must}]   (por inicio)
//   tarefas   [{tarefa_id, nome, prazo, frente, projeto, atrasada, …}] (abertas, do dia ou vencidas)
//   lembretes [{entrada_id, tipo, titulo, data, hora, …}]              (eventos e lembretes do dia)

import { dataCurta } from "../lib/dates.js";
import { formatHash } from "../lib/useHashRoute.js";

/** Quantas tarefas o card mostra antes do "e mais N" (o resumo traz até 50, vencidas incluídas). */
export const TAREFAS_NO_CARD = 5;

const lista = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const texto = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** `resultado` do GET → {data, reunioes, tarefas, lembretes}, ou null quando não é um resumo. */
export function normalizarResumo(resultado) {
  if (!resultado || typeof resultado !== "object" || Array.isArray(resultado)) return null;
  return {
    data: texto(resultado.data),
    reunioes: lista(resultado.reunioes),
    tarefas: lista(resultado.tarefas),
    lembretes: lista(resultado.lembretes),
  };
}

const faixa = (inicio, fim) => (inicio ? (fim ? `${inicio}–${fim}` : inicio) : null);

/**
 * O resumo → {compromissos, tarefas, maisTarefas, vazio}. Compromissos = reuniões + eventos e
 * lembretes, juntos pela hora (sem hora vão para o fim); cada linha tem {chave, tipo, hora, titulo,
 * href}. Tarefas: {chave, titulo, caminho, atrasada, prazo, href}, as vencidas primeiro.
 * `agora` só decide se o prazo vencido mostra o ano (lib/dates.js dataCurta).
 */
export function linhasDoHoje(resumo, agora = new Date()) {
  const hrefTarefas = formatHash({ view: "kanban" });
  if (!resumo) return { compromissos: [], tarefas: [], maisTarefas: 0, hrefTarefas, vazio: true };
  const compromissos = [
    ...resumo.reunioes.map((r) => ({
      chave: `reuniao-${r.reuniao_id}`,
      tipo: "reuniao",
      hora: faixa(texto(r.inicio), texto(r.fim)),
      titulo: texto(r.titulo) ?? "Reunião sem título",
      href: formatHash({ view: "agenda" }),
    })),
    ...resumo.lembretes.map((e) => ({
      chave: `entrada-${e.entrada_id}`,
      tipo: typeof e.tipo === "string" ? e.tipo : null,
      hora: texto(e.hora),
      titulo: texto(e.titulo) ?? "Sem título",
      href: e.entrada_id ? formatHash({ view: "notas", id: String(e.entrada_id) }) : formatHash({ view: "notas" }),
    })),
  ].sort((a, b) => {
    if (a.hora && b.hora) return a.hora.localeCompare(b.hora);
    return a.hora ? -1 : b.hora ? 1 : 0;
  });

  const ordenadas = [...resumo.tarefas].sort((a, b) => Number(Boolean(b.atrasada)) - Number(Boolean(a.atrasada)));
  const tarefas = ordenadas.slice(0, TAREFAS_NO_CARD).map((t) => ({
    chave: `tarefa-${t.tarefa_id}`,
    titulo: texto(t.nome) ?? "Tarefa sem nome",
    caminho: [texto(t.projeto), texto(t.frente)].filter(Boolean).join(" › ") || null,
    atrasada: Boolean(t.atrasada),
    prazo: t.atrasada && t.prazo ? dataCurta(t.prazo, agora) : null,
    href: hrefTarefas,
  }));

  return {
    compromissos,
    tarefas,
    maisTarefas: Math.max(0, ordenadas.length - tarefas.length),
    hrefTarefas,
    vazio: compromissos.length === 0 && ordenadas.length === 0,
  };
}

const dataLonga = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });

/** "2026-10-10" → "sábado, 10 de outubro". Dia de calendário: formatado em UTC puro (lib/dates.js). */
export function rotuloDoDia(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "";
  return dataLonga.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}
