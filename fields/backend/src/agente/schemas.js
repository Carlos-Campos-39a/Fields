// Schemas das ferramentas do agente — o papel do `schemas.py` do CRM.
//
// A CHAVE de SCHEMAS é o nome da ferramenta que o modelo chama (o mesmo da ontologia), e o
// `.describe()` do objeto é a descrição da ferramenta (a docstring do pydantic no CRM). Cada campo
// também leva `.describe()` em pt-BR: é o que o modelo lê para preencher o argumento, e o que o MCP
// mostra ao Claude Desktop.
//
// Os enums vêm de dominio/enums.js; nenhum valor é repetido aqui. Datas são z.iso.date()
// (AAAA-MM-DD) e horas são "HH:MM" — o formato que o banco guarda desde a A0.
//
// O mesmo schema serve às duas pontas: valida os argumentos em executeRead/executeWrite (o CRM só
// valida escrita; aqui a leitura também passa) e vira JSON Schema no catálogo (catalogo.js). Por
// isso as restrições numéricas, de tamanho e de formato ficam no zod e TAMBÉM na descrição: o
// catálogo tira minimum/maxLength/pattern (o subconjunto do strict, mais o `pattern`, por contrato
// com o MCP — ver PALAVRAS_REMOVIDAS), e o modelo só fica sabendo do limite pelo texto. Quem aplica
// a regra é sempre o zod.

import { z } from "zod";
import { ALVOS_COMENTARIO, COLUNAS_KANBAN, ENTIDADES, HOLDERS, STATUS, TIPOS_ENTRADA } from "../dominio/enums.js";
import { MEMORIA_TEXTO_MAX } from "../dominio/limites.js";
import { TEXTO_MAX as COMENTARIO_TEXTO_MAX } from "../servicos/comentarios.js";

// As mensagens de validação vão ao modelo (e ao MCP) como `campos` do ARGUMENTOS_INVALIDOS. Em
// português ele as repassa sem traduzir — e é o único uso do zod no backend, então a configuração
// global não alcança mais ninguém.
z.config(z.locales.pt());

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const id = (descricao) => z.string().min(1).describe(descricao);
const data = (descricao) => z.iso.date().describe(`${descricao} Formato AAAA-MM-DD.`);
const hora = (descricao) => z.string().regex(HHMM, "use HH:MM (24h)").describe(`${descricao} Formato HH:MM (24h).`);
const texto = (descricao) => z.string().min(1).describe(descricao);
const limite = (max, padrao) =>
  z.number().int().min(1).max(max).describe(`Máximo de itens (1 a ${max}; padrão ${padrao}).`);

const tipoEntrada = z.enum([...TIPOS_ENTRADA]);
const status = z.enum([...STATUS]);
const coluna = z.enum([...COLUNAS_KANBAN]);
const holder = z.enum([...HOLDERS]);

// ── Leitura ───────────────────────────────────────────────────────────────────

const ResumoDoDia = z.strictObject({
  data: data("Dia do resumo. Omita para hoje.").optional(),
}).describe(
  "Resumo de um dia (hoje, por padrão): as reuniões do dia; as tarefas abertas que vencem no dia " +
  "ou já venceram (com `atrasada`); e os lembretes e eventos do dia. Tudo com os ids. É a primeira " +
  "leitura para 'o que tenho hoje?'."
);

const ProximosCompromissos = z.strictObject({
  dias: z.number().int().min(1).max(31).default(7)
    .describe("Quantos dias à frente olhar, a partir de hoje (1 a 31; padrão 7)."),
}).describe(
  "Compromissos dos próximos dias: reuniões, eventos e lembretes com data, e prazos de tarefas " +
  "abertas. Use para 'o que tenho essa semana?' ou para achar um horário livre."
);

