// Listas canônicas do domínio — a ÚNICA definição dos valores persistidos. A ontologia do agente
// (src/agente/ontologia.js), os schemas das ferramentas, os rótulos do front, os CHECKs do banco e
// o MCP importam daqui; ninguém repete a lista.
//
// Os quatro primeiros NÃO viram CHECK nas tabelas da A0: produção já tem linhas gravadas antes de
// qualquer validação, e um ALTER que encontrasse um valor fora da lista derrubaria o boot. Quem os
// valida é a fronteira do agente (schemas.js) — e o mesmo enum é o que a tela mostra.
// Os da A1 em diante viram CHECK no schema (db/schema.js monta a lista SQL a partir daqui).

// Os tipos que têm significado no código ganham nome próprio, e a lista é montada com eles: assim o
// "event" do resumo do dia é o MESMO valor da lista, não uma segunda grafia que alguém esqueceria de
// renomear junto.
export const TIPO_NOTA = "note";
export const TIPO_EVENTO = "event";
export const TIPO_LEMBRETE = "reminder";

/** entries.type */
export const TIPOS_ENTRADA = Object.freeze([TIPO_NOTA, TIPO_EVENTO, TIPO_LEMBRETE, "lang_fr", "lang_jp"]);

/** Os tipos de entrada cuja DATA é um compromisso (o resumo do dia e os próximos compromissos). */
export const TIPOS_AGENDADOS = Object.freeze([TIPO_EVENTO, TIPO_LEMBRETE]);

/**
 * O status que ConcluirTarefa grava. É o único valor de STATUS com semântica no código: o resumo do
 * dia não cobra tarefa concluída.
 */
export const STATUS_CONCLUIDO = "Concluído";

/** projects.status e tasks.status — o ANDAMENTO. Já é texto humano. */
export const STATUS = Object.freeze([
  "Em andamento", "Pendente", "Marcado", "Em definição", "Não iniciado", STATUS_CONCLUIDO,
]);

/** A coluna que ConcluirTarefa grava — concluir move os DOIS eixos (status e coluna). */
export const COLUNA_FEITO = "Feito";

/** tasks.kanban_status — o FLUXO. Eixo independente do status, exceto ao concluir. */
export const COLUNAS_KANBAN = Object.freeze(["A fazer", "Fazendo", "Espera", COLUNA_FEITO]);

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

// ─── A2 · ontologia e agente ───

/**
 * memorias.status. A linha esquecida é ARQUIVADA, nunca apagada: o dado continua no banco, com
 * arquivado_em. Hoje NENHUMA operação lê as arquivadas (e as ativas só chegam ao modelo pelo bloco
 * <memoria> do turno, na tela e no WhatsApp — não pelo MCP); responder "o que eu tinha pedido para
 * você lembrar?" a partir delas exige uma leitura que ainda não existe. Desestruturado da própria
 * lista para não haver segunda grafia.
 */
export const STATUS_MEMORIA = Object.freeze(["ATIVA", "ARQUIVADA"]);
export const [MEMORIA_ATIVA, MEMORIA_ARQUIVADA] = STATUS_MEMORIA;

/**
 * agente_turnos.canal — por onde o pedido entrou. Decide a FORMA da resposta (systemPrompt) e o
 * caminho do desfazer; as ferramentas são as mesmas nos três.
 */
export const CANAIS = Object.freeze(["web", "whatsapp", "mcp"]);

// ─── A2b · motor do agente ───

/**
 * Os canais em que o MOTOR conversa (sessão, histórico, turno com modelo). O MCP fica de fora: lá
 * quem conversa é o Desktop/Cowork, e o turno é uma escrita só (rotas/ops.js).
 */
export const CANAIS_DO_MOTOR = Object.freeze(["web", "whatsapp"]);

/**
 * agente_turnos.status. EM_ANDAMENTO é o turno aberto pelo motor (concluido_em nulo); os quatro
 * finais dizem COMO ele acabou: CONCLUIDO (o modelo respondeu), ESGOTADO (prazo ou limite de
 * chamadas — resposta parcial honesta), FALHOU (erro ou corte) e RECUSADO (o modelo recusou).
 * Sem CHECK no banco: a coluna nasceu na A2 sem ele, e acrescentar um a tabela existente exige
 * migração própria — a lista vale no código, e o teste do motor a cobra.
 */
export const STATUS_TURNO = Object.freeze(["EM_ANDAMENTO", "CONCLUIDO", "ESGOTADO", "FALHOU", "RECUSADO"]);
export const [TURNO_EM_ANDAMENTO, TURNO_CONCLUIDO, TURNO_ESGOTADO, TURNO_FALHOU, TURNO_RECUSADO] = STATUS_TURNO;

/** agente_sessoes.status — uma ATIVA por canal (índice único parcial). */
export const STATUS_SESSAO = Object.freeze(["ATIVA", "ENCERRADA"]);
export const [SESSAO_ATIVA, SESSAO_ENCERRADA] = STATUS_SESSAO;

/** agente_mensagens.role — o que a Messages API aceita no histórico. */
export const ROLES_MENSAGEM = Object.freeze(["user", "assistant"]);
