import { Icon } from "../ui/index.js";
import { aparenciaDoTipo } from "../components/tipoEntrada.js";

/**
 * O ícone do tipo de uma entrada (ou a bandeira, nos de língua) — o mesmo desenho do TipoBadge,
 * sem a pílula, para onde o rótulo não cabe (a lista, as relacionadas). Decorativo: quem usa põe o
 * rótulo do tipo em texto (visível ou .sr-only). Tipo nulo ou desconhecido cai no padrão com log
 * (aparenciaDoTipo), em vez do `entry.type.startsWith` do monólito, que derrubava a tela.
 */
export function IconeDoTipo({ tipo, size = 14, className }) {
  const a = aparenciaDoTipo(tipo);
  return (
    <span className={className} aria-hidden="true">
      {a.bandeira ?? <Icon name={a.icone} size={size} />}
    </span>
  );
}
