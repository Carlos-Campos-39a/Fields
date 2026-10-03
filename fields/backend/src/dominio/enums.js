// Listas canônicas do domínio — a ÚNICA definição dos valores persistidos. A ontologia (A2), os
// schemas, os rótulos do front e o MCP importam daqui; ninguém repete a lista.
// Na A0 só se exporta: nenhum serviço valida contra estas listas ainda.

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
