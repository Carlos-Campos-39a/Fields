import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../api.js";
import { Button, Icon, IconButton, Spinner } from "../ui/index.js";
import {
  DIAS_SEMANA_CURTOS, diaDaSemana, getMonday, hojeISO, isTodayLocal, partesDaData, rotuloDaSemana, somarDias,
} from "../lib/dates.js";
import { useEhMobile } from "../lib/useEhMobile.js";
import { useExclusao } from "../lib/useExclusao.js";
import { useFalha } from "../lib/useFalha.js";
import { MeetingCard } from "./MeetingCard.jsx";
import styles from "./AgendaView.module.css";

const cx = (...c) => c.filter(Boolean).join(" ");
const plural = (n, um, varios) => (n === 1 ? um : varios);

const FORM_VAZIO = { title: "", start_time: "", end_time: "" };
const MAX_NOTAS_NO_RESUMO = 3;

const porHorario = (a, b) => (a.startTime || "").localeCompare(b.startTime || "");

/**
 * Rota #/agenda — a semana (segunda a domingo) no fuso de Brasília: getMonday, "hoje" e os rótulos
 * saem de lib/dates.js, que nunca usa o fuso do navegador. Os dias são "YYYY-MM-DD", como no banco.
 *
 * Desktop: a grade dos sete dias. Celular (< 768px): UM dia por vez, com a fileira dos sete dias no
 * topo para trocar — sete colunas de 120px numa tela de 375px eram rolagem lateral sem fim.
 * Trocar de semana mantém o dia da semana escolhido (quinta → quinta).
 */
