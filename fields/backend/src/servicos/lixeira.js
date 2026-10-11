// Lixeira (A2c): o que foi excluído, e de onde cada item tem de voltar.
//
// Excluir é carimbar deleted_at (exclusao.js); a Lixeira lista o que tem o PRÓPRIO carimbo. Frente e
// tarefa que só sumiram porque o pai foi excluído NÃO entram: não foram excluídas, estão escondidas
// pelas views da cascata e voltam junto com o pai. Listá-las convidaria o modelo a restaurá-las uma a
// uma — e cada restaurar recusaria, porque nenhuma delas tem carimbo.
//
// Fora da lista, porém, o id de uma delas ainda chega ao Restaurar*: o modelo o guardou de uma
// BuscarTarefas ou ConsultarTarefa anterior à exclusão do projeto. Para esse caso o restaurar recusa
// com ESCONDIDO_PELO_PAI, levando o `pai` — e não com NAO_ESTA_NA_LIXEIRA, cujo texto ("não foi
// excluído") o modelo repassaria ao Carlos sobre algo que sumiu da tela dele (itemDaLixeira).
//
// É o único serviço cuja razão de ser é ler o que as views escondem. Por isso as leituras de
// `frentes` e `tasks` aqui são diretas, todas marcadas "tabela-direta" (test/schema.test.js cobra).
//
// `pai_excluido` responde "dá para restaurar já?". Restaurar uma frente com o projeto ainda excluído
// é ACEITO pelo serviço (exclusao.restaurarLogico): a frente perde o carimbo e continua invisível —
// um "restaurei" que ninguém vê na tela. Os Restaurar* do agente leem o item por aqui ANTES e recusam
// com PAI_EXCLUIDO, levando o `pai` que precisa voltar primeiro (agente/ferramentas.js).

import { recusa, sucesso } from "../lib/erros.js";
import { ENTIDADES } from "../dominio/enums.js";
import { valorDeHistorico } from "../dominio/mudancas.js";
import { comentariosMigrados } from "./comentarios.js";
import { trecho } from "./serializadores.js";

const vazioViraNull = (v) => (v === "" || v === undefined ? null : v);

// ── Uma consulta por tipo ─────────────────────────────────────────────────────
// Cada uma é só o SELECT com os JOINs; o predicado do carimbo vem de `consulta`, e quem chama
// acrescenta a janela (a lista) ou o id (um item). O alias do item é sempre `x`, para o acréscimo
// valer para todas.
//
// O comentário traz, além do alvo, a frente e o projeto da tarefa-alvo: o que esconde um comentário
// pode ser o projeto lá em cima, e é ESSE que tem de voltar primeiro (paiExcluido).
const SQL = Object.freeze({
  ENTRADA: `SELECT x.id, x.title, x.type, x.date, x.deleted_at
     FROM entries x`,
  PROJETO: `SELECT x.id, x.name, x.deleted_at
     FROM projects x`,
  FRENTE: `SELECT x.id, x.name, x.deleted_at,
            p.id AS projeto_id, p.name AS projeto_nome, p.deleted_at AS projeto_excluido_em
     FROM frentes x -- tabela-direta: a lixeira lê justamente o que a view esconde
     JOIN projects p ON p.id = x.project_id`,
  TAREFA: `SELECT x.id, x.name, x.deleted_at,
            f.id AS frente_id, f.name AS frente_nome, f.deleted_at AS frente_excluida_em,
            p.id AS projeto_id, p.name AS projeto_nome, p.deleted_at AS projeto_excluido_em
     FROM tasks x -- tabela-direta: idem
     JOIN frentes f ON f.id = x.frente_id -- tabela-direta: a frente pode estar excluída também
     JOIN projects p ON p.id = f.project_id`,
  REUNIAO: `SELECT x.id, x.title, x.date, x.start_time, x.deleted_at
     FROM meetings x`,
  COMENTARIO: `SELECT x.id, x.texto, x.alvo_tipo, x.alvo_id, x.deleted_at,
            COALESCE(e.title, m.title, t.name) AS alvo_nome,
            COALESCE(e.id, m.id, t.id) IS NOT NULL AS alvo_existe,
            COALESCE(e.deleted_at, m.deleted_at, t.deleted_at) AS alvo_excluido_em,
            f.id AS frente_id, f.name AS frente_nome, f.deleted_at AS frente_excluida_em,
            p.id AS projeto_id, p.name AS projeto_nome, p.deleted_at AS projeto_excluido_em
     FROM comentarios x
     LEFT JOIN entries e ON x.alvo_tipo = 'ENTRADA' AND e.id = x.alvo_id
     LEFT JOIN meetings m ON x.alvo_tipo = 'REUNIAO' AND m.id = x.alvo_id
     LEFT JOIN tasks t ON x.alvo_tipo = 'TAREFA' AND t.id = x.alvo_id -- tabela-direta: o alvo pode estar excluído ou escondido
     LEFT JOIN frentes f ON f.id = t.frente_id -- tabela-direta: idem
     LEFT JOIN projects p ON p.id = f.project_id`,
});

