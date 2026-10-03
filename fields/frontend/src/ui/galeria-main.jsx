/*
 * Galeria de desenvolvimento dos tokens e primitivos (R1).
 *
 * Abre em http://localhost:5173/ui.html com o `npm run dev` de sempre. É uma segunda entrada HTML
 * que o Vite serve em dev; o build de produção só empacota o index.html (rollupOptions.input
 * padrão), então nada daqui vai para a Vercel. Não toca App.jsx nem main.jsx.
 *
 * Os valores de cor são LIDOS do CSS (getComputedStyle em duas sondas com data-theme fixo), não
 * copiados: se tokens.css mudar, a tabela e o contraste mudam junto.
 */
import React, { useId, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { iniciarTema } from "../theme/theme.js";
import { useTema } from "../theme/useTema.js";
import {
  Badge,
  BADGE_TONES,
  BADGE_VARIANTS,
  Button,
  BUTTON_VARIANTS,
  ConfirmDialog,
  EmptyState,
  Icon,
  ICON_NAMES,
  IconButton,
  Logo,
  Popover,
  PopoverItem,
  SectionLabel,
  Spinner,
  StatusBadge,
  ToastProvider,
  useToast,
} from "./index.js";
import g from "./galeria.module.css";

iniciarTema();

// ── Dados da galeria ───────────────────────────────────────────────────────────────────────
const GRUPOS_DE_COR = [
  { titulo: "Superfícies", tokens: ["--bg", "--surface", "--surface-2", "--border", "--border-strong", "--decorative"] },
  { titulo: "Texto", tokens: ["--text", "--text-2", "--text-3"] },
  { titulo: "Acento", tokens: ["--accent", "--accent-ink", "--accent-soft", "--focus-ring"] },
  {
    titulo: "Informação e sucesso",
    tokens: ["--info", "--info-ink", "--info-soft", "--success", "--success-ink", "--success-soft"],
  },
  {
    titulo: "Atenção e perigo",
    tokens: ["--warning", "--warning-ink", "--warning-soft", "--danger", "--danger-hover", "--on-danger", "--danger-soft"],
  },
  { titulo: "Primário e preenchimento", tokens: ["--primary-bg", "--primary-fg", "--primary-bg-hover", "--on-fill"] },
  { titulo: "Sobreposição e rolagem", tokens: ["--overlay", "--scrollbar-thumb", "--scrollbar-thumb-hover"] },
  { titulo: "Legado do App.jsx", tokens: ["--text-main", "--gray-200"] },
];

// [primeiro plano, fundo, mínimo]. 4,5 para texto; 3 para componente não textual (anel de foco).
const PARES_DE_CONTRASTE = [
  ["--text", "--bg", 4.5],
  ["--text", "--surface", 4.5],
  ["--text", "--surface-2", 4.5],
  ["--text-2", "--bg", 4.5],
  ["--text-2", "--surface", 4.5],
  ["--text-2", "--surface-2", 4.5],
  ["--text-3", "--bg", 4.5],
  ["--text-3", "--surface", 4.5],
  ["--text-3", "--surface-2", 4.5],
  ["--accent-ink", "--bg", 4.5],
  ["--accent-ink", "--surface", 4.5],
  ["--info-ink", "--bg", 4.5],
  ["--info-ink", "--surface", 4.5],
  ["--success-ink", "--bg", 4.5],
  ["--success-ink", "--surface", 4.5],
  ["--warning-ink", "--bg", 4.5],
  ["--warning-ink", "--surface", 4.5],
  ["--danger", "--bg", 4.5],
  ["--danger", "--surface", 4.5],
  ["--primary-fg", "--primary-bg", 4.5],
  ["--on-danger", "--danger", 4.5],
  ["--on-fill", "--info", 4.5],
  ["--on-fill", "--accent", 4.5],
  ["--on-fill", "--success", 4.5],
  ["--on-fill", "--warning", 4.5],
  ["--focus-ring", "--bg", 3],
  ["--focus-ring", "--surface", 3],
];

const TODOS_OS_TOKENS = Array.from(
  new Set([...GRUPOS_DE_COR.flatMap((grupo) => grupo.tokens), ...PARES_DE_CONTRASTE.flatMap(([a, b]) => [a, b])]),
);

const ESCALA_TIPO = ["--fs-xs", "--fs-sm", "--fs-base", "--fs-md", "--fs-lg", "--fs-xl"];
const ESPACOS = ["--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6", "--sp-7"];
const RAIOS = ["--radius-sm", "--radius-lg", "--radius-pill"];

const STATUS_ANDAMENTO = ["Em andamento", "Pendente", "Marcado", "Em definição", "Não iniciado", "Concluído"];
const COLUNAS_KANBAN = ["A fazer", "Fazendo", "Espera", "Feito"];

// ── Contraste (WCAG 2.x) ───────────────────────────────────────────────────────────────────
function luminancia(cor) {
  const m = /^#([0-9a-f]{6})$/i.exec((cor ?? "").trim());
  if (!m) return null; // rgba e afins: fora da conta
  const n = parseInt(m[1], 16);
  const canal = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(n >> 16) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255);
}

