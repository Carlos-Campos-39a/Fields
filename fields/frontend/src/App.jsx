import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./api.js";

// ─── Constants ──────────────────────────────────────────────
const TYPE = {
  note:     { label: "Nota",      icon: "✦",  color: "#2970ff", bg: "#e8f0ff", border: "#c4d9ff" },
  event:    { label: "Evento",    icon: "◈",  color: "#0d52c4", bg: "#dce8ff", border: "#93bbff" },
  reminder: { label: "Lembrete", icon: "◉",  color: "#0a3d99", bg: "#d0dfff", border: "#7aaaff" },
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
function LogoIcon({ size = 16, color = "white" }) {
  return (
    <svg width={size} height={Math.round(size * 1.15)} viewBox="0 0 30 34" fill="none">
      {/* Vertical stroke */}
      <path d="M7 31 L7 3" stroke={color} strokeWidth="3.5" strokeLinecap="round"/>
      {/* Top horizontal bar */}
      <path d="M7 3 L23 3" stroke={color} strokeWidth="3.5" strokeLinecap="round"/>
      {/* Middle bar — gentle upward arc, like a horizon / open field */}
      <path d="M7 16 Q15 12.5 22 16" stroke={color} strokeWidth="3" strokeLinecap="round" fill="none"/>
      {/* Two floating dots — stars / sparks of imagination */}
      <circle cx="26.5" cy="2.5" r="2" fill={color} opacity="0.65"/>
      <circle cx="25"   cy="7.5" r="1.2" fill={color} opacity="0.38"/>
    </svg>
  );
}

// ─── Toast ──────────────────────────────────────────────────
function Toast({ msg, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return (
    <div style={{
      position: "fixed", bottom: 100, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, background: "#1c2033", color: "white",
      padding: "10px 20px", borderRadius: "var(--r-full)",
      fontSize: 13, fontWeight: 500, boxShadow: "0 4px 24px rgba(0,0,0,0.25)",
      whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 8,
    }}>
      <span style={{ color: "#5c96ff" }}>✓</span>{msg}
    </div>
  );
}

// ─── Tag ────────────────────────────────────────────────────
function Tag({ label }) {
  return (
    <span style={{
      display: "inline-block", fontSize: 11, fontWeight: 600,
      padding: "2px 10px", borderRadius: "var(--r-full)",
      background: "#e8f0ff", color: "#2970ff", letterSpacing: "0.02em",
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
        background: hov ? (danger ? "#fff0f0" : "#f0f5ff") : "white",
        border: "1px solid #dde5f7", borderRadius: "var(--r-full)",
        padding: "6px 14px", fontSize: 12, fontWeight: 600,
        color: danger ? (hov ? "#dc2626" : "#8fa3cc") : active ? "#2970ff" : "#6680aa",
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
        background: active ? "rgba(41,112,255,0.15)" : hov ? "rgba(255,255,255,0.05)" : "transparent",
        borderLeft: `3px solid ${active ? "#2970ff" : "transparent"}`,
        transition: "all 0.12s",
        borderRadius: "0 8px 8px 0",
        marginRight: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
        <span style={{ fontSize: isLang ? 13 : 10, color: active ? "#5c96ff" : "rgba(255,255,255,0.4)" }}>
          {meta.icon}
        </span>
        <span style={{
          fontSize: 13, fontWeight: active ? 600 : 400,
          color: active ? "white" : "rgba(255,255,255,0.75)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          maxWidth: 170,
        }}>{entry.title}</span>
        {entry.pinned && <span style={{ color: "#5c96ff", fontSize: 10, marginLeft: "auto", flexShrink: 0 }}>★</span>}
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
  const [threads, setThreads] = useState(entry.threads || []);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const textRef = useRef();

  useEffect(() => { setThreads(entry.threads || []); }, [entry.id]);

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
    <div style={{ marginTop: 40, borderTop: "1px solid #eef2fb", paddingTop: 28, paddingBottom: 40 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#8fa3cc", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16 }}>
        Anotações · {threads.length}
      </div>

      {/* Thread messages */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        {threads.length === 0 && (
          <div style={{ fontSize: 13, color: "#b8c7e8", fontStyle: "italic", padding: "8px 0" }}>
            Nenhuma anotação ainda. Adicione pensamentos, atualizações ou contexto abaixo.
          </div>
        )}
        {threads.map(t => (
          <div key={t.id} style={{
            background: "#f4f7ff", border: "1px solid #e4ecff",
            borderRadius: 14, padding: "12px 16px",
            position: "relative",
          }}>
            <p style={{ fontSize: 14, color: "#05102a", lineHeight: 1.65, whiteSpace: "pre-wrap", margin: 0, paddingRight: 24 }}>{t.text}</p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
              <span style={{ fontSize: 11, color: "#a0b4d4" }}>{formatDateTime(t.createdAt)}</span>
              <button onClick={() => deleteNote(t.id)} style={{
                background: "none", border: "none", fontSize: 15, color: "#c0cfea",
                cursor: "pointer", lineHeight: 1, padding: "0 2px",
              }}>×</button>
            </div>
          </div>
        ))}
      </div>

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
            flex: 1, border: "1.5px solid #dde5f7", borderRadius: 12,
            padding: "10px 14px", fontSize: 13, resize: "none",
            outline: "none", fontFamily: "inherit", color: "#05102a",
            lineHeight: 1.6, transition: "border-color 0.15s",
            background: "#fafcff",
          }}
          onFocus={e => e.target.style.borderColor = "#2970ff"}
          onBlur={e => e.target.style.borderColor = "#dde5f7"}
        />
        <button onClick={addNote} disabled={!text.trim() || saving} style={{
          background: text.trim() ? "#2970ff" : "#dde5f7",
          border: "none", borderRadius: 10, padding: "10px 16px",
          color: "white", fontSize: 16, fontWeight: 700,
          cursor: text.trim() ? "pointer" : "default", transition: "all 0.15s",
          flexShrink: 0,
        }}>↑</button>
      </div>
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
        color: "#05102a", lineHeight: 1.25, marginBottom: 20, letterSpacing: "-0.01em",
      }}>{entry.title}</h1>

      {/* Content */}
      <p style={{
        fontSize: 15, lineHeight: 1.85, color: "#3a4a6b",
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
        fontSize: 12, color: "#8fa3cc",
        borderTop: "1px solid #eef2fb", paddingTop: 16, marginBottom: 8,
      }}>{formatDate(entry.date)}</div>

      {/* Related */}
      {related && related.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#8fa3cc", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 12, marginTop: 24 }}>
            Relacionadas por tags
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {related.map(r => {
              const rm = TYPE[r.type] || TYPE.note;
              return (
                <div key={r.id} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "12px 16px", borderRadius: "var(--r-lg)",
                  border: "1px solid #eef2fb", background: "#f8faff",
                }}>
                  <span style={{ fontSize: 12, color: rm.color }}>{rm.icon}</span>
                  <span style={{ fontSize: 13, color: "#0a1f4e", flex: 1 }}>{r.title}</span>
                  <span style={{ fontSize: 11, color: "#8fa3cc" }}>{formatDate(r.date)}</span>
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
    width: "100%", border: "1px solid #dde5f7", borderRadius: "var(--r-md)",
    padding: "10px 14px", fontSize: 14, color: "#05102a", outline: "none",
    background: "white", boxSizing: "border-box", fontFamily: "inherit",
    transition: "border-color 0.15s",
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 24px", animation: "fadeUp 0.2s ease both" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#2970ff", letterSpacing: "0.08em", textTransform: "uppercase" }}>Editando</span>
        <div style={{ display: "flex", gap: 8 }}>
          <ActionBtn label="Cancelar" onClick={onCancel} />
          <button onClick={save} disabled={saving} style={{
            background: "#2970ff", border: "none", borderRadius: "var(--r-full)",
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
              background: form.type === key ? m.bg : "white",
              border: `1.5px solid ${form.type === key ? m.border : "#dde5f7"}`,
              borderRadius: "var(--r-full)", padding: "5px 14px",
              fontSize: 12, fontWeight: 600, color: form.type === key ? m.color : "#8fa3cc",
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
  return <div style={{ fontSize: 11, fontWeight: 700, color: "#8fa3cc", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>{children}</div>;
}

// ─── Cards View (Masonry) ────────────────────────────────────
function CardsView({ entries, onOpen }) {
  const [hovId, setHovId] = useState(null);

  if (entries.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#b8c7e8", fontSize: 14 }}>
        Nenhuma entrada para exibir
      </div>
    );
  }

  return (
    <div style={{ padding: "28px 24px", overflowY: "auto", height: "100%", boxSizing: "border-box" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#8fa3cc", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 20 }}>
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
                background: hov ? "#f4f8ff" : "white",
                border: `1.5px solid ${hov ? meta.border : "#eef2fb"}`,
                borderRadius: 16,
                padding: "16px 18px",
                cursor: "pointer",
                transition: "all 0.15s",
                boxShadow: hov ? "0 4px 20px rgba(41,112,255,0.1)" : "0 1px 4px rgba(10,31,78,0.05)",
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
                {entry.pinned && <span style={{ marginLeft: "auto", color: "#2970ff", fontSize: 11 }}>★</span>}
              </div>

              {/* Title */}
              <h3 style={{
                fontSize: 14, fontWeight: 600, color: "#05102a",
                marginBottom: 8, lineHeight: 1.4,
                fontFamily: "var(--font-serif)",
              }}>{entry.title}</h3>

              {/* Content preview */}
              <p style={{
                fontSize: 12.5, color: "#6680aa", lineHeight: 1.65,
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
                <span style={{ fontSize: 10.5, color: "#b8c7e8" }}>{relativeDate(entry.date)}</span>
                {threadCount > 0 && (
                  <span style={{ fontSize: 10, color: "#8fa3cc", display: "flex", alignItems: "center", gap: 3 }}>
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
function InputBar({ onCreated }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const ref = useRef();

  const detected = text.trim() ? parseInput(text) : null;
  const meta = detected ? TYPE[detected.type] : null;

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
    <div style={{ padding: "12px 24px 20px", background: "white", flexShrink: 0, borderTop: "1px solid #eef2fb" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", position: "relative" }}>
        {meta && (
          <div style={{
            position: "absolute", top: -32, left: "50%", transform: "translateX(-50%)",
            background: meta.bg, border: `1px solid ${meta.border}`,
            borderRadius: "var(--r-full)", padding: "3px 14px",
            fontSize: 11, fontWeight: 700, color: meta.color,
            display: "flex", alignItems: "center", gap: 5,
            boxShadow: "0 2px 8px rgba(0,0,0,0.07)", whiteSpace: "nowrap", pointerEvents: "none",
          }}>
            <span>{meta.icon}</span>{meta.label}
          </div>
        )}
        <div style={{
          display: "flex", alignItems: "flex-end", gap: 10,
          background: focused ? "white" : "#f8faff",
          border: `1.5px solid ${focused ? "#2970ff" : "#dde5f7"}`,
          borderRadius: 16, padding: "12px 14px",
          boxShadow: focused ? "0 0 0 4px rgba(41,112,255,0.08)" : "0 2px 8px rgba(10,31,78,0.05)",
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
              background: "transparent", fontSize: 14, color: "#05102a",
              lineHeight: 1.6, maxHeight: 160, overflowY: "auto",
            }}
          />
          <button onClick={submit} disabled={!text.trim() || loading} style={{
            width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
            background: text.trim() ? "#2970ff" : "#dde5f7",
            border: "none", color: "white", fontSize: 15,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: text.trim() ? "pointer" : "default", transition: "all 0.15s",
            boxShadow: text.trim() ? "0 2px 8px rgba(41,112,255,0.35)" : "none",
          }}>
            {loading ? <span style={{ fontSize: 11 }}>…</span> : "↑"}
          </button>
        </div>
        <div style={{ textAlign: "center", marginTop: 8, fontSize: 11, color: "#b8c7e8" }}>
          Enter para registrar · Alt+Enter para nova linha
        </div>
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
    { p: "evento …",   c: "#0d52c4", bg: "#dce8ff" },
    { p: "lembrete …", c: "#0a3d99", bg: "#d0dfff" },
    { p: "frances …",  c: "#0055A4", bg: "#e8eeff" },
    { p: "jp …",       c: "#BC002D", bg: "#ffecec" },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "#f5f7fc",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: "24px 24px 40px",
      overflowY: "auto",
    }}>
      {/* Close */}
      <button onClick={onClose} style={{
        position: "fixed", top: 20, right: 24,
        background: "rgba(10,31,78,0.06)", border: "none", borderRadius: "50%",
        width: 36, height: 36, fontSize: 20, cursor: "pointer",
        color: "#8fa3cc", display: "flex", alignItems: "center", justifyContent: "center",
        lineHeight: 1,
      }}>×</button>

      <div style={{ width: "100%", maxWidth: 640, display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>

        {/* Logo + Greeting */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 72, height: 72, borderRadius: 22, margin: "0 auto 20px",
            background: "linear-gradient(135deg, #2970ff 0%, #091f5c 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 12px 40px rgba(41,112,255,0.28)",
          }}><LogoIcon size={32} /></div>
          <h1 style={{
            fontFamily: "var(--font-serif)", fontSize: 34, fontWeight: 600,
            color: "#05102a", marginBottom: 8, letterSpacing: "-0.02em", lineHeight: 1.2,
          }}>{greeting}, Carlos.</h1>
          <p style={{ fontSize: 16, color: "#8fa3cc", fontWeight: 400 }}>
            O que você quer capturar hoje?
          </p>
        </div>

        {/* Input Card */}
        <div style={{
          width: "100%", background: "white", borderRadius: 20,
          boxShadow: "0 4px 32px rgba(10,31,78,0.08)", border: "1px solid #eef2fb",
          overflow: "hidden", marginBottom: 16,
        }}>
          <InputBar onCreated={handleCreated} />
          {lastCreated && (
            <div style={{ textAlign: "center", padding: "0 24px 16px", fontSize: 13, color: "#2970ff", fontWeight: 600 }}>
              ✓ {lastCreated} criada com sucesso
            </div>
          )}
        </div>

        {/* Prefix hints */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginBottom: 36 }}>
          {HINTS.map(({ p, c, bg }) => (
            <span key={p} style={{
              fontSize: 11, fontWeight: 600, color: c, background: bg,
              border: `1px solid ${c}30`, padding: "4px 12px", borderRadius: "var(--r-full)",
            }}>{p}</span>
          ))}
          <span style={{ fontSize: 11, color: "#b8c7e8", alignSelf: "center" }}>— prefixos de tipo</span>
        </div>

        {/* Recent entries */}
        {recentEntries.length > 0 && (
          <div style={{ width: "100%" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#b8c7e8", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 12, textAlign: "center" }}>
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
                      background: "white", border: "1px solid #eef2fb",
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                      transition: "all 0.12s",
                    }}
                    onMouseEnter={ev => { ev.currentTarget.style.background = "#f4f7ff"; ev.currentTarget.style.borderColor = "#c4d9ff"; }}
                    onMouseLeave={ev => { ev.currentTarget.style.background = "white"; ev.currentTarget.style.borderColor = "#eef2fb"; }}
                  >
                    <span style={{ fontSize: isLang ? 16 : 13, color: meta.color, flexShrink: 0 }}>{meta.icon}</span>
                    <span style={{ flex: 1, fontSize: 14, color: "#05102a", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</span>
                    {e.threads?.length > 0 && <span style={{ fontSize: 11, color: "#b8c7e8" }}>💬 {e.threads.length}</span>}
                    <span style={{ fontSize: 11, color: "#b8c7e8", flexShrink: 0 }}>{relativeDate(e.date)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Workspace link */}
        <button onClick={onClose} style={{
          marginTop: 24, background: "transparent", border: "none",
          fontSize: 13, color: "#8fa3cc", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 4,
          padding: "8px 16px", borderRadius: "var(--r-full)",
          transition: "color 0.15s",
        }}
          onMouseEnter={e => e.currentTarget.style.color = "#2970ff"}
          onMouseLeave={e => e.currentTarget.style.color = "#8fa3cc"}
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
    <div style={{ height: "100vh", display: "flex", overflow: "hidden", background: "#f8faff" }}>
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
          background: "#1c2033",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Logo */}
          <div style={{ padding: "18px 16px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 8, flexShrink: 0,
              background: "rgba(255,255,255,0.1)",
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
                  background: filter === f.key ? "rgba(41,112,255,0.25)" : "transparent",
                  border: "none", borderRadius: "var(--r-full)", padding: "4px 10px",
                  fontSize: 11, fontWeight: 600,
                  color: filter === f.key ? "#5c96ff" : "rgba(255,255,255,0.4)",
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
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "white" }}>

          {/* Top bar */}
          <div style={{
            height: 52, flexShrink: 0, borderBottom: "1px solid #eef2fb",
            display: "flex", alignItems: "center", padding: "0 24px", gap: 12,
          }}>
            {isMobile && (activeEntry || showCards) && (
              <button onClick={() => { setActiveEntry(null); setEditing(false); setShowCards(false); }} style={{
                background: "#f0f5ff", border: "none", borderRadius: "var(--r-full)",
                padding: "6px 14px", fontSize: 12, fontWeight: 600, color: "#2970ff", cursor: "pointer",
              }}>← Voltar</button>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
              <div style={{
                width: 24, height: 24, borderRadius: 6,
                background: "linear-gradient(135deg, #2970ff, #091f5c)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}><LogoIcon size={11} /></div>
              <span style={{ fontFamily: "var(--font-serif)", fontSize: 15, fontWeight: 600, color: "#05102a", letterSpacing: "-0.01em" }}>
                Fields' <span style={{ fontSize: 11, fontWeight: 400, color: "#8fa3cc", letterSpacing: "0.1em", textTransform: "uppercase" }}>workspace</span>
              </span>
            </div>

            {/* Cards toggle button */}
            <button
              onClick={() => { setShowCards(v => !v); if (!showCards) setActiveEntry(null); }}
              style={{
                background: showCards ? "#e8f0ff" : "transparent",
                border: `1px solid ${showCards ? "#c4d9ff" : "#dde5f7"}`,
                borderRadius: "var(--r-full)", padding: "6px 14px",
                fontSize: 12, fontWeight: 600,
                color: showCards ? "#2970ff" : "#6680aa",
                cursor: "pointer", transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              ⊞ Cards
            </button>

            {activeEntry && !showCards && !isMobile && (
              <span style={{ fontSize: 12, color: "#b8c7e8" }}>
                {activeEntry.title.slice(0, 40)}{activeEntry.title.length > 40 ? "…" : ""}
              </span>
            )}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: "auto" }}>

            {/* Cards view */}
            {showCards && (
              <CardsView entries={entries} onOpen={openEntry} />
            )}

            {/* Empty state */}
            {!showCards && !activeEntry && (
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                height: "100%", gap: 16, padding: 40,
              }}>
                <div style={{
                  width: 64, height: 64, borderRadius: 18,
                  background: "linear-gradient(135deg, #2970ff, #091f5c)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 8px 32px rgba(41,112,255,0.2)",
                }}><LogoIcon size={28} /></div>
                <div style={{ textAlign: "center" }}>
                  <p style={{ fontSize: 18, fontWeight: 600, color: "#05102a", fontFamily: "var(--font-serif)", marginBottom: 6 }}>Fields' Workspace</p>
                  <p style={{ fontSize: 14, color: "#8fa3cc" }}>Selecione uma entrada ou crie uma nova abaixo</p>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 8 }}>
                  {[
                    { p: "evento …",   c: "#0d52c4" }, { p: "lembrete …", c: "#0a3d99" },
                    { p: "frances …",  c: "#0055A4" }, { p: "jp …",       c: "#BC002D" },
                  ].map(({ p, c }) => (
                    <span key={p} style={{ fontSize: 12, fontWeight: 600, color: c, background: `${c}10`, border: `1px solid ${c}25`, padding: "4px 12px", borderRadius: "var(--r-full)" }}>{p}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Entry view */}
            {!showCards && activeEntry && !editing && (
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
            {!showCards && activeEntry && editing && (
              <EditForm entry={activeEntry} onSave={handleUpdate} onCancel={() => setEditing(false)} />
            )}
          </div>

          {/* Input */}
          {!showCards && <InputBar onCreated={handleCreated} />}
        </div>
      )}

      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