const BuscarEntradas = z.strictObject({
  texto: texto("Trecho a procurar no título, no conteúdo ou nas tags (sem caixa e sem acento).").optional(),
  tipo: tipoEntrada.describe("Só entradas deste tipo.").optional(),
  de: data("Só entradas com data a partir deste dia (inclusive).").optional(),
  ate: data("Só entradas com data até este dia (inclusive).").optional(),
  fixadas: z.boolean().describe("true = só as fixadas; false = só as não fixadas. Omita para todas.").optional(),
  limite: limite(50, 20).optional(),
}).describe(
  "Busca notas, eventos e lembretes por texto, tipo, período ou fixadas, devolvendo várias opções " +
  "COM o entrada_id de cada uma (e um trecho do conteúdo). Use para achar a entrada que o Carlos " +
  "citou antes de consultá-la, editá-la ou comentá-la."
);

const ConsultarEntrada = z.strictObject({
  entrada_id: id("Id da entrada (descubra com BuscarEntradas)."),
}).describe("Uma entrada inteira — conteúdo, tags, comentários — e até quatro relacionadas por tag.");

const ListarProjetos = z.strictObject({}).describe(
  "Todos os projetos com as frentes de cada um, COM projeto_id e frente_id, e quantas tarefas " +
  "abertas cada frente tem. Use para descobrir onde criar uma tarefa ou frente (não pergunte o id)."
);

const BuscarTarefas = z.strictObject({
  texto: texto("Trecho do nome, da ação ou do stakeholder da tarefa (sem caixa e sem acento).").optional(),
  projeto_id: id("Só tarefas deste projeto.").optional(),
  frente_id: id("Só tarefas desta frente.").optional(),
  status: status.describe("Só tarefas com este status (o andamento).").optional(),
  coluna: coluna.describe("Só tarefas nesta coluna do kanban (o fluxo).").optional(),
  prazo_ate: data("Só tarefas com prazo até este dia (inclusive).").optional(),
  atrasadas: z.boolean().describe("true = só as abertas com prazo antes de hoje.").optional(),
  limite: limite(50, 30).optional(),
}).describe(
  "Busca tarefas e devolve cada uma com o tarefa_id, a frente e o projeto (nome e id), status, " +
  "coluna, prazo e holder. Sem filtro de status, as concluídas vêm por último. Use para descobrir " +
  "o tarefa_id antes de editar, concluir, comentar ou excluir — nunca pergunte o id ao Carlos. Se " +
  "vier mais de um candidato plausível, pergunte pelo NOME (tarefa › frente › projeto)."
);

const ConsultarTarefa = z.strictObject({
  tarefa_id: id("Id da tarefa (descubra com BuscarTarefas)."),
}).describe("Uma tarefa inteira: status, coluna, prazo, início, ação, stakeholder, holder, frente, projeto e comentários.");

const ListarReunioes = z.strictObject({
  de: data("Primeiro dia (inclusive). Omita para hoje.").optional(),
  ate: data("Último dia (inclusive). Omita para uma semana depois de `de`.").optional(),
}).describe("As reuniões de um período, em ordem, COM o reuniao_id de cada uma.");

const ConsultarReuniao = z.strictObject({
  reuniao_id: id("Id da reunião (descubra com ListarReunioes)."),
}).describe("Uma reunião inteira: data, horário, pauta, must e comentários.");

const HistoricoEntidade = z.strictObject({
  entidade_tipo: z.enum([...ENTIDADES]).describe("O tipo do registro."),
  entidade_id: id("Id do registro."),
}).describe(
  "Histórico de um registro, do mais novo ao mais antigo: o que mudou (de → para), quando, e por " +
  "onde (web, whatsapp, mcp, agente). Responde 'quem mudou isso?' e 'como era antes?'."
);

// ── Escrita ───────────────────────────────────────────────────────────────────
// Edição: todo campo é opcional menos o id — envie SÓ o que muda. Ausente é "não mexa"; null (onde
// é aceito) é "apague o valor". Os MAPAS abaixo dizem em que coluna cada argumento cai, e é deles
// que o desfazer tira os campos que uma reversão pode tocar (desfazer.js, camposReversiveis).

