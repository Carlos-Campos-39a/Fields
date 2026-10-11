import { STATUS_TONES } from "../ui/index.js";

// O tom de cada coluna do kanban sai do MESMO mapa do StatusBadge (ui/StatusBadge.jsx): o badge do
// cabeçalho e o realce de "solte aqui" falam a mesma cor. No monólito era KANBAN_COLS com hex à
// mão, fora do tema. Aqui só sai o NOME do tom; a cor é do CSS (KanbanView.module.css, por
// data-tom), em token — por isso serve nos dois temas. A LISTA de colunas vem da ontologia
// (enums.kanban); coluna nova sem tom aparece neutra (e o StatusBadge loga UI_STATUS_SEM_TOM).

const TONS_COM_COR = Object.freeze(["neutral", "accent", "info", "success", "warning", "danger"]);

/** "A fazer" → "neutral", "Feito" → "success"…; sem tom conhecido → "neutral". */
export function tomDaColuna(coluna) {
  const tom = STATUS_TONES[coluna]?.tone;
  return TONS_COM_COR.includes(tom) ? tom : "neutral";
}
