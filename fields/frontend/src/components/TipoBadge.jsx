import { Badge, Icon } from "../ui/index.js";
import { useOntologia } from "../lib/ontologia.js";
import { aparenciaDoTipo } from "./tipoEntrada.js";

// Entrada sem tipo (dado antigo): rotulo() devolve "" para valor nulo, e o badge virava um ícone
// sem texto — sem nome para o leitor de tela. O nome genérico do enum cobre o buraco; o log do
// tipo sem aparência já sai em aparenciaDoTipo.
const ROTULO_SEM_TIPO = "Entrada";

/**
 * O tipo de uma entrada como Badge: ícone (ou bandeira) + rótulo da ontologia. `children` vai
 * depois do rótulo (ex.: "· Amanhã 14:00"). Compartilhado por entries/ e home/.
 */
export function TipoBadge({ tipo, className, children }) {
  const { rotulo } = useOntologia();
  const a = aparenciaDoTipo(tipo);
  return (
    <Badge tone={a.tom} className={className}>
      {a.bandeira ? <span aria-hidden="true">{a.bandeira}</span> : <Icon name={a.icone} size={12} />}
      {rotulo("tipo_entrada", tipo) || ROTULO_SEM_TIPO}
      {children}
    </Badge>
  );
}