export function AgendaView() {
  const falha = useFalha();
  const excluir = useExclusao();
  const ehMobile = useEhMobile();
  const [weekStart, setWeekStart] = useState(() => getMonday());
  const [diaSel, setDiaSel]       = useState(() => hojeISO());
  const [meetings, setMeetings]   = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erroLeitura, setErroLeitura] = useState(false);
  const [expanded, setExpanded]   = useState(null);
  const [addingTo, setAddingTo]   = useState(null);
  const [form, setForm]           = useState(FORM_VAZIO);
  const [criando, setCriando]     = useState(false);
  const criandoRef = useRef(false);
  const reunioesRef = useRef(meetings);
  reunioesRef.current = meetings;
  const semanaRef = useRef(weekStart);
  semanaRef.current = weekStart;
  const seq = useRef(0);
  const focarAdicionar = useRef(null); // o dia cujo "+ Reunião" recebe o foco ao fechar o formulário
  const base = useId();

  const days = Array.from({ length: 7 }, (_, i) => somarDias(weekStart, i));
  const diaVisivel = days.includes(diaSel) ? diaSel : days[0];

  // A semana do MOMENTO da resposta, não a da chamada: no monólito, restaurar uma reunião depois de
  // trocar de semana recarregava a semana antiga por cima da nova (o loadWeek fechava sobre o
  // weekStart do render em que o toast nasceu) e a tela nova ficava vazia. E só a ÚLTIMA ida pinta:
  // clicar ← ← ← rápido não deixa uma resposta lenta de outra semana por cima.
  const carregarSemana = useCallback(async ({ silencioso = false } = {}) => {
    const minha = ++seq.current;
    const inicio = semanaRef.current;
    if (!silencioso) setCarregando(true);
    try {
      const { meetings: m } = await api.getMeetings({ from: inicio, to: somarDias(inicio, 6) });
      if (minha !== seq.current) return;
      setMeetings(Array.isArray(m) ? m : []);
      setErroLeitura(false);
    } catch (e) {
      if (minha !== seq.current) return;
      setErroLeitura(true);
      falha("AGENDA_LEITURA_FALHOU", "Não foi possível carregar a semana.", e);
    } finally {
      if (minha === seq.current) setCarregando(false);
    }
  }, [falha]);

  useEffect(() => { carregarSemana(); }, [weekStart, carregarSemana]);

  const byDate = {};
  days.forEach((d) => { byDate[d] = []; });
  meetings.forEach((m) => { if (byDate[m.date]) byDate[m.date].push(m); });

  function mudarSemana(delta) {
    setWeekStart((d) => somarDias(d, 7 * delta));
    setDiaSel((d) => somarDias(d, 7 * delta));
    setAddingTo(null);
    setExpanded(null);
  }

  function irParaHoje() {
    const segunda = getMonday();
    // Formulário e cartão aberto são da semana que sai de vista; na mesma semana, ficam.
    if (segunda !== weekStart) {
      setAddingTo(null);
      setExpanded(null);
    }
    setWeekStart(segunda);
    setDiaSel(hojeISO());
  }

  function updMeeting(id, patch) { setMeetings((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m))); }

  function abrirForm(date) {
    setAddingTo(date);
    setForm(FORM_VAZIO);
    setExpanded(null);
  }

  function fecharForm(date) {
    focarAdicionar.current = date;
    setAddingTo(null);
    setForm(FORM_VAZIO);
  }

  async function addMeeting(date) {
    const titulo = form.title.trim();
    if (criandoRef.current || !titulo) return; // sem título o Salvar fica desabilitado; o Enter também não grava
    criandoRef.current = true;
    setCriando(true);
    try {
      const { meeting } = await api.createMeeting({ title: titulo, date, start_time: form.start_time, end_time: form.end_time });
      setMeetings((prev) => [...prev, meeting]);
      fecharForm(date);
    } catch (e) {
      // O formulário fica aberto e preenchido: nada do que foi digitado se perde.
      falha("REUNIAO_CRIAR_FALHOU", "Não foi possível criar a reunião.", e);
    } finally {
      criandoRef.current = false;
      setCriando(false);
    }
  }

  function deleteMeeting(id) {
    const indice = reunioesRef.current.findIndex((m) => m.id === id);
    const item = reunioesRef.current[indice];
    if (!item) return; // já saiu da tela (duplo clique): o primeiro clique é quem exclui
    excluir({
      entidade: "REUNIAO", mensagem: "Reunião excluída",
      tirar: () => { setMeetings((prev) => prev.filter((m) => m.id !== id)); setExpanded((e) => (e === id ? null : e)); },
      devolver: () => setMeetings((prev) => [...prev.slice(0, indice), item, ...prev.slice(indice)]),
      apagar: () => api.deleteMeeting(id),
      restaurar: () => api.restaurarMeeting(id),
      aposRestaurar: () => carregarSemana({ silencioso: true }),
    });
  }

  async function saveMust(meeting, val) {
    const antes = meeting.must ?? "";
    updMeeting(meeting.id, { must: val });
    try {
      await api.updateMeeting(meeting.id, { must: val });
      return true;
    } catch (e) {
      updMeeting(meeting.id, { must: antes });
      falha("REUNIAO_MUST_FALHOU", "Não foi possível salvar o Must.", e);
      return false;
    }
  }

  // Um dia: cabeçalho (só no desktop — no celular quem diz o dia é a fileira de cima), o resumo dos
  // Musts e das notas, as reuniões e o "+ Reunião". Função, não componente: nada aqui tem estado
  // próprio, e um componente declarado dentro do render remontaria a cada tecla.
  const renderDia = (dateStr) => {
    const hoje = isTodayLocal(dateStr);
    const reunioes = byDate[dateStr].slice().sort(porHorario);
    const musts = reunioes.filter((m) => m.must?.trim());
    const notas = reunioes.flatMap((m) => (Array.isArray(m.comments) ? m.comments : []));
    const tituloId = `${base}-${dateStr}`;
    const nome = DIAS_SEMANA_CURTOS[diaDaSemana(dateStr)];
    const numero = partesDaData(dateStr)?.dia;

    return (
      <section
        key={dateStr}
        className={cx(styles.dia, hoje && styles.diaHoje)}
        aria-labelledby={ehMobile ? undefined : tituloId}
        aria-label={ehMobile ? `${nome} ${numero}${hoje ? ", hoje" : ""}` : undefined}
      >
        {!ehMobile && (
          <h3 id={tituloId} className={styles.cabecalhoDia}>
            <span className={styles.nomeDia}>{nome}</span>
            <span className={styles.numeroDia}>{numero}</span>
            {hoje && <span className="sr-only">, hoje</span>}
          </h3>
        )}

        {musts.length > 0 && (
          <div className={styles.musts}>
            <h4 className={styles.resumoTitulo}>
              <Icon name="flag" size={12} className={styles.iconeMust} />
              Must do
            </h4>
            <ul className={styles.resumoLista}>
              {musts.map((m) => (
                <li key={m.id}>
                  <span className={styles.resumoReuniao}>{m.title}</span>
                  <p className={styles.resumoMust}>{m.must}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {notas.length > 0 && (
          <div className={styles.notas}>
            <h4 className={styles.resumoTitulo}>
              <Icon name="message" size={12} />
              Notas
            </h4>
            <ul className={styles.resumoLista}>
              {notas.slice(0, MAX_NOTAS_NO_RESUMO).map((c, i) => (
                <li key={c.id ?? i} className={styles.resumoNota}>{c.text}</li>
              ))}
            </ul>
            {notas.length > MAX_NOTAS_NO_RESUMO && (
              <p className={styles.mais}>+{notas.length - MAX_NOTAS_NO_RESUMO} mais</p>
            )}
          </div>
        )}

        <div className={styles.reunioes}>
          {reunioes.length > 0 && (
            <ul className={styles.listaReunioes}>
              {reunioes.map((meeting) => (
                <li key={meeting.id}>
                  <MeetingCard
                    meeting={meeting}
                    hoje={hoje}
                    expandida={expanded === meeting.id}
                    onAlternar={() => setExpanded((e) => (e === meeting.id ? null : meeting.id))}
                    onExcluir={() => deleteMeeting(meeting.id)}
                    onComentarios={(comments) => updMeeting(meeting.id, { comments })}
                    onSalvarMust={(val) => saveMust(meeting, val)}
                  />
                </li>
              ))}
            </ul>
          )}

          {ehMobile && reunioes.length === 0 && !carregando && addingTo !== dateStr && (
            <p className={styles.semReunioes}>Nenhuma reunião neste dia.</p>
          )}

          {addingTo === dateStr ? (
            <form
              className={styles.form}
              aria-label="Nova reunião"
              onSubmit={(e) => { e.preventDefault(); addMeeting(dateStr); }}
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); fecharForm(dateStr); } }}
            >
              {/* autoFocus: o formulário só nasce do clique em "+ Reunião"; o foco vai para onde se digita. */}
              <input
                autoFocus
                className={styles.campo}
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                aria-label="Título da reunião"
                placeholder="Título da reunião"
              />
              <div className={styles.horas}>
                <label className={styles.campoHora}>
                  <span className={styles.rotuloHora}>Início</span>
                  <input
                    type="time"
                    className={styles.campo}
                    value={form.start_time}
                    onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))}
                  />
                </label>
                <label className={styles.campoHora}>
                  <span className={styles.rotuloHora}>Fim</span>
                  <input
                    type="time"
                    className={styles.campo}
                    value={form.end_time}
                    onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))}
                  />
                </label>
              </div>
              <div className={styles.acoesForm}>
                <Button type="submit" variant="primary" size="sm" loading={criando} disabled={!form.title.trim()}>
                  Salvar
                </Button>
                <Button variant="ghost" size="sm" onClick={() => fecharForm(dateStr)}>
                  Cancelar
                </Button>
              </div>
            </form>
          ) : (
            <Button
              ref={(el) => {
                if (el && focarAdicionar.current === dateStr) {
                  focarAdicionar.current = null;
                  el.focus({ preventScroll: true });
                }
              }}
              variant="ghost"
              size={ehMobile ? "md" : "sm"}
              icon={<Icon name="plus" />}
              className={styles.adicionar}
              aria-label={`Nova reunião em ${nome} ${numero}`}
              onClick={() => abrirForm(dateStr)}
            >
              Reunião
            </Button>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className={styles.tela}>
      <header className={styles.cabecalho}>
        <div className={styles.titulos}>
          <h2 className={styles.tituloTela}>Agenda</h2>
          <p className={styles.rotuloSemana}>
            <span aria-live="polite">{rotuloDaSemana(weekStart)}</span>
            {carregando && <Spinner size={14} label="Carregando a semana" className={styles.spinner} />}
          </p>
        </div>
        <div className={styles.navegacao}>
          <IconButton variant="secondary" aria-label="Semana anterior" onClick={() => mudarSemana(-1)}>
            <Icon name="chevron-left" />
          </IconButton>
          <Button variant="secondary" size="sm" className={styles.hoje} onClick={irParaHoje}>
            Hoje
          </Button>
          <IconButton variant="secondary" aria-label="Próxima semana" onClick={() => mudarSemana(1)}>
            <Icon name="chevron-right" />
          </IconButton>
        </div>

        {ehMobile && (
          <div className={styles.dias} role="group" aria-label="Dia da semana">
            {days.map((d) => {
              const n = byDate[d].length;
              const hoje = isTodayLocal(d);
              const sel = d === diaVisivel;
              return (
                <button
                  key={d}
                  type="button"
                  className={cx(styles.botaoDia, sel && styles.botaoDiaSel, hoje && styles.botaoDiaHoje)}
                  aria-pressed={sel}
                  aria-current={hoje ? "date" : undefined}
                  onClick={() => setDiaSel(d)}
                >
                  <span className={styles.botaoDiaNome}>{DIAS_SEMANA_CURTOS[diaDaSemana(d)]}</span>
                  <span className={styles.botaoDiaNumero}>{partesDaData(d)?.dia}</span>
                  <span className={cx(styles.ponto, n > 0 && styles.pontoCheio)} aria-hidden="true" />
                  {n > 0 && <span className="sr-only">, {n} {plural(n, "reunião", "reuniões")}</span>}
                </button>
              );
            })}
          </div>
        )}
      </header>

      {erroLeitura && (
        <div className={styles.alerta} role="alert">
          <span>Não foi possível carregar a semana.</span>
          <Button size="sm" variant="ghost" onClick={() => carregarSemana()}>
            Tentar de novo
          </Button>
        </div>
      )}

      <div className={styles.rolagem} aria-busy={carregando || undefined}>
        <div className={cx(styles.grade, ehMobile && styles.umDia)}>
          {(ehMobile ? [diaVisivel] : days).map(renderDia)}
        </div>
      </div>
    </div>
  );
}