const NovaEntrada = z.strictObject({
  tipo: tipoEntrada.describe("note = nota; event = evento (compromisso com data); reminder = lembrete; lang_fr/lang_jp = anotação de francês/japonês."),
  titulo: texto("Título curto."),
  conteudo: z.string().describe("O texto da entrada. Omita num lembrete simples: o título vira o conteúdo.").optional(),
  tags: z.array(z.string().min(1)).describe("Palavras-chave; entradas com tag em comum ficam relacionadas.").optional(),
  data: data("Dia da entrada (num evento ou lembrete, o dia do compromisso). Omita para hoje.").optional(),
  hora: hora("Hora do evento ou lembrete.").optional(),
  fixada: z.boolean().describe("true = fixa no topo da lista.").optional(),
}).describe(
  "Cria uma nota, um evento ou um lembrete. Deduza o tipo do pedido ('me lembra de…' é lembrete) " +
  "e resolva datas relativas para AAAA-MM-DD antes de enviar."
);

const EditarEntrada = z.strictObject({
  entrada_id: id("Id da entrada a editar."),
  tipo: tipoEntrada.describe("Novo tipo.").optional(),
  titulo: texto("Novo título.").optional(),
  conteudo: z.string().describe("Novo conteúdo (substitui o texto inteiro).").optional(),
  tags: z.array(z.string().min(1)).describe("A NOVA lista de tags, inteira (substitui a anterior).").optional(),
  data: data("Nova data.").optional(),
  hora: hora("Nova hora; null tira a hora.").nullable().optional(),
  fixada: z.boolean().describe("true fixa; false desafixa.").optional(),
}).describe(
  "Edita uma entrada EXISTENTE, preservando o histórico. Use para adiar, renomear, fixar ou mudar " +
  "o tipo — nunca exclua e recrie. Envie apenas os campos que devem mudar."
);

const ExcluirEntrada = z.strictObject({
  entrada_id: id("Id da entrada a excluir."),
}).describe("Exclui uma entrada criada por engano (exclusão lógica: o Carlos pode restaurar).");

const NovoProjeto = z.strictObject({
  nome: texto("Nome do projeto."),
  status: status.describe("Status inicial (padrão: Em andamento).").optional(),
  holder: holder.describe("Com quem está a bola: \"Nós\" (com o Carlos), \"Eles\" (com terceiros) ou \"\" (sem responsável). Padrão: \"Nós\".").optional(),
}).describe("Cria um projeto. Frentes e tarefas entram depois, com NovaFrente e NovaTarefa.");

const EditarProjeto = z.strictObject({
  projeto_id: id("Id do projeto a editar (descubra com ListarProjetos)."),
  nome: texto("Novo nome.").optional(),
  status: status.describe("Novo status.").optional(),
  holder: holder.describe("Novo holder.").optional(),
}).describe("Edita um projeto EXISTENTE (nome, status ou holder), preservando o histórico. Envie apenas o que muda.");

const ExcluirProjeto = z.strictObject({
  projeto_id: id("Id do projeto a excluir."),
}).describe(
  "Exclui um projeto — e com ele somem da tela as frentes e as tarefas (exclusão lógica: restaurar " +
  "o projeto devolve a árvore inteira)."
);

const NovaFrente = z.strictObject({
  projeto_id: id("Id do projeto (descubra com ListarProjetos)."),
  nome: texto("Nome da frente."),
}).describe("Cria uma frente (linha de trabalho) num projeto.");

const EditarFrente = z.strictObject({
  frente_id: id("Id da frente a editar (descubra com ListarProjetos)."),
  nome: texto("Novo nome.").optional(),
}).describe("Renomeia uma frente EXISTENTE, preservando o histórico.");

