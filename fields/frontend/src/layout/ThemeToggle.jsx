import { useId, useRef, useState } from "react";
import { Icon, IconButton, Popover, PopoverItem } from "../ui/index.js";
import { useTema } from "../theme/useTema.js";

// As três preferências, na ordem do menu. "Sistema" segue o prefers-color-scheme e acompanha a
// troca do sistema sem recarregar (theme/theme.js). O claro é o padrão (plano §4).
const OPCOES = Object.freeze([
  { valor: "light", rotulo: "Claro", icone: "sun" },
  { valor: "dark", rotulo: "Escuro", icone: "moon" },
  { valor: "system", rotulo: "Sistema", icone: "monitor" },
]);

/**
 * As três opções como PopoverItem — o mesmo trecho no menu do ThemeToggle e no "Mais" do
 * celular (MobileNav), para as duas portas do tema não divergirem.
 */
export function OpcoesDeTema({ preferencia, aoEscolher }) {
  return OPCOES.map(({ valor, rotulo, icone }) => (
    <PopoverItem
      key={valor}
      icon={<Icon name={icone} />}
      selected={preferencia === valor}
      onClick={() => aoEscolher(valor)}
    >
      {rotulo}
    </PopoverItem>
  ));
}

/**
 * Troca de tema: o ícone diz a preferência atual; o clique abre as três opções. Era um ciclo
 * Claro → Escuro → Sistema num clique só — quem queria "Sistema" passava pelo escuro, e nada na
 * tela dizia qual seria o próximo. setPreferencia grava em localStorage com try/catch.
 */
export function ThemeToggle({ size = "md", className }) {
  const { preferencia, setPreferencia } = useTema();
  const [aberto, setAberto] = useState(false);
  const ancoraRef = useRef(null);
  const menuId = useId();
  const atual = OPCOES.find((o) => o.valor === preferencia) ?? OPCOES[0];

  return (
    <>
      <IconButton
        ref={ancoraRef}
        size={size}
        className={className}
        aria-label={`Tema: ${atual.rotulo}`}
        aria-haspopup="dialog"
        aria-expanded={aberto}
        aria-controls={menuId}
        onClick={() => setAberto((v) => !v)}
      >
        <Icon name={atual.icone} />
      </IconButton>
      <Popover
        id={menuId}
        open={aberto}
        onClose={() => setAberto(false)}
        anchorRef={ancoraRef}
        align="end"
        label="Tema"
        width={180}
      >
        <OpcoesDeTema
          preferencia={preferencia}
          aoEscolher={(valor) => {
            setPreferencia(valor);
            setAberto(false);
          }}
        />
      </Popover>
    </>
  );
}