// A Lixeira é o que tem o PRÓPRIO carimbo (`carimbado`). A leitura sem carimbo só existe para o
// itemDaLixeira distinguir "escondido pelo pai" de "vivo ou inexistente" — nunca para listar.
const consulta = (entidadeTipo, { carimbado = true } = {}) => `${SQL[entidadeTipo]}
     WHERE x.deleted_at IS ${carimbado ? "NOT NULL" : "NULL"}`;

// Os tipos que um pai excluído consegue esconder sem carimbo próprio: frente (projeto), tarefa
// (frente, projeto) e comentário (o alvo, ou o que esconde o alvo). Entrada, projeto e reunião não
// têm pai — ou estão na Lixeira, ou estão à vista (ou não existem).
const ESCONDIVEIS = Object.freeze(["FRENTE", "TAREFA", "COMENTARIO"]);

// O restaurar trava os PAIS (FOR SHARE) entre a conferência e a escrita: sem isso, uma exclusão do
// projeto que caísse no meio deixaria a frente restaurada e escondida — o caso que a conferência
// existe para evitar. É a mesma trava que criarFrente/criarTarefa usam no pai. O comentário não
// trava: os pais dele vêm de LEFT JOIN (o lado anulável não aceita FOR SHARE), e o serviço
// (restaurarComentario) confere o alvo de novo, como o DELETE faz.
const TRAVA = Object.freeze({ FRENTE: "FOR SHARE OF p", TAREFA: "FOR SHARE OF f, p" });

// ── Linha → item (puro) ───────────────────────────────────────────────────────

const excluidoEm = (r) => valorDeHistorico(r.deleted_at);

// O id de cada item vai na chave que o Restaurar* do tipo recebe (tarefa_id, projeto_id, …), como em
// toda leitura do agente: o modelo encadeia leitura → escrita pelo id, sem traduzir chave.
const ITEM = Object.freeze({
  ENTRADA: (r) => ({
    entidade_tipo: "ENTRADA", entrada_id: r.id, titulo: r.title, tipo: r.type,
    data: vazioViraNull(r.date) ?? null, excluido_em: excluidoEm(r),
  }),
  PROJETO: (r) => ({ entidade_tipo: "PROJETO", projeto_id: r.id, nome: r.name, excluido_em: excluidoEm(r) }),
  FRENTE: (r) => ({
    entidade_tipo: "FRENTE", frente_id: r.id, nome: r.name,
    projeto_id: r.projeto_id, projeto: r.projeto_nome, excluido_em: excluidoEm(r),
  }),
  TAREFA: (r) => ({
    entidade_tipo: "TAREFA", tarefa_id: r.id, nome: r.name,
    frente_id: r.frente_id, frente: r.frente_nome, projeto_id: r.projeto_id, projeto: r.projeto_nome,
    excluido_em: excluidoEm(r),
  }),
  REUNIAO: (r) => ({
    entidade_tipo: "REUNIAO", reuniao_id: r.id, titulo: r.title, data: vazioViraNull(r.date) ?? null,
    inicio: vazioViraNull(r.start_time) ?? null, excluido_em: excluidoEm(r),
  }),
  COMENTARIO: (r) => ({
    entidade_tipo: "COMENTARIO", comentario_id: r.id, texto: trecho(r.texto),
    alvo_tipo: r.alvo_tipo, alvo_id: r.alvo_id, alvo_nome: r.alvo_nome ?? null, excluido_em: excluidoEm(r),
  }),
});

/**
 * O ancestral excluído que tem de voltar ANTES do item — {entidade_tipo, entidade_id, nome} — ou
 * null. É o mais ALTO da árvore: com o projeto e a frente excluídos, apontar a frente só trocaria uma
 * recusa pela seguinte (restaurar a frente também recusaria). Para o comentário, o que esconde o
 * alvo: o projeto ou a frente da tarefa-alvo, senão o próprio alvo.
 */
export function paiExcluido(entidadeTipo, r) {
  if (r.projeto_excluido_em) return { entidade_tipo: "PROJETO", entidade_id: r.projeto_id, nome: r.projeto_nome };
  if (r.frente_excluida_em) return { entidade_tipo: "FRENTE", entidade_id: r.frente_id, nome: r.frente_nome };
  if (entidadeTipo === "COMENTARIO" && r.alvo_excluido_em) {
    return { entidade_tipo: r.alvo_tipo, entidade_id: r.alvo_id, nome: r.alvo_nome ?? null };
  }
  return null;
}

/**
 * Linha de uma das consultas acima → item da Lixeira, com `pai_excluido` (e o `pai`, quando há um a
 * restaurar antes). Um comentário cujo alvo nem existe mais é `pai_excluido` SEM `pai`: não há o
 * que restaurar antes, e o serviço recusaria do mesmo jeito — melhor dizer já na lista.
 */
