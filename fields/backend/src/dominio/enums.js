// Listas canônicas do domínio — a ÚNICA definição dos valores persistidos. A ontologia (A2), os
// schemas, os rótulos do front e o MCP importam daqui; ninguém repete a lista.
// Os quatro primeiros ainda não são validados por serviço nenhum (só exportados desde a A0). Os da
// A1 viram CHECK no schema (db/schema.js monta a lista SQL a partir daqui) e validação de rota.

/** entries.type */
export const TIPOS_ENTRADA = Object.freeze(["note", "event", "reminder", "lang_fr", "lang_jp"]);

/** projects.status e tasks.status — o ANDAMENTO. Já é texto humano. */
export const STATUS = Object.freeze([
  "Em andamento", "Pendente", "Marcado", "Em definição", "Não iniciado", "Concluído",
]);

/** tasks.kanban_status — o FLUXO. Eixo independente do status, exceto ao concluir. */
export const COLUNAS_KANBAN = Object.freeze(["A fazer", "Fazendo", "Espera", "Feito"]);

/** projects.holder e tasks.holder. "" é valor REAL em produção: sem holder. */
export const HOLDERS = Object.freeze(["Nós", "Eles", ""]);

// ─── A1 · domínio desfazível ───
// Valor novo em qualquer lista abaixo exige migração própria do CHECK correspondente: o
// CREATE TABLE IF NOT EXISTS não reescreve o CHECK de uma tabela que já existe, e o INSERT com o
// valor novo estoura (23514) em vez de gravar.

/** comentarios.alvo_tipo — o que pode receber comentário. */
export const ALVOS_COMENTARIO = Object.freeze(["ENTRADA", "TAREFA", "REUNIAO"]);

/** historico.entidade_tipo — tudo o que o histórico audita (e o GET /api/historico/:tipo aceita). */
export const ENTIDADES = Object.freeze(["ENTRADA", "PROJETO", "FRENTE", "TAREFA", "REUNIAO", "COMENTARIO"]);

/**
 * historico.origem e comentarios.origem — QUEM escreveu. 'web' e 'mcp' vêm do middleware de auth;
 * 'agente' e 'whatsapp' chegam na A2/A3; 'sistema' é o próprio servidor (a migração de dado).
 */
export const ORIGENS = Object.freeze(["web", "mcp", "agente", "whatsapp", "sistema"]);

/** historico.acao */
export const ACOES_HISTORICO = Object.freeze(["CRIADO", "ATUALIZADO", "EXCLUIDO", "RESTAURADO"]);