function contraste(a, b) {
  const la = luminancia(a);
  const lb = luminancia(b);
  if (la == null || lb == null) return null;
  const [claro, escuro] = la > lb ? [la, lb] : [lb, la];
  return (claro + 0.05) / (escuro + 0.05);
}

const formatarRazao = (r) =>
  `${r.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}:1`;

/** Lê os tokens nas duas sondas (data-theme fixo) — independe do tema da página. */
function useValoresDosTokens() {
  const sondaClara = useRef(null);
  const sondaEscura = useRef(null);
  const [valores, setValores] = useState({ light: {}, dark: {} });
  useLayoutEffect(() => {
    const ler = (el) => {
      const estilo = getComputedStyle(el);
      const lista = [...TODOS_OS_TOKENS, ...ESCALA_TIPO, ...ESPACOS, ...RAIOS];
      return Object.fromEntries(lista.map((nome) => [nome, estilo.getPropertyValue(nome).trim()]));
    };
    setValores({ light: ler(sondaClara.current), dark: ler(sondaEscura.current) });
  }, []);
  const sondas = (
    <>
      <div ref={sondaClara} data-theme="light" hidden />
      <div ref={sondaEscura} data-theme="dark" hidden />
    </>
  );
  return { valores, sondas };
}

// ── Peças da galeria ───────────────────────────────────────────────────────────────────────
function Secao({ titulo, nota, children }) {
  return (
    <section className={g.secao}>
      <h2 className={g.titulo}>{titulo}</h2>
      {nota && <p className={g.nota}>{nota}</p>}
      {children}
    </section>
  );
}

function Chip({ tema, nome, valor }) {
  return (
    <span data-theme={tema} className={g.chip}>
      <span className={g.amostra} style={{ background: `var(${nome})` }} />
      <code>{valor || "—"}</code>
    </span>
  );
}

function SeletorDeTema() {
  const { preferencia, tema, setPreferencia } = useTema();
  const opcoes = [
    { valor: "light", rotulo: "Claro", icone: "sun" },
    { valor: "dark", rotulo: "Escuro", icone: "moon" },
    { valor: "system", rotulo: "Sistema", icone: "monitor" },
  ];
  return (
    <div className={g.linha}>
      <div className={g.temas} role="group" aria-label="Tema">
        {opcoes.map((o) => (
          <Button
            key={o.valor}
            size="sm"
            variant="ghost"
            icon={<Icon name={o.icone} />}
            aria-pressed={preferencia === o.valor}
            className={preferencia === o.valor ? g.temaAtivo : undefined}
            onClick={() => setPreferencia(o.valor)}
          >
            {o.rotulo}
          </Button>
        ))}
      </div>
      <span className={g.temaResolvido}>aplicado: {tema === "dark" ? "escuro" : "claro"}</span>
    </div>
  );
}

