// A loja do webhook do WhatsApp em memória — a mesma forma de servicos/whatsapp.lojaEventosSql(db),
// para o teste da rota rodar sem Postgres. A resposta guardada passa por JSON (ida e volta), como a
// coluna jsonb: o teste do "mesmo corpo" não compara o mesmo objeto por referência.

import { EVENTO_CONCLUIDO, EVENTO_EM_VOO } from "../../src/dominio/enums.js";

export function eventosEmMemoria() {
  const linhas = new Map();
  const canais = new Map();
  const copia = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  return {
    linhas,
    canais,
    async reservar(eventId) {
      const l = linhas.get(eventId);
      if (!l) {
        linhas.set(eventId, { status: EVENTO_EM_VOO, resposta: null, turnoId: null, tentativas: 1 });
        return { nova: true };
      }
      l.tentativas++;
      return { nova: false, status: l.status, resposta: copia(l.resposta), turnoId: l.turnoId };
    },
    async obter(eventId) {
      const l = linhas.get(eventId);
      return l ? { status: l.status, resposta: copia(l.resposta), turnoId: l.turnoId } : null;
    },
    async concluir(eventId, { resposta, turnoId = null }) {
      const l = linhas.get(eventId);
      if (l) Object.assign(l, { status: EVENTO_CONCLUIDO, resposta: copia(resposta ?? {}), turnoId });
    },
    /** A rajada: grava como CONCLUIDO {} os wamids novos e devolve só eles (os já vistos tiveram POST). */
    async absorver(eventIds) {
      const novos = [];
      for (const id of new Set(eventIds)) {
        if (linhas.has(id)) continue;
        linhas.set(id, { status: EVENTO_CONCLUIDO, resposta: {}, turnoId: null, tentativas: 1 });
        novos.push(id);
      }
      return novos;
    },
    async gravarCanal({ waId, conversationId, botId = null }) {
      canais.set(waId, { conversationId, botId });
    },
  };
}