const ExcluirFrente = z.strictObject({
  frente_id: id("Id da frente a excluir."),
}).describe("Exclui uma frente — e com ela somem da tela as tarefas dela (restaurar devolve).");

const NovaTarefa = z.strictObject({
  frente_id: id("Id da frente onde a tarefa nasce (descubra com ListarProjetos)."),
  nome: texto("Nome da tarefa."),
  acao: z.string().describe("O próximo gesto concreto (ex.: 'mandar e-mail para a Ana').").optional(),
  status: status.describe("Status inicial (padrão: Pendente).").optional(),
  coluna: coluna.describe("Coluna inicial do kanban (padrão: A fazer).").optional(),
  prazo: data("Prazo.").optional(),
  inicio: data("Dia de início.").optional(),
  stakeholder: z.string().describe("Quem pediu ou depende da tarefa.").optional(),
  holder: holder.describe("Com quem está a bola (padrão: \"\", sem responsável).").optional(),
}).describe(
  "Cria uma tarefa numa frente, já com o que foi dito (prazo, coluna, status, holder). Resolva " +
  "datas relativas ('sexta') para AAAA-MM-DD antes de enviar."
);

const EditarTarefa = z.strictObject({
  tarefa_id: id("Id da tarefa a editar (descubra com BuscarTarefas)."),
  status: status.describe("Novo status (o andamento). NÃO move a coluna.").optional(),
  coluna: coluna.describe("Nova coluna do kanban (o fluxo). NÃO muda o status.").optional(),
  prazo: data("Novo prazo; null tira o prazo.").nullable().optional(),
  inicio: data("Novo dia de início; null tira o início.").nullable().optional(),
  nome: texto("Novo nome.").optional(),
  acao: z.string().describe("Nova ação (o próximo gesto).").optional(),
  stakeholder: z.string().describe("Novo stakeholder.").optional(),
  holder: holder.describe("Novo holder.").optional(),
}).describe(
  "Edita uma tarefa EXISTENTE, preservando o histórico: adiar o prazo, mover de coluna, mudar o " +
  "status ou o holder, renomear. Status e coluna são eixos independentes — para CONCLUIR use " +
  "ConcluirTarefa. Envie apenas os campos que devem mudar; nunca exclua e recrie."
);

const ConcluirTarefa = z.strictObject({
  tarefa_id: id("Id da tarefa a concluir (descubra com BuscarTarefas)."),
}).describe("Conclui uma tarefa: status Concluído E coluna Feito, de uma vez.");

const ExcluirTarefa = z.strictObject({
  tarefa_id: id("Id da tarefa a excluir."),
}).describe("Exclui uma tarefa criada por engano (exclusão lógica). Para tarefa terminada, use ConcluirTarefa.");

const NovaReuniao = z.strictObject({
  titulo: texto("Título da reunião."),
  data: data("Dia da reunião."),
  inicio: hora("Hora de início.").optional(),
  fim: hora("Hora de término.").optional(),
  pauta: z.string().describe("Pauta ou descrição.").optional(),
  must: z.string().describe("O que não pode sair da reunião sem ser tratado.").optional(),
}).describe("Marca uma reunião na agenda. Resolva datas relativas para AAAA-MM-DD antes de enviar.");

const EditarReuniao = z.strictObject({
  reuniao_id: id("Id da reunião a editar (descubra com ListarReunioes)."),
  titulo: texto("Novo título.").optional(),
  data: data("Nova data.").optional(),
  inicio: hora("Nova hora de início.").optional(),
  fim: hora("Nova hora de término.").optional(),
  pauta: z.string().describe("Nova pauta (substitui a anterior).").optional(),
  must: z.string().describe("Novo must (substitui o anterior).").optional(),
}).describe("Edita uma reunião EXISTENTE (remarcar, mudar pauta ou must), preservando o histórico. Envie apenas o que muda.");