export function itemDaLinha(entidadeTipo, r) {
  const pai = paiExcluido(entidadeTipo, r);
  const orfao = entidadeTipo === "COMENTARIO" && r.alvo_existe === false;
  return { ...ITEM[entidadeTipo](r), pai_excluido: Boolean(pai) || orfao, ...(pai && { pai }) };
}

// ── As duas leituras ──────────────────────────────────────────────────────────

async function listarTipo(db, entidadeTipo, desdeDias, limite) {
  const { rows } = await db.query(
    `${consulta(entidadeTipo)}
       AND x.deleted_at >= NOW() - make_interval(days => $1::int)
     ORDER BY x.deleted_at DESC, x.id
     LIMIT $2::int`,
    [desdeDias, limite]
  );
  return rows.map((r) => itemDaLinha(entidadeTipo, r));
}

/**
 * O que foi excluído nos últimos `desdeDias`, do mais recente ao mais antigo, até `limite` itens
 * somando todos os tipos (cada consulta já corta no limite: o topo da soma está sempre nelas).
 *
 * Modo legado dos comentários (a migração falhou): a tabela `comentarios` não é a verdade, então o
 * tipo COMENTARIO pedido explicitamente recusa (COMENTARIOS_INDISPONIVEIS), e a lista de todos os
 * tipos sai sem eles — com `comentariosIndisponiveis: true`, para a ausência não passar por "não há".
 */
export async function listarLixeira(db, ctx, { tipo, desdeDias = 30, limite = 30 } = {}) {
  if (tipo !== undefined && !ENTIDADES.includes(tipo)) return recusa("TIPO_INVALIDO");
  const migrados = comentariosMigrados(ctx);
  if (tipo === "COMENTARIO" && !migrados) return recusa("COMENTARIOS_INDISPONIVEIS");
  const tipos = (tipo ? [tipo] : ENTIDADES).filter((t) => migrados || t !== "COMENTARIO");

  const itens = [];
  for (const t of tipos) itens.push(...await listarTipo(db, t, desdeDias, limite));
  // ISO em UTC (toISOString) ordena como texto; o empate fica na ordem de ENTIDADES (sort estável).
  itens.sort((a, b) => (a.excluido_em < b.excluido_em ? 1 : a.excluido_em > b.excluido_em ? -1 : 0));
  return sucesso({ itens: itens.slice(0, limite), comentariosIndisponiveis: !migrados && !tipo });
}

/**
 * Um item que ESTÁ na Lixeira (tem o próprio carimbo), sem janela de dias: a exclusão de meses atrás
 * também volta.
 *
 * Fora da Lixeira há duas recusas, e o que as separa é o que o Carlos vê:
 * - ESCONDIDO_PELO_PAI (com o `pai`): frente, tarefa ou comentário SEM carimbo próprio, sumido da
 *   tela porque algo acima foi excluído. Não há o que restaurar nele — restaura-se o `pai` (o mais
 *   alto, como no PAI_EXCLUIDO), e ele reaparece quando nada acima seguir excluído. Sem esta
 *   distinção, o "não foi excluído" do NAO_ESTA_NA_LIXEIRA chegaria ao Carlos sobre uma tarefa que
 *   ele não acha mais, e nada apontaria o projeto (a lista não a mostra).
 * - NAO_ESTA_NA_LIXEIRA: vivo e à vista, já restaurado, ou inexistente. O motivo diz o que
 *   aconteceu, onde um NAO_ENCONTRADO diria "pode ter sido excluído" sobre o que se quer restaurar.
 *
 * A segunda leitura (sem carimbo) só roda quando a primeira volta vazia, e só para os tipos que um
 * pai consegue esconder: o caminho que dá certo segue com uma consulta só. Leva a mesma trava —
 * inofensiva aqui (nenhuma escrita segue uma recusa), e a consulta fica uma só, mudando o predicado.
 *
 * `travar` (o caminho do restaurar, dentro do tx da escrita) segura os pais FOR SHARE até o COMMIT.
 */
export async function itemDaLixeira(db, ctx, entidadeTipo, id, { travar = false } = {}) {
  if (!ENTIDADES.includes(entidadeTipo)) return recusa("TIPO_INVALIDO");
  if (entidadeTipo === "COMENTARIO" && !comentariosMigrados(ctx)) return recusa("COMENTARIOS_INDISPONIVEIS");
  const trava = travar ? TRAVA[entidadeTipo] ?? "" : "";
  const ler = async (carimbado) => (await db.query(`${consulta(entidadeTipo, { carimbado })}
       AND x.id = $1
     ${trava}`, [id])).rows[0];

  const excluido = await ler(true);
  if (excluido) return sucesso(itemDaLinha(entidadeTipo, excluido));

  const vivo = ESCONDIVEIS.includes(entidadeTipo) ? await ler(false) : undefined;
  const pai = vivo ? paiExcluido(entidadeTipo, vivo) : null;
  if (pai) return { ...recusa("ESCONDIDO_PELO_PAI"), pai };
  return recusa("NAO_ESTA_NA_LIXEIRA");
}
