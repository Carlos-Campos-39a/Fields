import { Badge } from "./Badge.jsx";
import { avisarUmaVez } from "./util.js";

/*
 * Tom de cada valor persistido de status (andamento de projeto/tarefa) e de coluna do kanban.
 * As chaves são os valores crus que o banco guarda — hoje PROJ_STATUS_LIST e KANBAN_COLS do
 * App.jsx; na A2, os enums `status` e `kanban` de dominio/enums.js, servidos por GET
 * /api/ontologia. O RÓTULO não mora aqui: vem pela prop `label` (useOntologia, R1/R2) e, sem ela,
 * o próprio valor — que já é texto humano.
 *
 * Os dois eixos são independentes (como etapa × situação no CRM), mas não colidem em valor, então
 * cabem num mapa só.
 */
export const STATUS_TONES = {
  // status — andamento
  "Em andamento": { tone: "info", variant: "solid" },
  Marcado: { tone: "info", variant: "outline" },
  Pendente: { tone: "accent", variant: "soft" },
  "Em definição": { tone: "neutral", variant: "soft" }, // texto --text-2
  "Não iniciado": { tone: "neutral", variant: "outline" }, // texto --text-3
  "Concluído": { tone: "success", variant: "soft" },
  // kanban — fluxo
  "A fazer": { tone: "neutral", variant: "soft" },
  Fazendo: { tone: "accent", variant: "soft" },
  Espera: { tone: "info", variant: "soft" },
  Feito: { tone: "success", variant: "soft" },
};

/**
 * <StatusBadge value="Em andamento" />  ou, com rótulo da ontologia, <StatusBadge value={v} label={rotulo} />.
 * Valor sem tom não some: aparece neutro, com o valor cru, e loga UI_STATUS_SEM_TOM uma vez.
 */
export function StatusBadge({ value, label, className, ...rest }) {
  let estilo = STATUS_TONES[value];
  if (!estilo) {
    avisarUmaVez("UI_STATUS_SEM_TOM", "status sem tom definido; exibindo neutro", {
      valor: value ?? null,
      conhecidos: Object.keys(STATUS_TONES),
    });
    estilo = { tone: "neutral", variant: "soft" };
  }
  return (
    <Badge
      tone={estilo.tone}
      variant={estilo.variant}
      dot={estilo.variant !== "solid"}
      className={className}
      {...rest}
    >
      {label ?? value ?? "—"}
    </Badge>
  );
}