const ExcluirReuniao = z.strictObject({
  reuniao_id: id("Id da reunião a excluir."),
}).describe("Tira uma reunião da agenda (exclusão lógica).");

const NovoComentario = z.strictObject({
  alvo_tipo: z.enum([...ALVOS_COMENTARIO]).describe("Onde comentar: ENTRADA, TAREFA ou REUNIAO."),
  alvo_id: id("Id da entrada, tarefa ou reunião."),
  texto: z.string().min(1).max(COMENTARIO_TEXTO_MAX).describe(`O comentário (até ${COMENTARIO_TEXTO_MAX} caracteres).`),
}).describe("Acrescenta um comentário a uma entrada, tarefa ou reunião.");

const Lembrar = z.strictObject({
  texto: z.string().min(1).max(MEMORIA_TEXTO_MAX)
    .describe(`O que guardar, numa frase curta e na voz do Carlos (até ${MEMORIA_TEXTO_MAX} caracteres). Sem id técnico.`),
  lembrar_em: data("A partir de quando isto passa a importar. Omita para contexto permanente (preferências, fatos sobre pessoas).").optional(),
}).describe(
  "Guarda na memória algo que o Carlos PEDIU para você lembrar — uma preferência ('prefiro resumo " +
  "curto'), um fato ('a Ana só atende de manhã') ou um lembrete com data. Use SÓ quando ele pedir " +
  "explicitamente: a memória entra em todo turno futuro, e inferências suas afogam o que ele pediu."
);

const Esquecer = z.strictObject({
  trecho: texto("Trecho do que deve sair, como o Carlos se referiu (ex.: 'aquilo da Ana')."),
}).describe("Arquiva uma linha da memória pelo trecho citado. Se mais de uma casar, pergunte qual.");

export const SCHEMAS = {
  ResumoDoDia, ProximosCompromissos, BuscarEntradas, ConsultarEntrada, ListarProjetos,
  BuscarTarefas, ConsultarTarefa, ListarReunioes, ConsultarReuniao, HistoricoEntidade,
  NovaEntrada, EditarEntrada, ExcluirEntrada,
  NovoProjeto, EditarProjeto, ExcluirProjeto,
  NovaFrente, EditarFrente, ExcluirFrente,
  NovaTarefa, EditarTarefa, ConcluirTarefa, ExcluirTarefa,
  NovaReuniao, EditarReuniao, ExcluirReuniao,
  NovoComentario, Lembrar, Esquecer,
};

// ── Argumento → coluna, por ferramenta de edição ──────────────────────────────
// Três consumidores, e é por isso que é dado e não código espalhado: o executor (traduz os
// argumentos para o serviço), o desfazer (os campos que uma reversão pode tocar) e o resumo da ação
// (o rótulo de cada campo mudado). A chave que cai em "id" é o identificador, nunca um campo.
// O teste reflexivo cobra que as chaves de cada MAPA sejam exatamente as do schema.
export const MAPAS = {
  EditarEntrada: {
    entrada_id: "id", tipo: "type", titulo: "title", conteudo: "content", tags: "tags",
    data: "date", hora: "time", fixada: "pinned",
  },
  EditarProjeto: { projeto_id: "id", nome: "name", status: "status", holder: "holder" },
  EditarFrente: { frente_id: "id", nome: "name" },
  EditarTarefa: {
    tarefa_id: "id", status: "status", coluna: "kanban_status", prazo: "deadline",
    inicio: "start_date", nome: "name", acao: "acao", stakeholder: "stakeholder", holder: "holder",
  },
  EditarReuniao: {
    reuniao_id: "id", titulo: "title", data: "date", inicio: "start_time", fim: "end_time",
    pauta: "description", must: "must",
  },
};

/** O argumento identificador de uma ferramenta de edição (o que cai em "id" no MAPA). */
export function chaveDoId(editor) {
  return Object.entries(MAPAS[editor]).find(([, coluna]) => coluna === "id")[0];
}
