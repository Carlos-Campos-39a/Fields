import { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import { api } from "./api.js";

// ─── Constants ──────────────────────────────────────────────
const TYPE = {
  note:     { label: "Nota",      icon: "✦",  color: "#E8602C", bg: "#fdf0ea", border: "#f5c4a8" },
  event:    { label: "Evento",    icon: "◈",  color: "#5a5a6a", bg: "#f0f0f4", border: "#d0d0dc" },
  reminder: { label: "Lembrete", icon: "◉",  color: "#7a5c3a", bg: "#faf3ea", border: "#e8d4b8" },
  lang_fr:  { label: "Francês",  icon: "🇫🇷", color: "#0055A4", bg: "#e8eeff", border: "#90aee8" },
  lang_jp:  { label: "Japonês",  icon: "🇯🇵", color: "#BC002D", bg: "#ffecec", border: "#f5a0a0" },
};

const FILTERS = [
  { key: "all",      label: "Tudo"      },
  { key: "note",     label: "Notas"     },
  { key: "event",    label: "Eventos"   },
  { key: "reminder", label: "Lembretes" },
  { key: "pinned",   label: "Fixados"   },
];

const LANG_SUB = [
  { key: "lang_fr", label: "Francês", flag: "🇫🇷", color: "#0055A4", bg: "#e8eeff", border: "#90aee8" },
  { key: "lang_jp", label: "Japonês", flag: "🇯🇵", color: "#BC002D", bg: "#ffecec", border: "#f5a0a0" },
];

// ─── Helpers ─────────────────────────────────────────────────
function parseInput(text) {
  const t = text.trim();
  if (/^(evento|event)\s+/i.test(t))          return { type: "event",    body: t.replace(/^(evento|event)\s+/i, "") };
  if (/^(lembrete|reminder)\s+/i.test(t))      return { type: "reminder", body: t.replace(/^(lembrete|reminder)\s+/i, "") };
  if (/^(frances|fr)\s+/i.test(t))             return { type: "lang_fr",  body: t.replace(/^(frances|fr)\s+/i, "") };
  if (/^(japones|china|nihon|jp)\s+/i.test(t)) return { type: "lang_jp",  body: t.replace(/^(japones|china|nihon|jp)\s+/i, "") };
  return { type: "note", body: t };
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

function relativeDate(d) {
  if (!d) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dt = new Date(d + "T00:00:00");
  const diff = Math.round((dt - today) / 86400000);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Amanhã";
  if (diff === -1) return "Ontem";
  if (diff > 0 && diff < 7) return `Em ${diff} dias`;
  return formatDate(d);
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ─── Logo ────────────────────────────────────────────────────
// F' — monograma sólido e geométrico, apóstrofo como acento anguloso (estilo executivo/corporativo)
function LogoIcon({ size = 16, color = "white" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* F — bloco sólido, proporções equilibradas */}
      <path d="M8 5 L24.5 5 L24.5 9.5 L13 9.5 L13 14 L20.5 14 L20.5 18.5 L13 18.5 L13 27 L8 27 Z"
            fill={color}/>
      {/* Apóstrofo — acento anguloso, sólido */}
      <path d="M26.5 4 L29.5 4 L27.3 11.5 L25.3 11.5 Z" fill={color}/>
    </svg>
  );
}

// ─── Toast ──────────────────────────────────────────────────
function Toast({ msg, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return (
    <div style={{
      position: "fixed", bottom: 100, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, background: "#2a2a2a", color: "white",
      padding: "10px 20px", borderRadius: "var(--r-full)",
      fontSize: 13, fontWeight: 500, boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
      whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 8,
      border: "1px solid rgba(255,255,255,0.1)",
    }}>
      <span style={{ color: "#E8602C" }}>✓</span>{msg}
    </div>
  );
}

// ─── Tag ────────────────────────────────────────────────────
function Tag({ label }) {
  return (
    <span style={{
      display: "inline-block", fontSize: 11, fontWeight: 600,
      padding: "2px 10px", borderRadius: "var(--r-full)",
      background: "rgba(232,96,44,0.15)", color: "#f0956a",
      border: "1px solid rgba(232,96,44,0.25)", letterSpacing: "0.02em",
    }}>{label}</span>
  );
}

// ─── ActionBtn ───────────────────────────────────────────────
function ActionBtn({ label, onClick, active, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? (danger ? "rgba(220,38,38,0.15)" : "rgba(232,96,44,0.12)") : "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.1)", borderRadius: "var(--r-full)",
        padding: "6px 14px", fontSize: 12, fontWeight: 600,
        color: danger ? (hov ? "#f87171" : "rgba(255,255,255,0.4)") : active ? "#E8602C" : "rgba(255,255,255,0.55)",
        cursor: "pointer", transition: "all 0.15s",
      }}>{label}</button>
  );
}

// ─── Sidebar Entry Item ──────────────────────────────────────
function SidebarItem({ entry, active, onClick }) {
  const meta = TYPE[entry.type] || TYPE.note;
  const isLang = entry.type.startsWith("lang_");
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        padding: "9px 14px", cursor: "pointer",
        background: active ? "rgba(232,96,44,0.15)" : hov ? "rgba(255,255,255,0.05)" : "transparent",
        borderLeft: `3px solid ${active ? "#E8602C" : "transparent"}`,
        transition: "all 0.12s",
        borderRadius: "0 8px 8px 0",
        marginRight: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
        <span style={{ fontSize: isLang ? 13 : 10, color: active ? "#f0956a" : "rgba(255,255,255,0.4)" }}>
          {meta.icon}
        </span>
        <span style={{
          fontSize: 13, fontWeight: active ? 600 : 400,
          color: active ? "white" : "rgba(255,255,255,0.75)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          maxWidth: 170,
        }}>{entry.title}</span>
        {entry.pinned && <span style={{ color: "#E8602C", fontSize: 10, marginLeft: "auto", flexShrink: 0 }}>★</span>}
      </div>
      <div style={{
        fontSize: 11, color: "rgba(255,255,255,0.3)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        paddingLeft: 17,
      }}>{entry.content?.slice(0, 50)}</div>
    </div>
  );
}

