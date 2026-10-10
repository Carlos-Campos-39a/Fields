import { useId, useRef, useState } from "react";
import { api } from "../api.js";
import { ehDataISO } from "../lib/dates.js";
import { useOntologia } from "../lib/ontologia.js";
import { useEhMobile } from "../lib/useEhMobile.js";
import { useFalha } from "../lib/useFalha.js";
import { useGuardaDeSaida } from "../lib/useHashRoute.js";
import { Button, ConfirmDialog, Icon, SectionLabel } from "../ui/index.js";
import { IconeDoTipo } from "./IconeDoTipo.jsx";
import css from "./EditForm.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");

const HORA_ISO = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

// O formulário parte da entrada como veio do banco — e o banco antigo tinha de tudo: tags nulas (o
// .join derrubava a tela inteira), type nulo, data e hora em texto livre.
function formDe(entry, tipoPadrao) {
  return {
    type: entry.type || tipoPadrao || "note",
    title: entry.title ?? "",
    content: entry.content ?? "",
    tags: Array.isArray(entry.tags) ? entry.tags.filter((t) => t != null && t !== "").join(", ") : "",
    date: entry.date ?? "",
    time: entry.time ?? "",
  };
}

// "#TCC, trabalho, , TCC" → ["TCC", "trabalho"]: o "#" é da tela (ela já o desenha), vazio some, e
// repetida conta uma vez — repetida também duplicava a key da lista de tags.
function tagsDoTexto(texto) {
  const vistas = new Set();
  const tags = [];
  for (const bruta of texto.split(",")) {
    const t = bruta.trim().replace(/^#+/, "").trim();
    if (!t || vistas.has(t)) continue;
    vistas.add(t);
    tags.push(t);
  }
  return tags;
}

function validar(form) {
  const erros = {};
  if (!form.title.trim()) erros.title = "Dê um título à entrada.";
  if (!form.content.trim()) erros.content = "O conteúdo não pode ficar vazio.";
  return erros;
}

/**
 * Edição de uma entrada. Os tipos vêm da ontologia (enums.tipo_entrada + rótulo), como rádios
 * nativos (setas do teclado de graça). Nada é recusado em silêncio: campo obrigatório vazio diz o
 * quê e recebe o foco; falha ao salvar não fecha o formulário — o texto digitado fica, e o toast
 * diz que não salvou. Sair com alteração pede confirmação.
 *
 * Teclado: Ctrl/⌘+Enter salva de qualquer campo; Esc cancela.
 */
export function EditForm({ entry, onSave, onCancel }) {
  const { enums, rotulo } = useOntologia();
  const falha = useFalha();
  const tamanho = useEhMobile() ? "md" : "sm"; // 36px no celular: alvo de dedo
  const [form, setForm] = useState(() => formDe(entry, enums.tipo_entrada[0]));
  const original = useRef(form);
  const [erros, setErros] = useState({});
  const [saving, setSaving] = useState(false);
  const [descartar, setDescartar] = useState(false);
  const tituloRef = useRef(null);
  const conteudoRef = useRef(null);
  const ids = {
    cabecalho: useId(),
    titulo: useId(),
    conteudo: useId(),
    data: useId(),
    hora: useId(),
    tags: useId(),
    tagsDica: useId(),
    erroTitulo: useId(),
    erroConteudo: useId(),
    legadoData: useId(),
    legadoHora: useId(),
  };

  // Tipo fora do enum (dado antigo ou tipo novo que a ontologia ainda não trouxe) aparece como
  // opção marcada, em vez de nenhum rádio marcado e o valor indo de volta sem a tela mostrar.
  const tipos = enums.tipo_entrada.includes(form.type) ? enums.tipo_entrada : [...enums.tipo_entrada, form.type];

  // Data/hora em texto livre: o <input type=date|time> não consegue mostrá-las (fica vazio), mas o
  // valor continua no form e volta intacto — só é trocado se o Carlos escolher outro.
  const dataLegada = form.date && !ehDataISO(form.date) ? form.date : null;
  const horaLegada = form.time && !HORA_ISO.test(form.time) ? form.time : null;

  const sujo = Object.keys(form).some((k) => form[k] !== original.current[k]);

  // Sair com alteração pede confirmação também quando a saída é NAVEGAR (outra entrada na lista,
  // anterior/próxima, uma vista, o voltar): o App pergunta, e a rota só troca se descartar. Durante
  // o PATCH não segura — a resposta que chega depois de trocar de entrada já é tratada pela página.
  useGuardaDeSaida(sujo && !saving);

  function mudar(campo, valor) {
    setForm((f) => ({ ...f, [campo]: valor }));
    if (erros[campo]) setErros((e) => ({ ...e, [campo]: undefined }));
  }

  async function save() {
    if (saving) return;
    const novos = validar(form);
    if (novos.title || novos.content) {
      setErros(novos);
      (novos.title ? tituloRef : conteudoRef).current?.focus();
      return;
    }
    setSaving(true);
    try {
      const { entry: updated } = await api.updateEntry(entry.id, {
        type: form.type,
        title: form.title.trim(),
        content: form.content.trim(),
        tags: tagsDoTexto(form.tags),
        date: form.date || null,
        time: form.time || null,
      });
      onSave(updated ?? { ...entry, ...form, tags: tagsDoTexto(form.tags) });
    } catch (e) {
      falha("ENTRADA_SALVAR_FALHOU", "Não foi possível salvar a entrada.", e);
    } finally {
      setSaving(false);
    }
  }

  function pedirCancelar() {
    if (saving) return;
    if (sujo) setDescartar(true);
    else onCancel();
  }

  function aoTeclar(e) {
    if (e.nativeEvent?.isComposing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape" && !descartar) {
      e.preventDefault();
      pedirCancelar();
    }
  }

  return (
    <>
      <form
        className={css.form}
        noValidate
        aria-labelledby={ids.cabecalho}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        onKeyDown={aoTeclar}
      >
        <div className={css.cabecalho}>
          <SectionLabel as="h1" id={ids.cabecalho}>
            Editando entrada
          </SectionLabel>
          <div className={css.acoes}>
            <Button variant="ghost" size={tamanho} onClick={pedirCancelar} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" size={tamanho} loading={saving}>
              {saving ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        </div>

        <fieldset className={css.grupo}>
          <legend className={css.rotulo}>Tipo</legend>
          <div className={css.tipos}>
            {tipos.map((key) => (
              <label key={key} className={css.opcao}>
                <input
                  type="radio"
                  name="tipo"
                  value={key}
                  checked={form.type === key}
                  onChange={() => mudar("type", key)}
                  className={css.radio}
                />
                <span className={css.chip}>
                  <IconeDoTipo tipo={key} size={14} className={css.chipIcone} />
                  {rotulo("tipo_entrada", key)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className={css.campo}>
          <label htmlFor={ids.titulo} className={css.rotulo}>
            Título
          </label>
          <input
            id={ids.titulo}
            ref={tituloRef}
            autoFocus
            value={form.title}
            onChange={(e) => mudar("title", e.target.value)}
            aria-invalid={erros.title ? true : undefined}
            aria-describedby={erros.title ? ids.erroTitulo : undefined}
            className={cx(css.entrada, css.titulo, erros.title && css.invalido)}
          />
          {erros.title && (
            <p id={ids.erroTitulo} className={css.erro}>
              <Icon name="alert" size={14} />
              {erros.title}
            </p>
          )}
        </div>

        <div className={css.campo}>
          <label htmlFor={ids.conteudo} className={css.rotulo}>
            Conteúdo
          </label>
          <textarea
            id={ids.conteudo}
            ref={conteudoRef}
            value={form.content}
            onChange={(e) => mudar("content", e.target.value)}
            rows={9}
            aria-invalid={erros.content ? true : undefined}
            aria-describedby={erros.content ? ids.erroConteudo : undefined}
            className={cx(css.entrada, css.conteudo, erros.content && css.invalido)}
          />
          {erros.content && (
            <p id={ids.erroConteudo} className={css.erro}>
              <Icon name="alert" size={14} />
              {erros.content}
            </p>
          )}
        </div>

        <div className={css.linha}>
          <div className={css.campo}>
            <label htmlFor={ids.data} className={css.rotulo}>
              Data
            </label>
            <input
              id={ids.data}
              type="date"
              value={dataLegada ? "" : form.date}
              onChange={(e) => mudar("date", e.target.value)}
              aria-describedby={dataLegada ? ids.legadoData : undefined}
              className={css.entrada}
            />
            {dataLegada && (
              <p id={ids.legadoData} className={css.dica}>
                Registrada como texto: “{dataLegada}”. Escolha uma data para substituir.
              </p>
            )}
          </div>
          <div className={css.campo}>
            <label htmlFor={ids.hora} className={css.rotulo}>
              Hora
            </label>
            <input
              id={ids.hora}
              type="time"
              value={horaLegada ? "" : form.time}
              onChange={(e) => mudar("time", e.target.value)}
              aria-describedby={horaLegada ? ids.legadoHora : undefined}
              className={css.entrada}
            />
            {horaLegada && (
              <p id={ids.legadoHora} className={css.dica}>
                Registrada como texto: “{horaLegada}”. Escolha uma hora para substituir.
              </p>
            )}
          </div>
        </div>

        <div className={css.campo}>
          <label htmlFor={ids.tags} className={css.rotulo}>
            Tags
          </label>
          <input
            id={ids.tags}
            value={form.tags}
            onChange={(e) => mudar("tags", e.target.value)}
            placeholder="Ex.: Trabalho, TCC"
            aria-describedby={ids.tagsDica}
            className={css.entrada}
          />
          <p id={ids.tagsDica} className={css.dica}>
            Separadas por vírgula.
          </p>
        </div>
      </form>

      <ConfirmDialog
        open={descartar}
        tone="danger"
        title="Descartar as alterações?"
        description="O que você mudou nesta entrada ainda não foi salvo."
        confirmLabel="Descartar"
        cancelLabel="Continuar editando"
        onConfirm={() => {
          setDescartar(false);
          onCancel();
        }}
        onCancel={() => setDescartar(false)}
      />
    </>
  );
}