function Cores({ valores }) {
  return (
    <Secao
      titulo="Cores"
      nota="Cada linha mostra o token nos dois temas, lado a lado, com o valor lido do CSS. A cor de marca (#d97757) é preenchimento, ícone e foco; texto em laranja usa --accent-ink."
    >
      {GRUPOS_DE_COR.map((grupo) => (
        <div key={grupo.titulo} className={g.cartao}>
          <SectionLabel as="h3">{grupo.titulo}</SectionLabel>
          <div className={g.grade}>
            <span className={`${g.cabecalho} ${g.cabecalhoNome}`}>Token</span>
            <span className={g.cabecalho}>Claro</span>
            <span className={g.cabecalho}>Escuro</span>
            {grupo.tokens.map((nome) => (
              <React.Fragment key={nome}>
                <span className={g.nomeToken}>{nome}</span>
                <Chip tema="light" nome={nome} valor={valores.light[nome]} />
                <Chip tema="dark" nome={nome} valor={valores.dark[nome]} />
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </Secao>
  );
}

function Veredito({ razao, minimo }) {
  if (razao == null) return <span className={g.codigo}>—</span>;
  const passa = razao >= minimo;
  return (
    <span className={g.linha}>
      <code>{formatarRazao(razao)}</code>
      <Badge tone={passa ? "success" : "danger"} variant="soft" dot>
        {passa ? "passa" : "reprova"}
      </Badge>
    </span>
  );
}

function Contraste({ valores }) {
  return (
    <Secao
      titulo="Contraste"
      nota="Calculado aqui, com os valores do CSS. Texto precisa de 4,5:1 (AA); o anel de foco, de 3:1 (componente não textual). O laranja de marca reprova como anel no claro por 0,04 — está registrado em tokens.css."
    >
      <div className={g.cartao}>
        <div className={g.grade}>
          <span className={`${g.cabecalho} ${g.cabecalhoNome}`}>Par (mínimo)</span>
          <span className={g.cabecalho}>Claro</span>
          <span className={g.cabecalho}>Escuro</span>
          {PARES_DE_CONTRASTE.map(([frente, fundo, minimo]) => (
            <React.Fragment key={`${frente}/${fundo}`}>
              <span className={g.nomeToken}>
                {frente} / {fundo} ({String(minimo).replace(".", ",")})
              </span>
              <Veredito razao={contraste(valores.light[frente], valores.light[fundo])} minimo={minimo} />
              <Veredito razao={contraste(valores.dark[frente], valores.dark[fundo])} minimo={minimo} />
            </React.Fragment>
          ))}
        </div>
      </div>
    </Secao>
  );
}

function Escalas({ valores }) {
  return (
    <Secao titulo="Tipo, espaço, raio e sombra" nota="Poppins na interface; Lora na saudação, nos títulos, no corpo de nota e nas respostas do agente.">
      <div className={g.cartao}>
        <SectionLabel as="h3">Tipo</SectionLabel>
        {ESCALA_TIPO.map((nome) => (
          <div key={nome} className={g.tipo}>
            <code>
              {nome} · {valores.light[nome]}
            </code>
            <div style={{ fontSize: `var(${nome})` }}>
              <div>
                <span style={{ fontWeight: 400 }}>Reunião às 14h </span>
                <span style={{ fontWeight: 500 }}>com a equipe </span>
                <span style={{ fontWeight: 600 }}>de produto</span>
              </div>
              <div className={g.serif}>
                Bom dia, Carlos. <em>Três tarefas vencem hoje.</em>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className={g.cartao}>
        <SectionLabel as="h3">Espaço</SectionLabel>
        {ESPACOS.map((nome) => (
          <div key={nome} className={g.linha}>
            <code className={g.legenda}>
              {nome} · {valores.light[nome]}
            </code>
            <span className={g.barra} style={{ width: `var(${nome})` }} />
          </div>
        ))}
      </div>
      <div className={g.cartao}>
        <SectionLabel as="h3">Raio e sombra</SectionLabel>
        <div className={g.linha}>
          {RAIOS.map((nome) => (
            <span key={nome} className={g.caixaRaio} style={{ borderRadius: `var(${nome})` }}>
              {nome} · {valores.light[nome]}
            </span>
          ))}
          <span className={g.caixaSombra}>--shadow-popover (só sobreposição)</span>
        </div>
      </div>
    </Secao>
  );
}

function Botoes() {
  return (
    <Secao titulo="Button e IconButton" nota="O primário é tinta invertida (fundo --text). Tab mostra o anel de foco.">
      <div className={g.cartao}>
        {["md", "sm"].map((tamanho) => (
          <div key={tamanho} className={g.linha}>
            <span className={g.legenda}>size={tamanho}</span>
            {BUTTON_VARIANTS.map((variante) => (
              <Button key={variante} variant={variante} size={tamanho}>
                {variante}
              </Button>
            ))}
          </div>
        ))}
        <div className={g.linha}>
          <span className={g.legenda}>estados</span>
          <Button variant="primary" icon={<Icon name="plus" />}>
            Nova tarefa
          </Button>
          <Button variant="secondary" iconRight={<Icon name="chevron-down" />}>
            Projeto
          </Button>
          <Button variant="primary" loading>
            Salvando
          </Button>
          <Button variant="secondary" disabled>
            Desabilitado
          </Button>
        </div>
        <div className={g.linha}>
          <span className={g.legenda}>IconButton</span>
          <IconButton aria-label="Adicionar">
            <Icon name="plus" />
          </IconButton>
          <IconButton aria-label="Editar">
            <Icon name="pencil" />
          </IconButton>
          <IconButton aria-label="Fixar" active aria-pressed="true">
            <Icon name="pin" />
          </IconButton>
          <IconButton aria-label="Excluir">
            <Icon name="trash" />
          </IconButton>
          <IconButton aria-label="Buscar" variant="secondary">
            <Icon name="search" />
          </IconButton>
          <IconButton aria-label="Fechar" size="sm">
            <Icon name="x" />
          </IconButton>
        </div>
      </div>
    </Secao>
  );
}

function Badges() {
  return (
    <Secao titulo="Badge e StatusBadge" nota="O texto de soft e outline é sempre --text (ou --text-2/--text-3 no neutro): a cor vai no fundo, no anel e no ponto.">
      <div className={g.cartao}>
        {BADGE_VARIANTS.map((variante) => (
          <div key={variante} className={g.linha}>
            <span className={g.legenda}>{variante}</span>
            {BADGE_TONES.map((tom) => (
              <Badge key={tom} tone={tom} variant={variante} dot={variante !== "solid"}>
                {tom}
              </Badge>
            ))}
          </div>
        ))}
      </div>
      <div className={g.cartao}>
        <div className={g.linha}>
          <span className={g.legenda}>status</span>
          {STATUS_ANDAMENTO.map((s) => (
            <StatusBadge key={s} value={s} />
          ))}
        </div>
        <div className={g.linha}>
          <span className={g.legenda}>kanban</span>
          {COLUNAS_KANBAN.map((s) => (
            <StatusBadge key={s} value={s} />
          ))}
        </div>
      </div>
    </Secao>
  );
}

function MoverPara({ coluna, onMover }) {
  const [aberto, setAberto] = useState(false);
  const ancora = useRef(null);
  const id = useId();
  return (
    <>
      <PopoverItem
        ref={ancora}
        icon={<Icon name="columns" />}
        aria-haspopup="dialog"
        aria-expanded={aberto}
        aria-controls={id}
        onClick={() => setAberto((v) => !v)}
      >
        Mover para…
      </PopoverItem>
      <Popover id={id} open={aberto} onClose={() => setAberto(false)} anchorRef={ancora} label="Mover para coluna" side="bottom" align="end">
        {COLUNAS_KANBAN.map((c) => (
          <PopoverItem
            key={c}
            selected={c === coluna}
            onClick={() => {
              setAberto(false);
              onMover(c);
            }}
          >
            <StatusBadge value={c} />
          </PopoverItem>
        ))}
      </Popover>
    </>
  );
}

function DemoPopover() {
  const toast = useToast();
  const [status, setStatus] = useState("Em andamento");
  const [coluna, setColuna] = useState("Fazendo");
  const [statusAberto, setStatusAberto] = useState(false);
  const [menuAberto, setMenuAberto] = useState(false);
  const [bordaAberta, setBordaAberta] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const [excluindo, setExcluindo] = useState(false);
  const statusRef = useRef(null);
  const menuRef = useRef(null);
  const bordaRef = useRef(null);
  const statusId = useId();
  const menuId = useId();
  const bordaId = useId();

  const excluir = () => {
    setExcluindo(true);
    setTimeout(() => {
      setExcluindo(false);
      setConfirmar(false);
      toast.show({
        message: "Projeto excluído",
        action: { label: "Desfazer", onClick: () => toast.show({ message: "Projeto restaurado", tone: "success" }) },
      });
    }, 900);
  };

  return (
    <Secao
      titulo="Popover e ConfirmDialog"
      nota="Um só Popover: abaixo da âncora, vira para cima perto do fim da janela, fecha com clique fora ou Escape e devolve o foco. O menu ⋯ abre um popover aninhado (Mover para…) e um ConfirmDialog."
    >
      <div className={g.cartao}>
        <div className={g.linha}>
          <span className={g.legenda}>status</span>
          <Button
            ref={statusRef}
            variant="secondary"
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={statusAberto}
            aria-controls={statusId}
            iconRight={<Icon name="chevron-down" />}
            onClick={() => setStatusAberto((v) => !v)}
          >
            <StatusBadge value={status} />
          </Button>
          <Popover id={statusId} open={statusAberto} onClose={() => setStatusAberto(false)} anchorRef={statusRef} label="Mudar status">
            {STATUS_ANDAMENTO.map((s) => (
              <PopoverItem
                key={s}
                selected={s === status}
                onClick={() => {
                  setStatus(s);
                  setStatusAberto(false);
                }}
              >
                <StatusBadge value={s} />
              </PopoverItem>
            ))}
          </Popover>

          <span className={g.legenda}>coluna: {coluna}</span>
          <IconButton
            ref={menuRef}
            aria-label="Mais ações"
            aria-haspopup="dialog"
            aria-expanded={menuAberto}
            aria-controls={menuId}
            active={menuAberto}
            onClick={() => setMenuAberto((v) => !v)}
          >
            <Icon name="more" />
          </IconButton>
          <Popover id={menuId} open={menuAberto} onClose={() => setMenuAberto(false)} anchorRef={menuRef} label="Ações do projeto" align="end">
            <PopoverItem icon={<Icon name="pencil" />} onClick={() => setMenuAberto(false)}>
              Editar
            </PopoverItem>
            <PopoverItem icon={<Icon name="pin" />} onClick={() => setMenuAberto(false)}>
              Fixar
            </PopoverItem>
            <MoverPara
              coluna={coluna}
              onMover={(c) => {
                setColuna(c);
                setMenuAberto(false);
              }}
            />
            <PopoverItem
              icon={<Icon name="trash" />}
              onClick={() => {
                setMenuAberto(false);
                setConfirmar(true);
              }}
            >
              Excluir…
            </PopoverItem>
          </Popover>
        </div>
      </div>

      <div className={g.cartao}>
        <p className={g.nota}>Role até este botão ficar no rodapé da janela e abra: o popover abre para cima e não sai pela direita.</p>
        <div className={g.borda}>
          <Button
            ref={bordaRef}
            variant="secondary"
            aria-haspopup="dialog"
            aria-expanded={bordaAberta}
            aria-controls={bordaId}
            onClick={() => setBordaAberta((v) => !v)}
          >
            Abrir perto da borda
          </Button>
          <Popover id={bordaId} open={bordaAberta} onClose={() => setBordaAberta(false)} anchorRef={bordaRef} label="Exemplo de posição" width={260}>
            <div style={{ padding: "var(--sp-2)", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
              <SectionLabel as="p">Prazo</SectionLabel>
              <p style={{ color: "var(--text-2)", fontSize: "var(--fs-sm)" }}>
                Conteúdo livre: o popover mede a si mesmo e escolhe o lado.
              </p>
              <Button size="sm" variant="primary" onClick={() => setBordaAberta(false)}>
                Ok
              </Button>
            </div>
          </Popover>
        </div>
      </div>

      <ConfirmDialog
        open={confirmar}
        tone="danger"
        title="Excluir o projeto?"
        description="As frentes e tarefas saem junto. Dá para desfazer pelo aviso logo depois."
        confirmLabel="Excluir"
        busy={excluindo}
        onConfirm={excluir}
        onCancel={() => setConfirmar(false)}
      />
    </Secao>
  );
}

function DemoToast() {
  const toast = useToast();
  return (
    <Secao titulo="Toast" nota="A ação sai em --accent-ink. O tempo pausa com o ponteiro em cima ou com foco dentro.">
      <div className={g.cartao}>
        <div className={g.linha}>
          <Button
            onClick={() =>
              toast.show({
                id: "nota-excluida",
                message: "Nota excluída",
                action: { label: "Desfazer", onClick: () => toast.show({ message: "Nota restaurada", tone: "success" }) },
              })
            }
          >
            Excluir nota
          </Button>
          <Button onClick={() => toast.show({ message: "Tarefa concluída", tone: "success" })}>Sucesso</Button>
          <Button onClick={() => toast.show({ message: "Não deu para salvar. Tente de novo.", tone: "danger" })}>Erro</Button>
        </div>
      </div>
    </Secao>
  );
}

function Diversos() {
  return (
    <Secao titulo="SectionLabel, EmptyState, Spinner e Logo">
      <div className={g.cartao}>
        <SectionLabel>Hoje</SectionLabel>
        <SectionLabel as="h3">Projetos ativos</SectionLabel>
      </div>
      <div className={g.cartao}>
        <EmptyState
          icon="note"
          title="Nenhuma nota ainda"
          description="Escreva na caixa de cima — ela vira nota, evento ou lembrete."
          action={
            <Button variant="primary" icon={<Icon name="plus" />}>
              Nova nota
            </Button>
          }
        />
      </div>
      <div className={g.cartao}>
        <div className={g.linha}>
          <span className={g.legenda}>Spinner</span>
          <Spinner size={12} />
          <Spinner />
          <Spinner size={24} label="Carregando tarefas" />
          <span style={{ color: "var(--accent)" }}>
            <Spinner size={20} />
          </span>
        </div>
        <div className={g.linha}>
          <span className={g.legenda}>Logo</span>
          {[16, 24, 32, 48].map((tamanho) => (
            <Logo key={tamanho} size={tamanho} />
          ))}
          <span style={{ color: "var(--accent)" }}>
            <Logo size={32} title="Fields'" />
          </span>
          <span className={g.ladrilho}>
            <Logo size={30} />
          </span>
          <img src="/favicon.svg" width={32} height={32} alt="Favicon do Fields'" />
        </div>
      </div>
    </Secao>
  );
}

function Icones() {
  return (
    <Secao titulo="Ícones" nota={`${ICON_NAMES.length} desenhos adaptados do Lucide (ISC): grade de 16px, traço de 1,5px, currentColor.`}>
      <div className={g.icones}>
        {ICON_NAMES.map((nome) => (
          <div key={nome} className={g.icone}>
            <Icon name={nome} />
            <code>{nome}</code>
          </div>
        ))}
      </div>
    </Secao>
  );
}

function Galeria() {
  const { valores, sondas } = useValoresDosTokens();
  return (
    <div className={g.pagina}>
      {sondas}
      <header className={g.topo}>
        <div className={g.marca}>
          <Logo size={24} className={g.marcaLogo} />
          <span className={g.marcaNome}>Fields'</span>
          <span className={g.marcaSub}>galeria de UI · só em desenvolvimento</span>
        </div>
        <SeletorDeTema />
      </header>
      <main className={g.conteudo}>
        <Cores valores={valores} />
        <Contraste valores={valores} />
        <Escalas valores={valores} />
        <Botoes />
        <Badges />
        <DemoPopover />
        <DemoToast />
        <Diversos />
        <Icones />
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("galeria")).render(
  <React.StrictMode>
    <ToastProvider>
      <Galeria />
    </ToastProvider>
  </React.StrictMode>,
);