// ─── Thread Section ──────────────────────────────────────────
function ThreadSection({ entry, onUpdate }) {
  const [threads, setThreads]           = useState(entry.threads || []);
  const [text, setText]                 = useState("");
  const [saving, setSaving]             = useState(false);
  const [linkedTask, setLinkedTask]     = useState(null); // { taskId, taskName, frenteName, projName, frenteId, projId, currentComments }
  const [showPicker, setShowPicker]     = useState(false);
  const [pickerPos, setPickerPos]       = useState({ top: 0, left: 0 });
  const [pickerProjs, setPickerProjs]   = useState(null); // null = não carregado
  const [pickerLoad, setPickerLoad]     = useState(false);
  const textRef      = useRef();
  const pickerBtnRef = useRef();
  const pickerPanRef = useRef();

  useEffect(() => { setThreads(entry.threads || []); }, [entry.id]);
  useEffect(() => { setLinkedTask(null); }, [entry.id]);

  useEffect(() => {
    if (!showPicker) return;
    function handler(e) {
      if (pickerBtnRef.current?.contains(e.target)) return;
      if (pickerPanRef.current?.contains(e.target)) return;
      setShowPicker(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPicker]);

  async function openPicker(e) {
    e.stopPropagation();
    if (showPicker) { setShowPicker(false); return; }
    const rect = pickerBtnRef.current.getBoundingClientRect();
    setPickerPos({ top: rect.top, left: rect.left });
    setShowPicker(true);
    if (!pickerProjs) {
      setPickerLoad(true);
      try { const { projects } = await api.getProjects(); setPickerProjs(projects); }
      catch { setPickerProjs([]); }
      finally { setPickerLoad(false); }
    }
  }

  function selectTask(proj, frente, task) {
    setLinkedTask({ taskId: task.id, taskName: task.name, frenteName: frente.name, projName: proj.name, frenteId: frente.id, projId: proj.id, currentComments: task.comments || [] });
    setShowPicker(false);
  }

  async function addNote() {
    if (!text.trim() || saving) return;
    setSaving(true);
    const note = { id: Date.now().toString(), text: text.trim(), createdAt: new Date().toISOString() };
    const updated = [...threads, note];
    setThreads(updated);
    setText("");
    try {
      const { entry: e } = await api.updateEntry(entry.id, { threads: updated });
      onUpdate(e);
      if (linkedTask) {
        const taskCmt = { id: crypto.randomUUID(), text: note.text, created_at: new Date().toISOString() };
        const nextCmts = [...linkedTask.currentComments, taskCmt];
        await api.updateTask(linkedTask.taskId, { comments: nextCmts });
        setLinkedTask(prev => prev ? { ...prev, currentComments: nextCmts } : null);
      }
    } finally { setSaving(false); }
  }

  async function deleteNote(id) {
    const updated = threads.filter(t => t.id !== id);
    setThreads(updated);
    try {
      const { entry: e } = await api.updateEntry(entry.id, { threads: updated });
      onUpdate(e);
    } catch {}
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNote(); }
  }

  return (
    <div style={{ marginTop: 40, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 28, paddingBottom: 40 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16 }}>
        Anotações · {threads.length}
      </div>

      {/* Thread messages */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        {threads.length === 0 && (
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.3)", fontStyle: "italic", padding: "8px 0" }}>
            Nenhuma anotação ainda. Adicione pensamentos, atualizações ou contexto abaixo.
          </div>
        )}
        {threads.map(t => (
          <div key={t.id} style={{
            background: "rgba(232,96,44,0.1)", border: "1px solid rgba(232,96,44,0.2)",
            borderRadius: 14, padding: "12px 16px", position: "relative",
          }}>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.85)", lineHeight: 1.65, whiteSpace: "pre-wrap", margin: 0, paddingRight: 24 }}>{t.text}</p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{formatDateTime(t.createdAt)}</span>
              <button onClick={() => deleteNote(t.id)} style={{ background: "none", border: "none", fontSize: 15, color: "rgba(255,255,255,0.3)", cursor: "pointer", lineHeight: 1, padding: "0 2px" }}>×</button>
            </div>
          </div>
        ))}
      </div>

      {/* Linked task chip */}
      {linkedTask && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>→</span>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            background: "rgba(232,96,44,0.1)", border: "1px solid rgba(232,96,44,0.28)",
            borderRadius: 20, padding: "3px 10px 3px 12px",
          }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{linkedTask.projName}</span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>›</span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{linkedTask.frenteName}</span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>›</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#f0956a" }}>{linkedTask.taskName}</span>
            <button onClick={() => setLinkedTask(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.28)", fontSize: 13, padding: "0 0 0 3px", lineHeight: 1 }}>×</button>
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <textarea
          ref={textRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="Adicionar anotação… (Enter para enviar, Shift+Enter para nova linha)"
          style={{
            flex: 1, border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 12,
            padding: "10px 14px", fontSize: 13, resize: "none",
            outline: "none", fontFamily: "inherit", color: "rgba(255,255,255,0.85)",
            lineHeight: 1.6, transition: "border-color 0.15s",
            background: "rgba(255,255,255,0.05)",
          }}
          onFocus={e => e.target.style.borderColor = "#E8602C"}
          onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
          {/* Link-to-task button */}
          <button ref={pickerBtnRef} onClick={openPicker} title="Vincular a uma task" style={{
            background: linkedTask ? "rgba(232,96,44,0.18)" : "rgba(255,255,255,0.07)",
            border: `1px solid ${linkedTask ? "rgba(232,96,44,0.4)" : "rgba(255,255,255,0.12)"}`,
            borderRadius: 10, padding: "8px 12px", color: linkedTask ? "#E8602C" : "rgba(255,255,255,0.4)",
            cursor: "pointer", fontSize: 13, transition: "all 0.15s", lineHeight: 1,
          }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{ display: "block" }}>
              <path d="M2 1h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5.5L2 15V2a1 1 0 0 1 1-1z"/>
            </svg>
          </button>
          {/* Send button */}
          <button onClick={addNote} disabled={!text.trim() || saving} style={{
            background: text.trim() ? "#E8602C" : "rgba(255,255,255,0.1)",
            border: "none", borderRadius: 10, padding: "8px 16px",
            color: "white", fontSize: 16, fontWeight: 700,
            cursor: text.trim() ? "pointer" : "default", transition: "all 0.15s",
          }}>↑</button>
        </div>
      </div>

      {/* Task picker portal */}
      {showPicker && ReactDOM.createPortal(
        <div ref={pickerPanRef} style={{
          position: "fixed", top: pickerPos.top, left: pickerPos.left,
          transform: "translateY(-100%) translateY(-8px)",
          zIndex: 9999, width: 310, maxHeight: 360, overflowY: "auto",
          background: "#1e1e1e", border: "1px solid rgba(255,255,255,0.13)",
          borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.75)",
        }}>
          <div style={{ padding: "11px 14px 9px", borderBottom: "1px solid rgba(255,255,255,0.07)", position: "sticky", top: 0, background: "#1e1e1e" }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Vincular a task</span>
          </div>
          {pickerLoad ? (
            <div style={{ padding: "20px 14px", fontSize: 12, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>Carregando…</div>
          ) : !pickerProjs || pickerProjs.length === 0 ? (
            <div style={{ padding: "16px 14px", fontSize: 12, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>Nenhum projeto encontrado.</div>
          ) : pickerProjs.map(proj => (
            <div key={proj.id}>
              {/* Project header */}
              <div style={{ padding: "9px 14px 4px", fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.55)", letterSpacing: "0.03em", background: "rgba(255,255,255,0.02)" }}>
                {proj.name}
              </div>
              {proj.frentes?.map(frente => (
                <div key={frente.id}>
                  {/* Frente header */}
                  <div style={{ padding: "4px 14px 2px 22px", fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)", letterSpacing: "0.04em" }}>
                    ▸ {frente.name}
                  </div>
                  {frente.tasks?.filter(t => t.status !== "Concluído").map(task => {
                    const isSelected = linkedTask?.taskId === task.id;
                    return (
                      <div key={task.id} onClick={() => selectTask(proj, frente, task)} style={{
                        padding: "7px 14px 7px 32px", fontSize: 12, cursor: "pointer",
                        color: isSelected ? "#f0956a" : "rgba(255,255,255,0.7)",
                        background: isSelected ? "rgba(232,96,44,0.1)" : "transparent",
                        transition: "background 0.1s",
                        display: "flex", alignItems: "center", gap: 6,
                      }}
                        onMouseEnter={ev => { if (!isSelected) ev.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                        onMouseLeave={ev => { if (!isSelected) ev.currentTarget.style.background = "transparent"; }}
                      >
                        <span style={{ fontSize: 8, color: isSelected ? "#E8602C" : "rgba(255,255,255,0.2)", flexShrink: 0 }}>{isSelected ? "●" : "◦"}</span>
                        <span style={{ flex: 1 }}>{task.name || "—"}</span>
                        {(task.comments?.length > 0) && <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)" }}>💬{task.comments.length}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Entry Content View ──────────────────────────────────────
function EntryView({ entry, related, onEdit, onPin, onDelete, onUpdate }) {
  const meta = TYPE[entry.type] || TYPE.note;
  const isLang = entry.type.startsWith("lang_");
  const hasDate = entry.type === "event" || entry.type === "reminder";

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 24px", animation: "fadeUp 0.25s ease both" }}>
      {/* Type + Actions */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          background: meta.bg, border: `1px solid ${meta.border}`,
          borderRadius: "var(--r-full)", padding: "4px 14px",
        }}>
          <span style={{ fontSize: isLang ? 15 : 12, color: meta.color }}>{meta.icon}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, textTransform: "uppercase", letterSpacing: "0.1em" }}>{meta.label}</span>
          {hasDate && entry.date && (
            <span style={{ fontSize: 11, color: meta.color, opacity: 0.8 }}>· {relativeDate(entry.date)}{entry.time ? ` ${entry.time}` : ""}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <ActionBtn label="✎ Editar"   onClick={onEdit} />
          <ActionBtn label={entry.pinned ? "★ Fixado" : "☆ Fixar"} active={entry.pinned} onClick={onPin} />
          <ActionBtn label="Excluir"    onClick={onDelete} danger />
        </div>
      </div>

      {/* Title */}
      <h1 style={{
        fontFamily: "var(--font-serif)", fontSize: 28, fontWeight: 600,
        color: "rgba(255,255,255,0.92)", lineHeight: 1.25, marginBottom: 20, letterSpacing: "-0.01em",
      }}>{entry.title}</h1>

      {/* Content */}
      <p style={{
        fontSize: 15, lineHeight: 1.85, color: "rgba(255,255,255,0.7)",
        whiteSpace: "pre-wrap", marginBottom: 28,
      }}>{entry.content}</p>

      {/* Tags */}
      {entry.tags?.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 32 }}>
          {entry.tags.map(t => <Tag key={t} label={`#${t}`} />)}
        </div>
      )}

      {/* Date footer */}
      <div style={{
        fontSize: 12, color: "rgba(255,255,255,0.3)",
        borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16, marginBottom: 8,
      }}>{formatDate(entry.date)}</div>

      {/* Related */}
      {related && related.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 12, marginTop: 24 }}>
            Relacionadas por tags
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {related.map(r => {
              const rm = TYPE[r.type] || TYPE.note;
              return (
                <div key={r.id} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "12px 16px", borderRadius: "var(--r-lg)",
                  border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.04)",
                }}>
                  <span style={{ fontSize: 12, color: rm.color }}>{rm.icon}</span>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", flex: 1 }}>{r.title}</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{formatDate(r.date)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Thread */}
      <ThreadSection entry={entry} onUpdate={onUpdate} />
    </div>
  );
}

// ─── Edit Form ───────────────────────────────────────────────
function EditForm({ entry, onSave, onCancel }) {
  const [form, setForm] = useState({
    type: entry.type, title: entry.title, content: entry.content,
    tags: entry.tags.join(", "), date: entry.date || "", time: entry.time || "",
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!form.title.trim() || !form.content.trim()) return;
    setSaving(true);
    try {
      const { entry: updated } = await api.updateEntry(entry.id, {
        type: form.type, title: form.title.trim(), content: form.content.trim(),
        tags: form.tags.split(",").map(t => t.trim()).filter(Boolean),
        date: form.date || null, time: form.time || null,
      });
      onSave(updated);
    } finally { setSaving(false); }
  }

  const field = {
    width: "100%", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "var(--r-md)",
    padding: "10px 14px", fontSize: 14, color: "rgba(255,255,255,0.88)", outline: "none",
    background: "rgba(255,255,255,0.06)", boxSizing: "border-box", fontFamily: "inherit",
    transition: "border-color 0.15s",
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 24px", animation: "fadeUp 0.2s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#E8602C", letterSpacing: "0.08em", textTransform: "uppercase" }}>Editando</span>
        <div style={{ display: "flex", gap: 8 }}>
          <ActionBtn label="Cancelar" onClick={onCancel} />
          <button onClick={save} disabled={saving} style={{
            background: "#E8602C", border: "none", borderRadius: "var(--r-full)",
            padding: "7px 20px", fontSize: 12, fontWeight: 600, color: "white",
            cursor: saving ? "default" : "pointer", opacity: saving ? 0.7 : 1,
          }}>{saving ? "Salvando…" : "Salvar"}</button>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <FieldLabel>Tipo</FieldLabel>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {Object.entries(TYPE).map(([key, m]) => (
            <button key={key} onClick={() => setForm(f => ({ ...f, type: key }))} style={{
              background: form.type === key ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
              border: `1.5px solid ${form.type === key ? m.color : "rgba(255,255,255,0.1)"}`,
              borderRadius: "var(--r-full)", padding: "5px 14px",
              fontSize: 12, fontWeight: 600, color: form.type === key ? m.color : "rgba(255,255,255,0.4)",
              cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
            }}><span>{m.icon}</span>{m.label}</button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Título</FieldLabel>
        <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          style={{ ...field, fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 600 }} />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>Conteúdo</FieldLabel>
        <textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
          rows={7} style={{ ...field, resize: "vertical", lineHeight: 1.7 }} />
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}><FieldLabel>Data</FieldLabel><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={field} /></div>
        <div style={{ flex: 1 }}><FieldLabel>Hora</FieldLabel><input type="time" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} style={field} /></div>
      </div>
      <div>
        <FieldLabel>Tags <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(separadas por vírgula)</span></FieldLabel>
        <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
          placeholder="Ex: Trabalho, TCC" style={field} />
      </div>
    </div>
  );
}

function FieldLabel({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>{children}</div>;
}

// ─── Cards View (Masonry) ────────────────────────────────────
function CardsView({ entries, onOpen }) {
  const [hovId, setHovId] = useState(null);

  if (entries.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "rgba(255,255,255,0.3)", fontSize: 14 }}>
        Nenhuma entrada para exibir
      </div>
    );
  }

  return (
    <div style={{ padding: "28px 24px", overflowY: "auto", height: "100%", boxSizing: "border-box" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 20 }}>
        {entries.length} {entries.length === 1 ? "entrada" : "entradas"}
      </div>
      {/* Masonry via CSS columns */}
      <div style={{ columns: "280px", columnGap: 14 }}>
        {entries.map(entry => {
          const meta = TYPE[entry.type] || TYPE.note;
          const isLang = entry.type.startsWith("lang_");
          const hov = hovId === entry.id;
          const threadCount = entry.threads?.length || 0;
          return (
            <div
              key={entry.id}
              onClick={() => onOpen(entry)}
              onMouseEnter={() => setHovId(entry.id)}
              onMouseLeave={() => setHovId(null)}
              style={{
                breakInside: "avoid",
                marginBottom: 14,
                background: hov ? "#2a2010" : "#232323",
                border: `1.5px solid ${hov ? "rgba(232,96,44,0.35)" : "rgba(255,255,255,0.08)"}`,
                borderRadius: 16,
                padding: "16px 18px",
                cursor: "pointer",
                transition: "all 0.15s",
                boxShadow: hov ? "0 4px 20px rgba(232,96,44,0.15)" : "0 1px 4px rgba(0,0,0,0.3)",
              }}
            >
              {/* Type badge */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  background: meta.bg, border: `1px solid ${meta.border}`,
                  borderRadius: "var(--r-full)", padding: "2px 10px",
                }}>
                  <span style={{ fontSize: isLang ? 12 : 10 }}>{meta.icon}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, textTransform: "uppercase", letterSpacing: "0.08em" }}>{meta.label}</span>
                </div>
                {entry.pinned && <span style={{ marginLeft: "auto", color: "#E8602C", fontSize: 11 }}>★</span>}
              </div>

              {/* Title */}
              <h3 style={{
                fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.9)",
                marginBottom: 8, lineHeight: 1.4,
                fontFamily: "var(--font-serif)",
              }}>{entry.title}</h3>

              {/* Content preview */}
              <p style={{
                fontSize: 12.5, color: "rgba(255,255,255,0.5)", lineHeight: 1.65,
                display: "-webkit-box", WebkitLineClamp: 4,
                WebkitBoxOrient: "vertical", overflow: "hidden",
                margin: 0,
              }}>{entry.content}</p>

              {/* Tags */}
              {entry.tags?.length > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 10 }}>
                  {entry.tags.map(t => (
                    <span key={t} style={{
                      fontSize: 10, padding: "2px 8px", borderRadius: "var(--r-full)",
                      background: meta.bg, color: meta.color, fontWeight: 600,
                    }}>#{t}</span>
                  ))}
                </div>
              )}

              {/* Footer */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
                <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.3)" }}>{relativeDate(entry.date)}</span>
                {threadCount > 0 && (
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", display: "flex", alignItems: "center", gap: 3 }}>
                    💬 {threadCount}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Input Bar ───────────────────────────────────────────────
function InputBar({ onCreated, bordered = false }) {
  const [text, setText]               = useState("");
  const [loading, setLoading]         = useState(false);
  const [focused, setFocused]         = useState(false);
  const [linkedTask, setLinkedTask]   = useState(null);
  const [showPicker, setShowPicker]   = useState(false);
  const [pickerPos, setPickerPos]     = useState({ top: 0, left: 0 });
  const [pickerProjs, setPickerProjs] = useState(null);
  const [pickerLoad, setPickerLoad]   = useState(false);
  const ref          = useRef();
  const pickerBtnRef = useRef();
  const pickerPanRef = useRef();

  const detected = text.trim() ? parseInput(text) : null;
  const meta = detected ? TYPE[detected.type] : null;

  useEffect(() => {
    if (!showPicker) return;
    function handler(e) {
      if (pickerBtnRef.current?.contains(e.target)) return;
      if (pickerPanRef.current?.contains(e.target)) return;
      setShowPicker(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPicker]);

  async function openPicker(e) {
    e.stopPropagation();
    if (showPicker) { setShowPicker(false); return; }
    const rect = pickerBtnRef.current.getBoundingClientRect();
    setPickerPos({ top: rect.top, left: rect.left });
    setShowPicker(true);
    if (!pickerProjs) {
      setPickerLoad(true);
      try { const { projects } = await api.getProjects(); setPickerProjs(projects); }
      catch { setPickerProjs([]); }
      finally { setPickerLoad(false); }
    }
  }

  function selectTask(proj, frente, task) {
    setLinkedTask({ taskId: task.id, taskName: task.name, frenteName: frente.name, projName: proj.name, currentComments: task.comments || [] });
    setShowPicker(false);
    ref.current?.focus();
  }

  async function submit() {
    if (!text.trim() || loading) return;
    setLoading(true);
    const { type, body } = parseInput(text);
    try {
      const { entry } = await api.createEntry({
        type, title: body.slice(0, 80) + (body.length > 80 ? "…" : ""),
        content: body, tags: [], date: new Date().toISOString().split("T")[0],
      });
      onCreated(entry);
      setText("");
      if (linkedTask) {
        const cmt = { id: crypto.randomUUID(), text: body, created_at: new Date().toISOString() };
        await api.updateTask(linkedTask.taskId, { comments: [...linkedTask.currentComments, cmt] });
        setLinkedTask(null);
      }
    } finally { setLoading(false); }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      const el = e.target, s = el.selectionStart, end = el.selectionEnd;
      const v = text.slice(0, s) + "\n" + text.slice(end);
      setText(v);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 1; });
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); submit();
    }
  }

  return (
    <div style={{ padding: "12px 24px 20px", background: bordered ? "#1e1e1e" : "transparent", flexShrink: 0, ...(bordered ? { borderTop: "1px solid rgba(255,255,255,0.08)" } : {}) }}>
      <div style={{ maxWidth: 720, margin: "0 auto", position: "relative" }}>
        {meta && (
          <div style={{
            position: "absolute", top: -32, left: "50%", transform: "translateX(-50%)",
            background: "rgba(255,255,255,0.08)", border: `1px solid ${meta.color}60`,
            borderRadius: "var(--r-full)", padding: "3px 14px",
            fontSize: 11, fontWeight: 700, color: meta.color,
            display: "flex", alignItems: "center", gap: 5,
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)", whiteSpace: "nowrap", pointerEvents: "none",
          }}>
            <span>{meta.icon}</span>{meta.label}
          </div>
        )}

        {/* Linked task chip */}
        {linkedTask && (
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>→ task</span>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              background: "rgba(232,96,44,0.12)", border: "1px solid rgba(232,96,44,0.3)",
              borderRadius: 20, padding: "3px 10px 3px 12px",
            }}>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{linkedTask.projName}</span>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>›</span>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{linkedTask.frenteName}</span>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>›</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#f0956a" }}>{linkedTask.taskName}</span>
              <button onClick={() => setLinkedTask(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.28)", fontSize: 13, padding: "0 0 0 3px", lineHeight: 1 }}>×</button>
            </div>
          </div>
        )}

        <div style={{
          display: "flex", alignItems: "flex-end", gap: 8,
          background: focused ? "#2a2a2a" : "#232323",
          border: `1.5px solid ${focused ? "#E8602C" : "rgba(255,255,255,0.1)"}`,
          borderRadius: 16, padding: "12px 14px",
          boxShadow: focused ? "0 0 0 4px rgba(232,96,44,0.12)" : "none",
          transition: "all 0.18s",
        }}>
          <textarea
            ref={ref}
            value={text}
            onChange={e => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="Nova nota, evento, lembrete… (Alt+Enter para quebrar linha)"
            style={{
              flex: 1, border: "none", outline: "none", resize: "none",
              background: "transparent", fontSize: 14, color: "rgba(255,255,255,0.9)",
              lineHeight: 1.6, maxHeight: 160, overflowY: "auto",
            }}
          />
          {/* Task picker button */}
          <button ref={pickerBtnRef} onClick={openPicker} title="Vincular a uma task" style={{
            width: 34, height: 34, borderRadius: 10, flexShrink: 0,
            background: linkedTask ? "rgba(232,96,44,0.2)" : "rgba(255,255,255,0.07)",
            border: `1px solid ${linkedTask ? "rgba(232,96,44,0.4)" : "rgba(255,255,255,0.1)"}`,
            color: linkedTask ? "#E8602C" : "rgba(255,255,255,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", transition: "all 0.15s",
          }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 1h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5.5L2 15V2a1 1 0 0 1 1-1z"/>
            </svg>
          </button>
          {/* Send button */}
          <button onClick={submit} disabled={!text.trim() || loading} style={{
            width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
            background: text.trim() ? "#E8602C" : "rgba(255,255,255,0.1)",
            border: "none", color: "white", fontSize: 15,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: text.trim() ? "pointer" : "default", transition: "all 0.15s",
            boxShadow: text.trim() ? "0 2px 8px rgba(232,96,44,0.4)" : "none",
          }}>
            {loading ? <span style={{ fontSize: 11 }}>…</span> : "↑"}
          </button>
        </div>
        <div style={{ textAlign: "center", marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.2)" }}>
          Enter para registrar · Alt+Enter para nova linha
        </div>
      </div>

      {/* Task picker portal */}
      {showPicker && ReactDOM.createPortal(
        <div ref={pickerPanRef} style={{
          position: "fixed", top: pickerPos.top, left: pickerPos.left,
          transform: "translateY(-100%) translateY(-8px)",
          zIndex: 10000, width: 310, maxHeight: 360, overflowY: "auto",
          background: "#1e1e1e", border: "1px solid rgba(255,255,255,0.13)",
          borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.8)",
        }}>
          <div style={{ padding: "11px 14px 9px", borderBottom: "1px solid rgba(255,255,255,0.07)", position: "sticky", top: 0, background: "#1e1e1e", zIndex: 1 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Vincular a task</span>
          </div>
          {pickerLoad ? (
            <div style={{ padding: "20px 14px", fontSize: 12, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>Carregando…</div>
          ) : !pickerProjs || pickerProjs.length === 0 ? (
            <div style={{ padding: "16px 14px", fontSize: 12, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>Nenhum projeto encontrado.</div>
          ) : pickerProjs.map(proj => (
            <div key={proj.id}>
              <div style={{ padding: "9px 14px 4px", fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.55)", background: "rgba(255,255,255,0.02)" }}>
                {proj.name}
              </div>
              {proj.frentes?.map(frente => (
                <div key={frente.id}>
                  <div style={{ padding: "4px 14px 2px 22px", fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.3)" }}>
                    ▸ {frente.name}
                  </div>
                  {frente.tasks?.filter(t => t.status !== "Concluído").map(task => {
                    const isSel = linkedTask?.taskId === task.id;
                    return (
                      <div key={task.id} onClick={() => selectTask(proj, frente, task)} style={{
                        padding: "7px 14px 7px 32px", fontSize: 12, cursor: "pointer",
                        color: isSel ? "#f0956a" : "rgba(255,255,255,0.7)",
                        background: isSel ? "rgba(232,96,44,0.1)" : "transparent",
                        display: "flex", alignItems: "center", gap: 6, transition: "background 0.1s",
                      }}
                        onMouseEnter={ev => { if (!isSel) ev.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                        onMouseLeave={ev => { if (!isSel) ev.currentTarget.style.background = "transparent"; }}
                      >
                        <span style={{ fontSize: 8, color: isSel ? "#E8602C" : "rgba(255,255,255,0.2)", flexShrink: 0 }}>{isSel ? "●" : "◦"}</span>
                        <span style={{ flex: 1 }}>{task.name || "—"}</span>
                        {task.comments?.length > 0 && <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)" }}>💬 {task.comments.length}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Projects View ───────────────────────────────────────────
const PROJ_STATUS_LIST = ["Em andamento", "Pendente", "Marcado", "Em definição", "Não iniciado", "Concluído"];
const PROJ_STATUS_COLOR = {
  "Em andamento": "#E8602C",
  "Pendente":     "#d97706",
  "Marcado":      "#7c3aed",
  "Em definição": "rgba(255,255,255,0.4)",
  "Não iniciado": "rgba(255,255,255,0.22)",
  "Concluído":    "#10b981",
};

function StatusBadge({ value, onChange, small }) {
  const [open, setOpen]   = useState(false);
  const [pos, setPos]     = useState({ top: 0, left: 0 });
  const triggerRef        = useRef();
  const dropRef           = useRef();
  const color = PROJ_STATUS_COLOR[value] || "rgba(255,255,255,0.3)";
  const isGray = color.startsWith("rgba(255,255,255");

  function handleToggle(e) {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (triggerRef.current?.contains(e.target)) return;
      if (dropRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={triggerRef} style={{ display: "inline-block" }}>
      <span onClick={handleToggle} style={{
        display: "inline-block", fontSize: small ? 10 : 11, fontWeight: 700,
        padding: small ? "2px 7px" : "3px 10px", borderRadius: "var(--r-full)",
        background: isGray ? "rgba(255,255,255,0.06)" : `${color}18`,
        color, border: `1px solid ${isGray ? "rgba(255,255,255,0.1)" : `${color}40`}`,
        cursor: "pointer", whiteSpace: "nowrap", letterSpacing: "0.01em",
      }}>{value || "—"}</span>

      {open && ReactDOM.createPortal(
        <div ref={dropRef} style={{
          position: "fixed", top: pos.top, left: pos.left, zIndex: 9999,
          background: "#242424", border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 12, padding: "6px 0", minWidth: 160,
          boxShadow: "0 12px 40px rgba(0,0,0,0.7)",
        }}>
          {PROJ_STATUS_LIST.map(s => {
            const sc = PROJ_STATUS_COLOR[s];
            const sg = sc.startsWith("rgba(255,255,255");
            return (
              <div key={s} onClick={e => { e.stopPropagation(); onChange(s); setOpen(false); }} style={{
                padding: "8px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 8, transition: "background 0.1s",
              }}
                onMouseEnter={ev => ev.currentTarget.style.background = "rgba(255,255,255,0.06)"}
                onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: sg ? "rgba(255,255,255,0.2)" : sc }} />
                <span style={{ color: sc }}>{s}</span>
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

function EditableCell({ value, onSave, placeholder = "—", bold, large }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || "");
  const inputRef = useRef();

  useEffect(() => { setVal(value || ""); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = val.trim();
    if (trimmed !== (value || "").trim()) onSave(trimmed);
  }

  if (editing) return (
    <input ref={inputRef} value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setVal(value || ""); setEditing(false); } }}
      style={{
        background: "rgba(255,255,255,0.08)", border: "1px solid #E8602C",
        borderRadius: 6, padding: "3px 8px", fontSize: large ? 13 : 12, fontWeight: bold ? 700 : 400,
        color: "rgba(255,255,255,0.9)", outline: "none", width: "100%", boxSizing: "border-box",
      }}
    />
  );

  return (
    <span onClick={() => { setVal(value || ""); setEditing(true); }} style={{
      display: "block", fontSize: large ? 13 : 12, fontWeight: bold ? 700 : 400, cursor: "text",
      color: value ? (bold ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.7)") : "rgba(255,255,255,0.2)",
      padding: "2px 4px", borderRadius: 4, transition: "background 0.1s",
    }}
      onMouseEnter={ev => ev.currentTarget.style.background = "rgba(255,255,255,0.05)"}
      onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}
    >{value || placeholder}</span>
  );
}

function HolderToggle({ value, onChange }) {
  const isNos = value === "Nós";
  return (
    <span onClick={() => onChange(isNos ? "Eles" : "Nós")} style={{
      fontSize: 11, fontWeight: 700, cursor: "pointer",
      color: isNos ? "#f0956a" : "rgba(255,255,255,0.4)",
      padding: "2px 4px", borderRadius: 4, transition: "all 0.1s",
    }}
      onMouseEnter={ev => ev.currentTarget.style.background = "rgba(255,255,255,0.07)"}
      onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}
    >{value || "—"}</span>
  );
}

function TaskCommentBubble({ comments = [], onSave }) {
  const [open, setOpen]   = useState(false);
  const [pos, setPos]     = useState({ top: 0, left: 0 });
  const [text, setText]   = useState("");
  const triggerRef        = useRef();
  const panelRef          = useRef();
  const textRef           = useRef();
  const count             = comments.length;

  function handleToggle(e) {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const rect = triggerRef.current.getBoundingClientRect();
    const panelW = 288;
    const left = Math.min(rect.left, window.innerWidth - panelW - 12);
    setPos({ top: rect.bottom + 6, left: Math.max(8, left) });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    setTimeout(() => textRef.current?.focus(), 60);
    function handler(e) {
      if (triggerRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function addComment() {
    if (!text.trim()) return;
    const next = [...comments, { id: crypto.randomUUID(), text: text.trim(), created_at: new Date().toISOString() }];
    onSave(next);
    setText("");
  }

  function deleteComment(id) {
    onSave(comments.filter(c => c.id !== id));
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  }

  return (
    <div ref={triggerRef} style={{ display: "inline-flex" }}>
      <button onClick={handleToggle} title="Comentários" style={{
        background: "none", border: "none", cursor: "pointer",
        display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 5px",
        color: count > 0 ? "#E8602C" : "rgba(255,255,255,0.18)", transition: "color 0.15s",
        borderRadius: 5, flexShrink: 0,
      }}
        onMouseEnter={ev => ev.currentTarget.style.color = count > 0 ? "#f0956a" : "rgba(255,255,255,0.45)"}
        onMouseLeave={ev => ev.currentTarget.style.color = count > 0 ? "#E8602C" : "rgba(255,255,255,0.18)"}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 1h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5.5L2 15V2a1 1 0 0 1 1-1z"/>
        </svg>
        {count > 0 && <span style={{ fontSize: 9, fontWeight: 800, lineHeight: 1 }}>{count}</span>}
      </button>

      {open && ReactDOM.createPortal(
        <div ref={panelRef} style={{
          position: "fixed", top: pos.top, left: pos.left, zIndex: 9999,
          width: 288, background: "#1e1e1e",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.75)",
          overflow: "hidden", display: "flex", flexDirection: "column",
        }}>
          {/* Header */}
          <div style={{ padding: "11px 14px 9px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.4)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              Comentários {count > 0 && <span style={{ color: "#E8602C" }}>{count}</span>}
            </span>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.25)", fontSize: 14, padding: "0 2px", lineHeight: 1 }}>×</button>
          </div>

          {/* Comment list */}
          <div style={{ maxHeight: 240, overflowY: "auto", padding: count === 0 ? "14px 14px" : "6px 0" }}>
            {count === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.22)", fontStyle: "italic" }}>Nenhum comentário ainda.</p>
            ) : comments.map(c => (
              <div key={c.id} style={{
                padding: "9px 14px",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
                position: "relative",
              }}
                onMouseEnter={ev => ev.currentTarget.querySelector(".del-cmt").style.opacity = "1"}
                onMouseLeave={ev => ev.currentTarget.querySelector(".del-cmt").style.opacity = "0"}
              >
                <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.82)", lineHeight: 1.45 }}>{c.text}</p>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.22)", marginTop: 4, display: "block" }}>{fmtDate(c.created_at)}</span>
                <button className="del-cmt" onClick={() => deleteComment(c.id)} style={{
                  position: "absolute", top: 8, right: 10, background: "none", border: "none",
                  cursor: "pointer", color: "rgba(255,100,100,0.5)", fontSize: 10, opacity: 0,
                  transition: "opacity 0.12s", padding: "2px 4px",
                }}>✕</button>
              </div>
            ))}
          </div>

          {/* Input */}
          <div style={{ padding: "10px 10px 10px", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 7, alignItems: "flex-end" }}>
            <textarea
              ref={textRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addComment(); } }}
              placeholder="Adicionar comentário… (Enter)"
              rows={2}
              style={{
                flex: 1, background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.09)",
                borderRadius: 8, padding: "7px 10px", fontSize: 12,
                color: "rgba(255,255,255,0.85)", outline: "none",
                resize: "none", fontFamily: "inherit", lineHeight: 1.4,
                transition: "border-color 0.15s",
              }}
              onFocus={ev => ev.target.style.borderColor = "rgba(232,96,44,0.5)"}
              onBlur={ev => ev.target.style.borderColor = "rgba(255,255,255,0.09)"}
            />
            <button onClick={addComment} style={{
              background: "#E8602C", border: "none", borderRadius: 8,
              width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center",
              color: "white", fontSize: 16, cursor: "pointer", flexShrink: 0,
              boxShadow: "0 2px 8px rgba(232,96,44,0.35)",
            }}>↑</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function ProjectsView() {
  const [projects, setProjects]   = useState([]);
  const [collapsed, setCollapsed] = useState({});
  const [loading, setLoading]     = useState(true);
  const [adding, setAdding]       = useState(null); // { type, parentId }
  const [addVal, setAddVal]       = useState("");
  const [showLog, setShowLog]     = useState(false); // false = só pendentes, true = tudo
  const addRef = useRef();

  useEffect(() => { load(); }, []);
  useEffect(() => { if (adding) setTimeout(() => addRef.current?.focus(), 40); }, [adding]);

  async function load() {
    setLoading(true);
    try { const { projects: p } = await api.getProjects(); setProjects(p); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  }

  function toggle(id) { setCollapsed(prev => ({ ...prev, [id]: !prev[id] })); }

  // ── Optimistic updaters ──
  function updProj(id, patch) { setProjects(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p)); }
  function updFrente(pid, fid, patch) { setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: p.frentes.map(f => f.id === fid ? { ...f, ...patch } : f) } : p)); }
  function updTask(pid, fid, tid, patch) {
    setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: p.frentes.map(f => f.id === fid ? { ...f, tasks: f.tasks.map(t => t.id === tid ? { ...t, ...patch } : t) } : f) } : p));
  }

  async function saveProject(id, patch)         { updProj(id, patch);            await api.updateProject(id, patch); }
  async function saveFrente(pid, fid, patch)    { updFrente(pid, fid, patch);    await api.updateFrente(fid, patch); }
  async function saveTask(pid, fid, tid, patch) { updTask(pid, fid, tid, patch); await api.updateTask(tid, patch); }

  async function delProject(id) {
    if (!window.confirm("Excluir projeto e tudo dentro dele?")) return;
    setProjects(prev => prev.filter(p => p.id !== id));
    await api.deleteProject(id);
  }
  async function delFrente(pid, fid) {
    setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: p.frentes.filter(f => f.id !== fid) } : p));
    await api.deleteFrente(fid);
  }
  async function delTask(pid, fid, tid) {
    setProjects(prev => prev.map(p => p.id === pid ? { ...p, frentes: p.frentes.map(f => f.id === fid ? { ...f, tasks: f.tasks.filter(t => t.id !== tid) } : f) } : p));
    await api.deleteTask(tid);
  }

  async function commitAdd() {
    const name = addVal.trim();
    if (!name) { setAdding(null); setAddVal(""); return; }
    try {
      if (adding.type === "project") {
        const { project } = await api.createProject({ name });
        setProjects(prev => [...prev, project]);
      } else if (adding.type === "frente") {
        const { frente } = await api.createFrente(adding.parentId, { name });
        setProjects(prev => prev.map(p => p.id === adding.parentId ? { ...p, frentes: [...p.frentes, frente] } : p));
        setCollapsed(prev => ({ ...prev, [adding.parentId]: false }));
      } else if (adding.type === "task") {
        const { task } = await api.createTask(adding.parentId, { name });
        setProjects(prev => prev.map(p => ({ ...p, frentes: p.frentes.map(f => f.id === adding.parentId ? { ...f, tasks: [...f.tasks, task] } : f) })));
      }
    } catch (e) { console.error(e); }
    setAdding(null); setAddVal("");
  }

  const thStyle = { fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.28)", textTransform: "uppercase", letterSpacing: "0.1em", padding: "10px 12px", textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.08)", userSelect: "none" };
  const tdBorder = { borderTop: "1px solid rgba(255,255,255,0.05)" };

  if (loading) return <div style={{ textAlign: "center", padding: "80px 40px", color: "rgba(255,255,255,0.3)", fontSize: 14 }}>Carregando projetos…</div>;

  return (
    <div style={{ padding: "28px 28px 60px", overflowX: "auto" }}>
      {/* Page header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 600, color: "rgba(255,255,255,0.92)", margin: 0, letterSpacing: "-0.02em" }}>
            Acompanhamento de Projetos
          </h2>
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.28)", marginTop: 4 }}>
            Status, prazo e responsável por frente de trabalho
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setShowLog(v => !v)} style={{
            background: showLog ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.06)",
            border: `1px solid ${showLog ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.1)"}`,
            borderRadius: "var(--r-full)", padding: "8px 18px",
            fontSize: 12, fontWeight: 700,
            color: showLog ? "#10b981" : "rgba(255,255,255,0.4)",
            cursor: "pointer", transition: "all 0.15s", display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ fontSize: 11 }}>{showLog ? "●" : "○"}</span> Log
          </button>
          <button onClick={() => { setAdding({ type: "project" }); setAddVal(""); }} style={{
            background: "#E8602C", border: "none", borderRadius: "var(--r-full)",
            padding: "8px 18px", fontSize: 12, fontWeight: 700, color: "white", cursor: "pointer",
            boxShadow: "0 2px 12px rgba(232,96,44,0.35)", flexShrink: 0,
          }}>+ Novo projeto</button>
        </div>
      </div>

      {/* Table */}
      <div style={{ background: "#232323", borderRadius: 14, border: "1px solid rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "36%" }} /><col style={{ width: "21%" }} />
            <col style={{ width: "15%" }} /><col style={{ width: "12%" }} />
            <col style={{ width: "10%" }} /><col style={{ width: "6%" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={thStyle}>Projeto / Frente / Tarefa</th>
              <th style={thStyle}>Ação</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Stakeholder</th>
              <th style={thStyle}>Deadline</th>
              <th style={thStyle}>Holder</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((proj, pi) => {
              const isCollapsed = collapsed[proj.id];
              return (
                <>
                  {/* ── Project row ── */}
                  <tr key={proj.id} style={{ background: pi % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent" }}>
                    <td style={{ padding: "11px 12px", ...(pi > 0 ? { borderTop: "1px solid rgba(255,255,255,0.08)" } : {}) }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}
                        onMouseEnter={ev => ev.currentTarget.querySelector(".del-proj").style.opacity = "1"}
                        onMouseLeave={ev => ev.currentTarget.querySelector(".del-proj").style.opacity = "0"}
                      >
                        <button onClick={() => toggle(proj.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "rgba(255,255,255,0.3)", fontSize: 10, flexShrink: 0, width: 14 }}>
                          {isCollapsed ? "▶" : "▼"}
                        </button>
                        <div style={{ flex: 1 }}>
                          <EditableCell value={proj.name} bold large onSave={v => saveProject(proj.id, { name: v })} placeholder="Projeto" />
                        </div>
                        <button className="del-proj" onClick={() => delProject(proj.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,100,100,0.5)", fontSize: 11, opacity: 0, transition: "opacity 0.15s", padding: "2px 4px", flexShrink: 0 }}>✕</button>
                      </div>
                    </td>
                    <td style={{ padding: "11px 12px", ...(pi > 0 ? { borderTop: "1px solid rgba(255,255,255,0.08)" } : {}) }} />
                    <td style={{ padding: "11px 12px", ...(pi > 0 ? { borderTop: "1px solid rgba(255,255,255,0.08)" } : {}) }}>
                      <StatusBadge value={proj.status} onChange={v => saveProject(proj.id, { status: v })} />
                    </td>
                    <td style={{ padding: "11px 12px", ...(pi > 0 ? { borderTop: "1px solid rgba(255,255,255,0.08)" } : {}) }} />
                    <td style={{ padding: "11px 12px", ...(pi > 0 ? { borderTop: "1px solid rgba(255,255,255,0.08)" } : {}) }} />
                    <td style={{ padding: "11px 12px", ...(pi > 0 ? { borderTop: "1px solid rgba(255,255,255,0.08)" } : {}) }}>
                      <HolderToggle value={proj.holder} onChange={v => saveProject(proj.id, { holder: v })} />
                    </td>
                  </tr>

                  {/* ── Frentes + Tasks ── */}
                  {!isCollapsed && proj.frentes.map(frente => (
                    <>
                      {/* Frente header */}
                      <tr key={frente.id} style={{ background: "rgba(0,0,0,0.12)" }}>
                        <td colSpan={6} style={{ padding: "7px 12px 7px 32px", ...tdBorder }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}
                            onMouseEnter={ev => ev.currentTarget.querySelector(".del-fr").style.opacity = "1"}
                            onMouseLeave={ev => ev.currentTarget.querySelector(".del-fr").style.opacity = "0"}
                          >
                            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", flexShrink: 0 }}>▸</span>
                            <div style={{ flex: 1 }}>
                              <EditableCell value={frente.name} bold onSave={v => saveFrente(proj.id, frente.id, { name: v })} placeholder="Frente" />
                            </div>
                            <button onClick={() => { setAdding({ type: "task", parentId: frente.id }); setAddVal(""); }} style={{
                              background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                              borderRadius: "var(--r-full)", padding: "2px 9px", fontSize: 10, fontWeight: 700,
                              color: "rgba(255,255,255,0.3)", cursor: "pointer", flexShrink: 0,
                            }}>+ task</button>
                            <button className="del-fr" onClick={() => delFrente(proj.id, frente.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,100,100,0.5)", fontSize: 10, opacity: 0, transition: "opacity 0.15s", padding: "2px 4px", flexShrink: 0 }}>✕</button>
                          </div>
                        </td>
                      </tr>

                      {/* Task rows */}
                      {(showLog ? frente.tasks : frente.tasks.filter(t => t.status !== "Concluído")).map(task => {
                        const isDone = task.status === "Concluído";
                        return (
                        <tr key={task.id} style={{ background: isDone ? "rgba(0,0,0,0.1)" : "rgba(0,0,0,0.2)", opacity: isDone ? 0.55 : 1 }}
                          onMouseEnter={ev => { ev.currentTarget.style.background = "rgba(255,255,255,0.015)"; ev.currentTarget.querySelector(".del-task").style.opacity = "1"; }}
                          onMouseLeave={ev => { ev.currentTarget.style.background = isDone ? "rgba(0,0,0,0.1)" : "rgba(0,0,0,0.2)"; ev.currentTarget.querySelector(".del-task").style.opacity = "0"; }}
                        >
                          <td style={{ padding: "6px 12px 6px 48px", ...tdBorder }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 8, color: isDone ? "#10b981" : "rgba(255,255,255,0.15)", flexShrink: 0 }}>{isDone ? "✓" : "◦"}</span>
                              <div style={{ flex: 1, textDecoration: isDone ? "line-through" : "none" }}>
                                <EditableCell value={task.name} onSave={v => saveTask(proj.id, frente.id, task.id, { name: v })} placeholder="Tarefa" />
                              </div>
                              <TaskCommentBubble
                                comments={task.comments || []}
                                onSave={comments => saveTask(proj.id, frente.id, task.id, { comments })}
                              />
                              <button className="del-task" onClick={() => delTask(proj.id, frente.id, task.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,100,100,0.5)", fontSize: 10, opacity: 0, transition: "opacity 0.15s", padding: "2px 4px", flexShrink: 0 }}>✕</button>
                            </div>
                          </td>
                          <td style={{ padding: "6px 12px", ...tdBorder }}>
                            <EditableCell value={task.acao} onSave={v => saveTask(proj.id, frente.id, task.id, { acao: v })} placeholder="—" />
                          </td>
                          <td style={{ padding: "6px 12px", ...tdBorder }}>
                            <StatusBadge value={task.status} small onChange={v => saveTask(proj.id, frente.id, task.id, { status: v })} />
                          </td>
                          <td style={{ padding: "6px 12px", ...tdBorder }}>
                            <EditableCell value={task.stakeholder} onSave={v => saveTask(proj.id, frente.id, task.id, { stakeholder: v })} placeholder="—" />
                          </td>
                          <td style={{ padding: "6px 12px", ...tdBorder }}>
                            <EditableCell value={task.deadline} onSave={v => saveTask(proj.id, frente.id, task.id, { deadline: v })} placeholder="—" />
                          </td>
                          <td style={{ padding: "6px 12px", ...tdBorder }}>
                            <HolderToggle value={task.holder} onChange={v => saveTask(proj.id, frente.id, task.id, { holder: v })} />
                          </td>
                        </tr>
                        );
                      })}

                      {/* Inline: add task */}
                      {adding?.type === "task" && adding?.parentId === frente.id && (
                        <tr key="add-task">
                          <td colSpan={6} style={{ padding: "6px 12px 6px 48px", ...tdBorder }}>
                            <input ref={addRef} value={addVal} onChange={e => setAddVal(e.target.value)}
                              placeholder="Nome da tarefa… (Enter para salvar)"
                              onKeyDown={e => { if (e.key === "Enter") commitAdd(); if (e.key === "Escape") { setAdding(null); setAddVal(""); } }}
                              onBlur={commitAdd}
                              style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(232,96,44,0.5)", borderRadius: 8, padding: "6px 12px", fontSize: 12, color: "rgba(255,255,255,0.9)", outline: "none", width: "55%" }}
                            />
                          </td>
                        </tr>
                      )}
                    </>
                  ))}

                  {/* Inline: add frente */}
                  {!isCollapsed && (
                    adding?.type === "frente" && adding?.parentId === proj.id ? (
                      <tr key="add-frente">
                        <td colSpan={6} style={{ padding: "6px 12px 8px 32px", ...tdBorder }}>
                          <input ref={addRef} value={addVal} onChange={e => setAddVal(e.target.value)}
                            placeholder="Nome da frente… (Enter para salvar)"
                            onKeyDown={e => { if (e.key === "Enter") commitAdd(); if (e.key === "Escape") { setAdding(null); setAddVal(""); } }}
                            onBlur={commitAdd}
                            style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(232,96,44,0.5)", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.9)", outline: "none", width: "45%" }}
                          />
                        </td>
                      </tr>
                    ) : (
                      <tr key="add-frente-btn">
                        <td colSpan={6} style={{ padding: "4px 12px 8px 32px", borderTop: "1px solid rgba(255,255,255,0.03)" }}>
                          <button onClick={() => { setAdding({ type: "frente", parentId: proj.id }); setAddVal(""); }} style={{
                            background: "none", border: "none", cursor: "pointer",
                            fontSize: 11, color: "rgba(255,255,255,0.2)", padding: "2px 0", transition: "color 0.15s",
                          }}
                            onMouseEnter={ev => ev.currentTarget.style.color = "rgba(255,255,255,0.5)"}
                            onMouseLeave={ev => ev.currentTarget.style.color = "rgba(255,255,255,0.2)"}
                          >+ frente</button>
                        </td>
                      </tr>
                    )
                  )}
                </>
              );
            })}

            {/* Inline: add project */}
            {adding?.type === "project" && (
              <tr>
                <td colSpan={6} style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <input ref={adding.type === "project" ? addRef : undefined} value={addVal} onChange={e => setAddVal(e.target.value)}
                    placeholder="Nome do projeto… (Enter para salvar)"
                    onKeyDown={e => { if (e.key === "Enter") commitAdd(); if (e.key === "Escape") { setAdding(null); setAddVal(""); } }}
                    onBlur={commitAdd}
                    style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(232,96,44,0.5)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.9)", outline: "none", width: "40%" }}
                  />
                </td>
              </tr>
            )}

            {projects.length === 0 && !adding && (
              <tr>
                <td colSpan={6} style={{ padding: "60px 40px", textAlign: "center", color: "rgba(255,255,255,0.2)", fontSize: 14 }}>
                  Nenhum projeto ainda. Clique em "+ Novo projeto" para começar.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Agenda View ─────────────────────────────────────────────
const DAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTH_LABELS = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff); d.setHours(0, 0, 0, 0);
  return d;
}
function shiftDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function toISO(date) { return date.toISOString().split("T")[0]; }
function isToday(dateStr) { return dateStr === toISO(new Date()); }
function fmtTime(t) { return t || ""; }

function AgendaView() {
  const [weekStart, setWeekStart]       = useState(() => getMonday(new Date()));
  const [meetings, setMeetings]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [expanded, setExpanded]         = useState(null);
  const [addingTo, setAddingTo]         = useState(null);
  const [form, setForm]                 = useState({ title: "", start_time: "", end_time: "" });
  const [commentDraft, setCommentDraft] = useState({});
  const [mustDraft, setMustDraft]       = useState({});
  const formRef    = useRef();
  const commentRef = useRef();

  const days = Array.from({ length: 7 }, (_, i) => shiftDays(weekStart, i));
  const weekEnd = days[6];

  useEffect(() => { loadWeek(); }, [weekStart]);
  useEffect(() => { if (addingTo) setTimeout(() => formRef.current?.focus(), 40); }, [addingTo]);

  async function loadWeek() {
    setLoading(true);
    try {
      const { meetings: m } = await api.getMeetings({ from: toISO(weekStart), to: toISO(weekEnd) });
      setMeetings(m);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }

  const byDate = {};
  days.forEach(d => { byDate[toISO(d)] = []; });
  meetings.forEach(m => { if (byDate[m.date]) byDate[m.date].push(m); });

  async function addMeeting(date) {
    if (!form.title.trim()) { setAddingTo(null); return; }
    try {
      const { meeting } = await api.createMeeting({ title: form.title.trim(), date, start_time: form.start_time, end_time: form.end_time });
      setMeetings(prev => [...prev, meeting]);
    } catch (e) { console.error(e); }
    setAddingTo(null); setForm({ title: "", start_time: "", end_time: "" });
  }

  async function deleteMeeting(id) {
    setMeetings(prev => prev.filter(m => m.id !== id));
    if (expanded === id) setExpanded(null);
    await api.deleteMeeting(id);
  }

  async function addComment(meeting) {
    const text = (commentDraft[meeting.id] || "").trim();
    if (!text) return;
    const newC = { id: Date.now().toString(), text, created_at: new Date().toISOString() };
    const updated = [...(meeting.comments || []), newC];
    setMeetings(prev => prev.map(m => m.id === meeting.id ? { ...m, comments: updated } : m));
    setCommentDraft(prev => ({ ...prev, [meeting.id]: "" }));
    await api.updateMeeting(meeting.id, { comments: updated });
  }

  async function deleteComment(meeting, cid) {
    const updated = meeting.comments.filter(c => c.id !== cid);
    setMeetings(prev => prev.map(m => m.id === meeting.id ? { ...m, comments: updated } : m));
    await api.updateMeeting(meeting.id, { comments: updated });
  }

  async function saveMust(meeting) {
    const val = (mustDraft[meeting.id] ?? meeting.must ?? "");
    if (val === (meeting.must || "")) return;
    setMeetings(prev => prev.map(m => m.id === meeting.id ? { ...m, must: val } : m));
    await api.updateMeeting(meeting.id, { must: val });
  }

  const startM = weekStart.getMonth(), endM = weekEnd.getMonth();
  const weekLabel = startM === endM
    ? `${weekStart.getDate()}–${weekEnd.getDate()} ${MONTH_LABELS[startM]} ${weekStart.getFullYear()}`
    : `${weekStart.getDate()} ${MONTH_LABELS[startM]} – ${weekEnd.getDate()} ${MONTH_LABELS[endM]} ${weekEnd.getFullYear()}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

      {/* ── Week navigation ── */}
      <div style={{ padding: "18px 24px 14px", flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 10 }}>
        {[["←", () => setWeekStart(d => shiftDays(d, -7))], ["→", () => setWeekStart(d => shiftDays(d, 7))]].map(([lbl, fn], i) => (
          i === 0 ? <button key={lbl} onClick={fn} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 14px", fontSize: 15, color: "rgba(255,255,255,0.55)", cursor: "pointer" }}
            onMouseEnter={ev => { ev.currentTarget.style.background = "rgba(255,255,255,0.1)"; ev.currentTarget.style.color = "white"; }}
            onMouseLeave={ev => { ev.currentTarget.style.background = "rgba(255,255,255,0.06)"; ev.currentTarget.style.color = "rgba(255,255,255,0.55)"; }}
          >{lbl}</button> : null
        ))}
        <div style={{ flex: 1, textAlign: "center" }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: "rgba(255,255,255,0.88)", fontFamily: "var(--font-serif)", letterSpacing: "-0.01em" }}>{weekLabel}</span>
        </div>
        <button onClick={() => setWeekStart(d => shiftDays(d, 7))} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 14px", fontSize: 15, color: "rgba(255,255,255,0.55)", cursor: "pointer" }}
          onMouseEnter={ev => { ev.currentTarget.style.background = "rgba(255,255,255,0.1)"; ev.currentTarget.style.color = "white"; }}
          onMouseLeave={ev => { ev.currentTarget.style.background = "rgba(255,255,255,0.06)"; ev.currentTarget.style.color = "rgba(255,255,255,0.55)"; }}
        >→</button>
        <button onClick={() => setWeekStart(getMonday(new Date()))} style={{ background: "rgba(232,96,44,0.15)", border: "1px solid rgba(232,96,44,0.3)", borderRadius: 8, padding: "6px 16px", fontSize: 12, fontWeight: 700, color: "#f0956a", cursor: "pointer" }}>Hoje</button>
      </div>

      {/* ── Day columns ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 28px" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "rgba(255,255,255,0.25)", fontSize: 14 }}>Carregando…</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, minWidth: 840 }}>
            {days.map(day => {
              const dateStr = toISO(day);
              const isNow   = isToday(dateStr);
              const dayMeetings = (byDate[dateStr] || []).slice().sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
              const musts   = dayMeetings.filter(m => m.must?.trim());
              const allComments = dayMeetings.flatMap(m => m.comments || []);

              return (
                <div key={dateStr} style={{
                  background: isNow ? "rgba(232,96,44,0.035)" : "#252525",
                  border: `1px solid ${isNow ? "rgba(232,96,44,0.4)" : "rgba(255,255,255,0.07)"}`,
                  borderRadius: 14, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 240,
                }}>

                  {/* ── Day header ── */}
                  <div style={{ padding: "12px 12px 10px", borderBottom: `1px solid ${isNow ? "rgba(232,96,44,0.18)" : "rgba(255,255,255,0.06)"}`, background: isNow ? "rgba(232,96,44,0.07)" : "rgba(255,255,255,0.015)" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: isNow ? "#f0956a" : "rgba(255,255,255,0.3)", marginBottom: 2 }}>{DAY_LABELS[day.getDay()]}</div>
                    <div style={{ fontSize: 26, fontWeight: 700, color: isNow ? "#f0956a" : "rgba(255,255,255,0.8)", lineHeight: 1, fontFamily: "var(--font-serif)" }}>{day.getDate()}</div>
                  </div>

                  {/* ── Must summary (amber, prominent) ── */}
                  {musts.length > 0 && (
                    <div style={{ padding: "10px 12px", background: "rgba(245,158,11,0.07)", borderBottom: "1px solid rgba(245,158,11,0.18)" }}>
                      <div style={{ fontSize: 9, fontWeight: 800, color: "#f59e0b", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 7, display: "flex", alignItems: "center", gap: 4 }}>
                        <span>⚑</span> Must do
                      </div>
                      {musts.map((m, i) => (
                        <div key={m.id} style={{ marginBottom: i < musts.length - 1 ? 6 : 0, paddingLeft: 8, borderLeft: "2px solid rgba(245,158,11,0.6)" }}>
                          <div style={{ fontSize: 9, color: "rgba(245,158,11,0.6)", fontWeight: 700, marginBottom: 1, textTransform: "uppercase", letterSpacing: "0.04em" }}>{m.title}</div>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.82)", lineHeight: 1.45 }}>{m.must}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── Comments summary (orange, secondary) ── */}
                  {allComments.length > 0 && (
                    <div style={{ padding: "8px 12px", background: "rgba(232,96,44,0.04)", borderBottom: "1px solid rgba(232,96,44,0.1)" }}>
                      <div style={{ fontSize: 9, fontWeight: 800, color: "rgba(232,96,44,0.7)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 8 }}>◆</span> Notas
                      </div>
                      {allComments.slice(0, 3).map((c, i) => (
                        <div key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.45, marginBottom: i < Math.min(allComments.length, 3) - 1 ? 4 : 0, paddingLeft: 8, borderLeft: "2px solid rgba(232,96,44,0.3)" }}>
                          {c.text}
                        </div>
                      ))}
                      {allComments.length > 3 && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 4 }}>+{allComments.length - 3} mais</div>}
                    </div>
                  )}

                  {/* ── Meetings list ── */}
                  <div style={{ flex: 1, padding: "8px 8px 4px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                    {dayMeetings.map(meeting => {
                      const isExp = expanded === meeting.id;
                      const mustVal = mustDraft[meeting.id] ?? meeting.must ?? "";

                      return (
                        <div key={meeting.id} style={{
                          background: isExp ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.04)",
                          border: isExp ? "1px solid rgba(255,255,255,0.14)" : "1px solid rgba(255,255,255,0.07)",
                          borderRadius: 10, overflow: "hidden", transition: "border-color 0.15s",
                        }}>
                          {/* Meeting header */}
                          <div onClick={() => setExpanded(isExp ? null : meeting.id)} style={{ padding: "9px 10px", cursor: "pointer" }}
                            onMouseEnter={ev => { if (!isExp) ev.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                            onMouseLeave={ev => { ev.currentTarget.style.background = "transparent"; }}
                          >
                            {(meeting.startTime || meeting.endTime) && (
                              <div style={{ fontSize: 9, fontWeight: 700, color: isNow ? "#f0956a" : "rgba(255,255,255,0.3)", letterSpacing: "0.06em", marginBottom: 3 }}>
                                {meeting.startTime}{meeting.endTime ? ` – ${meeting.endTime}` : ""}
                              </div>
                            )}
                            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 4 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.9)", lineHeight: 1.35, flex: 1 }}>{meeting.title}</span>
                              <button onClick={e => { e.stopPropagation(); deleteMeeting(meeting.id); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "rgba(255,100,100,0.4)", padding: "0 2px", flexShrink: 0, opacity: 0, transition: "opacity 0.15s" }}
                                onMouseEnter={ev => ev.currentTarget.style.opacity = "1"}
                                onMouseLeave={ev => ev.currentTarget.style.opacity = "0"}
                              >✕</button>
                            </div>
                            {/* Must preview when collapsed */}
                            {meeting.must && !isExp && (
                              <div style={{ marginTop: 5, display: "flex", gap: 5, alignItems: "flex-start" }}>
                                <span style={{ fontSize: 8, color: "#f59e0b", flexShrink: 0, marginTop: 1 }}>⚑</span>
                                <span style={{ fontSize: 10, color: "rgba(245,158,11,0.85)", lineHeight: 1.35 }}>{meeting.must.length > 55 ? meeting.must.slice(0, 55) + "…" : meeting.must}</span>
                              </div>
                            )}
                            {/* Comment count badge */}
                            {meeting.comments?.length > 0 && !isExp && (
                              <div style={{ marginTop: 5 }}>
                                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.07)", borderRadius: 4, padding: "2px 6px" }}>💬 {meeting.comments.length}</span>
                              </div>
                            )}
                          </div>

                          {/* ── Expanded panel ── */}
                          {isExp && (
                            <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>

                              {/* Comments section */}
                              <div style={{ padding: "12px 12px 10px" }}>
                                <div style={{ fontSize: 9, fontWeight: 800, color: "rgba(232,96,44,0.7)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10, display: "flex", alignItems: "center", gap: 4 }}>
                                  <span style={{ fontSize: 8 }}>◆</span> Comentários
                                </div>
                                {meeting.comments?.length > 0 && (
                                  <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 2 }}>
                                    {meeting.comments.map(c => (
                                      <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 10px", background: "rgba(255,255,255,0.04)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}
                                        onMouseEnter={ev => ev.currentTarget.querySelector(".del-c").style.opacity = "1"}
                                        onMouseLeave={ev => ev.currentTarget.querySelector(".del-c").style.opacity = "0"}
                                      >
                                        <span style={{ fontSize: 7, color: "#E8602C", marginTop: 4, flexShrink: 0 }}>●</span>
                                        <span style={{ flex: 1, fontSize: 12, color: "rgba(255,255,255,0.78)", lineHeight: 1.5 }}>{c.text}</span>
                                        <button className="del-c" onClick={() => deleteComment(meeting, c.id)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 9, color: "rgba(255,100,100,0.5)", padding: 0, opacity: 0, transition: "opacity 0.15s", flexShrink: 0 }}>✕</button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {/* Add comment input */}
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                  <input
                                    ref={commentRef}
                                    value={commentDraft[meeting.id] || ""}
                                    onChange={e => setCommentDraft(prev => ({ ...prev, [meeting.id]: e.target.value }))}
                                    placeholder="Adicionar nota…"
                                    onKeyDown={e => { if (e.key === "Enter") addComment(meeting); }}
                                    style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "7px 10px", fontSize: 12, color: "rgba(255,255,255,0.88)", outline: "none" }}
                                    onFocus={ev => ev.currentTarget.style.borderColor = "#E8602C"}
                                    onBlur={ev => ev.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"}
                                  />
                                  <button onClick={() => addComment(meeting)} style={{
                                    background: (commentDraft[meeting.id] || "").trim() ? "#E8602C" : "rgba(255,255,255,0.08)",
                                    border: "none", borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 700,
                                    color: (commentDraft[meeting.id] || "").trim() ? "white" : "rgba(255,255,255,0.25)",
                                    cursor: "pointer", transition: "all 0.15s", flexShrink: 0,
                                  }}>↑</button>
                                </div>
                              </div>

                              {/* ── Must section (amber) ── */}
                              <div style={{ padding: "12px 12px 12px", background: "rgba(245,158,11,0.06)", borderTop: "1px solid rgba(245,158,11,0.15)" }}>
                                <div style={{ fontSize: 9, fontWeight: 800, color: "#f59e0b", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
                                  <span>⚑</span> Must
                                </div>
                                <textarea
                                  value={mustVal}
                                  onChange={e => setMustDraft(prev => ({ ...prev, [meeting.id]: e.target.value }))}
                                  onBlur={() => saveMust(meeting)}
                                  placeholder="O que é essencial nessa reunião…"
                                  rows={3}
                                  style={{
                                    width: "100%", background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.2)",
                                    borderRadius: 9, padding: "9px 11px", fontSize: 12, color: "rgba(255,255,255,0.88)",
                                    outline: "none", resize: "none", lineHeight: 1.55, boxSizing: "border-box",
                                  }}
                                  onFocus={ev => ev.currentTarget.style.borderColor = "#f59e0b"}
                                  onBlur={ev => { ev.currentTarget.style.borderColor = "rgba(245,158,11,0.2)"; saveMust(meeting); }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Add meeting form */}
                    {addingTo === dateStr ? (
                      <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(232,96,44,0.35)", borderRadius: 10, padding: "10px 10px 8px" }}>
                        <input ref={formRef} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                          placeholder="Título da reunião…"
                          onKeyDown={e => { if (e.key === "Enter") addMeeting(dateStr); if (e.key === "Escape") setAddingTo(null); }}
                          style={{ width: "100%", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.92)", outline: "none", marginBottom: 7, boxSizing: "border-box" }}
                        />
                        <div style={{ display: "flex", gap: 5, marginBottom: 7 }}>
                          <input value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} type="time"
                            style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: "5px 7px", fontSize: 11, color: "rgba(255,255,255,0.7)", outline: "none", colorScheme: "dark" }}
                          />
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", alignSelf: "center" }}>–</span>
                          <input value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} type="time"
                            style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: "5px 7px", fontSize: 11, color: "rgba(255,255,255,0.7)", outline: "none", colorScheme: "dark" }}
                          />
                        </div>
                        <div style={{ display: "flex", gap: 5 }}>
                          <button onClick={() => addMeeting(dateStr)} style={{ flex: 1, background: "#E8602C", border: "none", borderRadius: 8, padding: "7px 0", fontSize: 11, fontWeight: 700, color: "white", cursor: "pointer" }}>Salvar</button>
                          <button onClick={() => setAddingTo(null)} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "7px 11px", fontSize: 11, color: "rgba(255,255,255,0.4)", cursor: "pointer" }}>✕</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => { setAddingTo(dateStr); setForm({ title: "", start_time: "", end_time: "" }); setExpanded(null); }}
                        style={{ width: "100%", background: "none", border: "1px dashed rgba(255,255,255,0.08)", borderRadius: 9, padding: "8px", fontSize: 11, color: "rgba(255,255,255,0.2)", cursor: "pointer", textAlign: "center", transition: "all 0.15s" }}
                        onMouseEnter={ev => { ev.currentTarget.style.borderColor = "rgba(232,96,44,0.35)"; ev.currentTarget.style.color = "#f0956a"; }}
                        onMouseLeave={ev => { ev.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; ev.currentTarget.style.color = "rgba(255,255,255,0.2)"; }}
                      >+ reunião</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Home Page (Claude-style) ────────────────────────────────
function HomePage({ onClose, onCreated, recentEntries, onOpenEntry }) {
  const [lastCreated, setLastCreated] = useState(null);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";

  function handleCreated(entry) {
    onCreated(entry);
    setLastCreated(TYPE[entry.type]?.label || "Entrada");
    setTimeout(() => setLastCreated(null), 2500);
  }

  const HINTS = [
    { p: "evento …",   c: "#5a5a6a", bg: "#f0f0f4" },
    { p: "lembrete …", c: "#7a5c3a", bg: "#faf3ea" },
    { p: "frances …",  c: "#0055A4", bg: "#e8eeff" },
    { p: "jp …",       c: "#BC002D", bg: "#ffecec" },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "#1a1a1a",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: "24px 24px 40px",
      overflowY: "auto",
    }}>
      {/* Close */}
      <button onClick={onClose} style={{
        position: "fixed", top: 20, right: 24,
        background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "50%",
        width: 36, height: 36, fontSize: 20, cursor: "pointer",
        color: "rgba(255,255,255,0.5)", display: "flex", alignItems: "center", justifyContent: "center",
        lineHeight: 1,
      }}>×</button>

      <div style={{ width: "100%", maxWidth: 640, display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>

        {/* Logo + Greeting */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 72, height: 72, borderRadius: 22, margin: "0 auto 20px",
            background: "linear-gradient(135deg, #E8602C 0%, #2a2a2a 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 12px 40px rgba(232,96,44,0.3)",
          }}><LogoIcon size={32} /></div>
          <h1 style={{
            fontFamily: "var(--font-serif)", fontSize: 34, fontWeight: 600,
            color: "rgba(255,255,255,0.92)", marginBottom: 8, letterSpacing: "-0.02em", lineHeight: 1.2,
          }}>{greeting}, Carlos.</h1>
          <p style={{ fontSize: 16, color: "rgba(255,255,255,0.4)", fontWeight: 400 }}>
            O que você quer capturar hoje?
          </p>
        </div>

        {/* Input Card */}
        <div style={{
          width: "100%", background: "#232323", borderRadius: 20,
          boxShadow: "0 4px 32px rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.08)",
          overflow: "hidden", marginBottom: 16,
        }}>
          <InputBar onCreated={handleCreated} />
          {lastCreated && (
            <div style={{ textAlign: "center", padding: "0 24px 16px", fontSize: 13, color: "#E8602C", fontWeight: 600 }}>
              ✓ {lastCreated} criada com sucesso
            </div>
          )}
        </div>

        {/* Prefix hints */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginBottom: 36 }}>
          {HINTS.map(({ p, c }) => (
            <span key={p} style={{
              fontSize: 11, fontWeight: 600, color: c,
              background: "rgba(255,255,255,0.06)",
              border: `1px solid rgba(255,255,255,0.1)`, padding: "4px 12px", borderRadius: "var(--r-full)",
            }}>{p}</span>
          ))}
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", alignSelf: "center" }}>— prefixos de tipo</span>
        </div>

        {/* Recent entries */}
        {recentEntries.length > 0 && (
          <div style={{ width: "100%" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 12, textAlign: "center" }}>
              Recentes
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {recentEntries.slice(0, 5).map(e => {
                const meta = TYPE[e.type] || TYPE.note;
                const isLang = e.type.startsWith("lang_");
                return (
                  <div
                    key={e.id}
                    onClick={() => { onOpenEntry(e); onClose(); }}
                    style={{
                      padding: "12px 16px", borderRadius: 14,
                      background: "#232323", border: "1px solid rgba(255,255,255,0.08)",
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                      transition: "all 0.12s",
                    }}
                    onMouseEnter={ev => { ev.currentTarget.style.background = "#2a2010"; ev.currentTarget.style.borderColor = "rgba(232,96,44,0.3)"; }}
                    onMouseLeave={ev => { ev.currentTarget.style.background = "#232323"; ev.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}
                  >
                    <span style={{ fontSize: isLang ? 16 : 13, color: meta.color, flexShrink: 0 }}>{meta.icon}</span>
                    <span style={{ flex: 1, fontSize: 14, color: "rgba(255,255,255,0.85)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</span>
                    {e.threads?.length > 0 && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>💬 {e.threads.length}</span>}
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", flexShrink: 0 }}>{relativeDate(e.date)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Workspace link */}
        <button onClick={onClose} style={{
          marginTop: 24, background: "transparent", border: "none",
          fontSize: 13, color: "rgba(255,255,255,0.35)", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 4,
          padding: "8px 16px", borderRadius: "var(--r-full)",
          transition: "color 0.15s",
        }}
          onMouseEnter={e => e.currentTarget.style.color = "#E8602C"}
          onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.35)"}
        >
          Abrir workspace →
        </button>
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────
export default function App() {
  const [showHome, setShowHome]           = useState(true);
  const [activeView, setActiveView]       = useState("entries"); // "entries" | "projects" | "agenda"
  const [entries, setEntries]             = useState([]);
  const [filter, setFilter]               = useState("all");
  const [showLangMenu, setShowLangMenu]   = useState(false);
  const [search, setSearch]               = useState("");
  const [activeEntry, setActiveEntry]     = useState(null);
  const [activeRelated, setActiveRelated] = useState([]);
  const [editing, setEditing]             = useState(false);
  const [showCards, setShowCards]         = useState(false);
  const [toast, setToast]                 = useState(null);
  const [loading, setLoading]             = useState(true);
  const [isMobile, setIsMobile]           = useState(window.innerWidth < 768);
  const searchRef = useRef();

  const showToast = msg => { setToast(null); setTimeout(() => setToast(msg), 10); };

  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  const loadAll = useCallback(async (params = {}) => {
    try {
      const { entries: e } = await api.getEntries(params);
      setEntries(e);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => loadAll({ type: filter, search }), 250);
  }, [filter, search]);

  async function openEntry(entry) {
    setActiveEntry(entry); setEditing(false); setShowCards(false);
    try {
      const { entry: full, related } = await api.getEntry(entry.id);
      setActiveEntry(full); setActiveRelated(related);
    } catch {}
  }

  async function handlePin(id, pinned) {
    try {
      await api.updateEntry(id, { pinned });
      setEntries(prev => prev.map(e => e.id === id ? { ...e, pinned } : e));
      if (activeEntry?.id === id) setActiveEntry(e => ({ ...e, pinned }));
      showToast(pinned ? "Entrada fixada" : "Entrada desafixada");
    } catch {}
  }

  async function handleDelete(id) {
    try {
      await api.deleteEntry(id);
      setEntries(prev => prev.filter(e => e.id !== id));
      setActiveEntry(null); setEditing(false);
      showToast("Entrada excluída");
      loadAll({ type: filter, search });
    } catch {}
  }

  function handleCreated(entry) {
    setEntries(prev => [entry, ...prev]);
    showToast(`${TYPE[entry.type]?.label || "Entrada"} criada`);
    loadAll({ type: filter, search });
  }

  function handleUpdate(updated) {
    setActiveEntry(updated);
    setEntries(prev => prev.map(e => e.id === updated.id ? updated : e));
    setEditing(false);
    showToast("Entrada atualizada");
    loadAll({ type: filter, search });
  }

  function handleThreadUpdate(updated) {
    setActiveEntry(updated);
    setEntries(prev => prev.map(e => e.id === updated.id ? updated : e));
  }

  const isLang = filter === "lang_fr" || filter === "lang_jp";
  const showSidebar = !isMobile || (!activeEntry && !showCards);
  const showMain    = !isMobile || !!activeEntry || showCards;

  return (
    <div style={{ height: "100vh", display: "flex", overflow: "hidden", background: "#f5f3f0" }}>
      {showHome && (
        <HomePage
          onClose={() => setShowHome(false)}
          onCreated={handleCreated}
          recentEntries={entries}
          onOpenEntry={openEntry}
        />
      )}

      {/* ── SIDEBAR ── */}
      {showSidebar && (
        <div style={{
          width: isMobile ? "100%" : 260, flexShrink: 0,
          background: "#1a1a1a",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Logo */}
          <div style={{ padding: "18px 16px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 8, flexShrink: 0,
              background: "#E8602C",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}><LogoIcon size={14} /></div>
            <span style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 600, color: "white", letterSpacing: "-0.01em" }}>Fields'</span>
            {/* Home button */}
            <button onClick={() => setShowHome(true)} style={{
              marginLeft: "auto", background: "rgba(255,255,255,0.08)", border: "none",
              borderRadius: 6, padding: "4px 8px", fontSize: 11, color: "rgba(255,255,255,0.5)",
              cursor: "pointer",
            }}>⌂</button>
          </div>

          {/* Search */}
          <div style={{ padding: "0 12px 10px" }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "rgba(255,255,255,0.3)", pointerEvents: "none" }}>⌕</span>
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Buscar…"
                style={{
                  width: "100%", background: "rgba(255,255,255,0.07)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10, padding: "8px 12px 8px 30px",
                  fontSize: 13, color: "white", outline: "none", boxSizing: "border-box",
                }}
              />
            </div>
          </div>

          {/* Filter tabs */}
          <div style={{ padding: "0 12px 6px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {FILTERS.map(f => (
                <button key={f.key} onClick={() => { setFilter(f.key); setShowLangMenu(false); }} style={{
                  background: filter === f.key ? "rgba(232,96,44,0.25)" : "transparent",
                  border: "none", borderRadius: "var(--r-full)", padding: "4px 10px",
                  fontSize: 11, fontWeight: 600,
                  color: filter === f.key ? "#f0956a" : "rgba(255,255,255,0.4)",
                  cursor: "pointer", transition: "all 0.15s",
                }}>{f.label}</button>
              ))}
              <button onClick={() => { setShowLangMenu(v => !v); if (!isLang) setFilter("all"); }} style={{
                background: isLang ? "rgba(0,85,164,0.3)" : "transparent",
                border: "none", borderRadius: "var(--r-full)", padding: "4px 10px",
                fontSize: 11, fontWeight: 600,
                color: isLang ? "#90aee8" : "rgba(255,255,255,0.4)",
                cursor: "pointer", display: "flex", alignItems: "center", gap: 3,
              }}>Línguas {showLangMenu || isLang ? "▴" : "▾"}</button>
            </div>
            {(showLangMenu || isLang) && (
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                {LANG_SUB.map(l => (
                  <button key={l.key} onClick={() => { setFilter(l.key); setShowLangMenu(true); }} style={{
                    background: filter === l.key ? "rgba(255,255,255,0.1)" : "transparent",
                    border: `1px solid ${filter === l.key ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)"}`,
                    borderRadius: "var(--r-full)", padding: "3px 10px",
                    fontSize: 11, fontWeight: 600,
                    color: filter === l.key ? "white" : "rgba(255,255,255,0.4)",
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
                  }}><span>{l.flag}</span>{l.label}</button>
                ))}
              </div>
            )}
          </div>

          {/* Views nav */}
          <div style={{ padding: "8px 12px 6px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", flexDirection: "column", gap: 3 }}>
            {[
              { key: "projects", icon: "◫", label: "Projetos" },
              { key: "agenda",   icon: "▦", label: "Agenda"   },
            ].map(({ key, icon, label }) => (
              <button key={key} onClick={() => setActiveView(v => v === key ? "entries" : key)} style={{
                width: "100%", textAlign: "left",
                background: activeView === key ? "rgba(232,96,44,0.15)" : "transparent",
                border: activeView === key ? "1px solid rgba(232,96,44,0.25)" : "1px solid transparent",
                borderRadius: 10, padding: "8px 12px",
                display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                color: activeView === key ? "#f0956a" : "rgba(255,255,255,0.4)",
                fontSize: 12, fontWeight: 600, transition: "all 0.15s",
              }}
                onMouseEnter={ev => { if (activeView !== key) { ev.currentTarget.style.background = "rgba(255,255,255,0.05)"; ev.currentTarget.style.color = "rgba(255,255,255,0.7)"; } }}
                onMouseLeave={ev => { if (activeView !== key) { ev.currentTarget.style.background = "transparent"; ev.currentTarget.style.color = "rgba(255,255,255,0.4)"; } }}
              >
                <span style={{ fontSize: 13 }}>{icon}</span> {label}
              </button>
            ))}
          </div>

          {/* Entry list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            {loading && (
              <div style={{ textAlign: "center", padding: "40px 20px", color: "rgba(255,255,255,0.3)", fontSize: 13 }}>
                <div style={{ marginBottom: 8 }}>◈</div>Carregando…
              </div>
            )}
            {!loading && entries.length === 0 && (
              <div style={{ textAlign: "center", padding: "40px 20px", color: "rgba(255,255,255,0.25)", fontSize: 13 }}>
                Nenhuma entrada
              </div>
            )}
            {entries.map(e => (
              <SidebarItem key={e.id} entry={e} active={activeEntry?.id === e.id && !showCards} onClick={() => openEntry(e)} />
            ))}
          </div>
        </div>
      )}

      {/* ── MAIN AREA ── */}
      {showMain && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#1e1e1e" }}>

          {/* Top bar */}
          <div style={{
            height: 52, flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex", alignItems: "center", padding: "0 24px", gap: 12,
            background: "#1e1e1e",
          }}>
            {isMobile && (activeEntry || showCards) && (
              <button onClick={() => { setActiveEntry(null); setEditing(false); setShowCards(false); }} style={{
                background: "rgba(232,96,44,0.15)", border: "none", borderRadius: "var(--r-full)",
                padding: "6px 14px", fontSize: 12, fontWeight: 600, color: "#E8602C", cursor: "pointer",
              }}>← Voltar</button>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
              <div style={{
                width: 24, height: 24, borderRadius: 6,
                background: "linear-gradient(135deg, #E8602C, #1a1a1a)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}><LogoIcon size={11} /></div>
              <span style={{ fontFamily: "var(--font-serif)", fontSize: 15, fontWeight: 600, color: "rgba(255,255,255,0.88)", letterSpacing: "-0.01em" }}>
                Fields' <span style={{ fontSize: 11, fontWeight: 400, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{{ projects: "projetos", agenda: "agenda" }[activeView] || "workspace"}</span>
              </span>
            </div>

            {/* Home button */}
            <button onClick={() => setShowHome(true)} style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "var(--r-full)", padding: "5px 12px",
              fontSize: 13, color: "rgba(255,255,255,0.4)", cursor: "pointer",
              transition: "all 0.15s", display: "flex", alignItems: "center", gap: 5,
            }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(232,96,44,0.15)"; e.currentTarget.style.color = "#E8602C"; e.currentTarget.style.borderColor = "rgba(232,96,44,0.4)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,255,255,0.4)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; }}
            >⌂ Home</button>

            {/* Cards toggle button */}
            <button
              onClick={() => { setShowCards(v => !v); if (!showCards) setActiveEntry(null); }}
              style={{
                background: showCards ? "rgba(232,96,44,0.2)" : "transparent",
                border: `1px solid ${showCards ? "rgba(232,96,44,0.4)" : "rgba(255,255,255,0.1)"}`,
                borderRadius: "var(--r-full)", padding: "6px 14px",
                fontSize: 12, fontWeight: 600,
                color: showCards ? "#E8602C" : "rgba(255,255,255,0.5)",
                cursor: "pointer", transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              ⊞ Cards
            </button>

            {activeEntry && !showCards && (
              <>
                {!isMobile && (
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {activeEntry.title.slice(0, 40)}{activeEntry.title.length > 40 ? "…" : ""}
                  </span>
                )}
                {/* Prev / Next navigation */}
                {(() => {
                  const idx = entries.findIndex(e => e.id === activeEntry.id);
                  const canPrev = idx > 0;
                  const canNext = idx >= 0 && idx < entries.length - 1;
                  const navBtn = (label, onClick, enabled) => (
                    <button onClick={onClick} disabled={!enabled} style={{
                      background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: "var(--r-full)", padding: "5px 12px",
                      fontSize: 13, fontWeight: 600,
                      color: enabled ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.15)",
                      cursor: enabled ? "pointer" : "default", transition: "all 0.15s",
                    }}>{label}</button>
                  );
                  return (
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      {navBtn("←", () => openEntry(entries[idx - 1]), canPrev)}
                      {navBtn("→", () => openEntry(entries[idx + 1]), canNext)}
                    </div>
                  );
                })()}
              </>
            )}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: "auto" }}>

            {/* Projects view */}
            {activeView === "projects" && <ProjectsView />}

            {/* Agenda view */}
            {activeView === "agenda" && <AgendaView />}

            {/* Cards view */}
            {activeView === "entries" && showCards && (
              <CardsView entries={entries} onOpen={openEntry} />
            )}

            {/* Empty state */}
            {activeView === "entries" && !showCards && !activeEntry && (
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                height: "100%", gap: 16, padding: 40,
              }}>
                <div style={{
                  width: 64, height: 64, borderRadius: 18,
                  background: "linear-gradient(135deg, #E8602C, #1a1a1a)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 8px 32px rgba(232,96,44,0.2)",
                }}><LogoIcon size={28} /></div>
                <div style={{ textAlign: "center" }}>
                  <p style={{ fontSize: 18, fontWeight: 600, color: "rgba(255,255,255,0.75)", fontFamily: "var(--font-serif)", marginBottom: 6 }}>Fields' Workspace</p>
                  <p style={{ fontSize: 14, color: "rgba(255,255,255,0.3)" }}>Selecione uma entrada ou crie uma nova abaixo</p>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 8 }}>
                  {[
                    { p: "evento …",   c: "#9a9aaa" }, { p: "lembrete …", c: "#c4a97a" },
                    { p: "frances …",  c: "#6699cc" }, { p: "jp …",       c: "#cc6677" },
                  ].map(({ p, c }) => (
                    <span key={p} style={{ fontSize: 12, fontWeight: 600, color: c, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", padding: "4px 12px", borderRadius: "var(--r-full)" }}>{p}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Entry view */}
            {activeView === "entries" && !showCards && activeEntry && !editing && (
              <EntryView
                entry={activeEntry}
                related={activeRelated}
                onEdit={() => setEditing(true)}
                onPin={() => handlePin(activeEntry.id, !activeEntry.pinned)}
                onDelete={() => handleDelete(activeEntry.id)}
                onUpdate={handleThreadUpdate}
              />
            )}

            {/* Edit form */}
            {activeView === "entries" && !showCards && activeEntry && editing && (
              <EditForm entry={activeEntry} onSave={handleUpdate} onCancel={() => setEditing(false)} />
            )}
          </div>

          {/* Input */}
          {activeView === "entries" && !showCards && <InputBar onCreated={handleCreated} bordered />}
        </div>
      )}

      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
