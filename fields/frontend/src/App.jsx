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

// ─── Logo SVG ───────────────────────────────────────────────
function LogoIcon({ size = 16, color = "white" }) {
  const s = size;
  return (
    <svg width={s} height={Math.round(s * 0.8)} viewBox="0 0 20 16" fill="none">
      <line x1="1" y1="1.5"  x2="19" y2="1.5"  stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="1" y1="8"    x2="12" y2="8"    stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="1" y1="14.5" x2="7"  y2="14.5" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── Toast ──────────────────────────────────────────────────
function Toast({ msg, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return (
    <div style={{
      position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, background: "var(--blue-900)", color: "white",
      padding: "10px 20px", borderRadius: "var(--r-full)",
      fontSize: 13, fontWeight: 500, boxShadow: "var(--shadow-lg)",
      animation: "fadeUp 0.2s ease both", whiteSpace: "nowrap",
      display: "flex", alignItems: "center", gap: 8,
    }}>
      <span style={{ color: "var(--blue-300)" }}>✓</span>{msg}
    </div>
  );
}

// ─── Tag ────────────────────────────────────────────────────
function Tag({ label, light }) {
  return (
    <span style={{
      display: "inline-block", fontSize: 10, fontWeight: 600,
      padding: "2px 8px", borderRadius: "var(--r-full)",
      background: light ? "rgba(255,255,255,0.22)" : "var(--blue-100)",
      color: light ? "rgba(255,255,255,0.9)" : "var(--blue-700)",
      letterSpacing: "0.02em",
    }}>{label}</span>
  );
}

// ─── Entry List Item (sidebar) ───────────────────────────────
function EntryListItem({ entry, active, onClick }) {
  const meta = TYPE[entry.type] || TYPE.note;
  const [hov, setHov] = useState(false);
  const isLang = entry.type.startsWith("lang_");
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", gap: 12, alignItems: "center",
        padding: "11px 16px",
        background: active ? "#e8f0ff" : hov ? "#f4f7ff" : "var(--white)",
        borderBottom: "1px solid #f0f4fb",
        cursor: "pointer", transition: "background 0.12s",
        borderLeft: `3px solid ${active ? "var(--blue-500)" : "transparent"}`,
      }}
    >
      <div style={{
        width: 46, height: 46, borderRadius: "50%", flexShrink: 0,
        background: active ? meta.bg : "#f0f4fb",
        border: `2px solid ${active ? meta.color : "transparent"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: isLang ? 22 : 16, color: meta.color,
        transition: "all 0.15s",
      }}>{meta.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 4 }}>
          <span style={{
            fontWeight: 600, fontSize: 13.5, color: "var(--blue-950)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "62%",
          }}>{entry.title}</span>
          <span style={{ fontSize: 11, color: active ? "var(--blue-500)" : "var(--gray-400)", flexShrink: 0 }}>
            {relativeDate(entry.date)}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
          <span style={{
            fontSize: 12, color: "var(--gray-400)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "85%",
          }}>{entry.content}</span>
          {entry.pinned && <span style={{ color: "var(--blue-400)", fontSize: 12 }}>★</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Chat Bubble ─────────────────────────────────────────────
function ChatBubble({ entry, isMain }) {
  const meta = TYPE[entry.type] || TYPE.note;
  const isLang = entry.type.startsWith("lang_");
  const hasDate = entry.type === "event" || entry.type === "reminder";
  return (
    <div style={{
      display: "flex", justifyContent: isMain ? "flex-end" : "flex-start",
      marginBottom: 14, animation: "fadeUp 0.2s ease both",
    }}>
      {!isMain && (
        <div style={{
          width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
          background: meta.bg, border: `1.5px solid ${meta.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: isLang ? 16 : 13, marginRight: 8, alignSelf: "flex-end",
        }}>{meta.icon}</div>
      )}
      <div style={{ maxWidth: "72%", display: "flex", flexDirection: "column", alignItems: isMain ? "flex-end" : "flex-start" }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
          color: isMain ? "var(--blue-500)" : meta.color, marginBottom: 4,
        }}>{meta.label}</span>
        <div style={{
          background: isMain ? "linear-gradient(135deg, #2970ff 0%, #1040a0 100%)" : "var(--white)",
          color: isMain ? "white" : "var(--blue-950)",
          borderRadius: isMain ? "18px 4px 18px 18px" : "4px 18px 18px 18px",
          padding: "12px 16px",
          boxShadow: "0 1px 4px rgba(10,31,78,.13)",
        }}>
          <div style={{
            fontFamily: "var(--font-serif)", fontWeight: 600, fontSize: 15, lineHeight: 1.3,
            color: isMain ? "white" : "var(--blue-950)", marginBottom: 8,
          }}>{entry.title}</div>
          <div style={{
            fontSize: 13, lineHeight: 1.75,
            color: isMain ? "rgba(255,255,255,0.9)" : "var(--gray-600)",
            whiteSpace: "pre-wrap",
          }}>{entry.content}</div>
          {entry.tags.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 10 }}>
              {entry.tags.map(t => <Tag key={t} label={`#${t}`} light={isMain} />)}
            </div>
          )}
          <div style={{
            marginTop: 10, fontSize: 11, textAlign: "right",
            color: isMain ? "rgba(255,255,255,0.6)" : "var(--gray-400)",
            display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6,
          }}>
            {hasDate && entry.date
              ? <span style={{ fontWeight: 600, color: isMain ? "rgba(255,255,255,0.8)" : meta.color }}>
                  {relativeDate(entry.date)}{entry.time ? ` · ${entry.time}` : ""}
                </span>
              : <span>{formatDate(entry.date)}</span>
            }
            {entry.pinned && <span>★</span>}
          </div>
        </div>
      </div>
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
    width: "100%", border: "1.5px solid var(--border)", borderRadius: "var(--r-md)",
    padding: "9px 12px", fontSize: 13, color: "var(--blue-950)", outline: "none",
    background: "var(--white)", boxSizing: "border-box", fontFamily: "inherit",
  };

  return (
    <div style={{
      background: "rgba(255,255,255,0.97)", borderRadius: "var(--r-xl)",
      boxShadow: "var(--shadow-lg)", padding: "20px 22px",
      animation: "scaleIn 0.2s ease both",
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--blue-600)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 16 }}>
        Editar entrada
      </div>

      {/* Tipo */}
      <div style={{ marginBottom: 12 }}>
        <Label>Tipo</Label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {Object.entries(TYPE).map(([key, m]) => (
            <button key={key} onClick={() => setForm(f => ({ ...f, type: key }))} style={{
              background: form.type === key ? m.bg : "var(--gray-50)",
              border: `1.5px solid ${form.type === key ? m.border : "var(--border)"}`,
              borderRadius: "var(--r-full)", padding: "5px 12px",
              fontSize: 12, fontWeight: 600, color: form.type === key ? m.color : "var(--gray-400)",
              cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
            }}><span>{m.icon}</span>{m.label}</button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <Label>Título</Label>
        <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={{ ...field, fontWeight: 600, fontSize: 14 }} />
      </div>
      <div style={{ marginBottom: 10 }}>
        <Label>Conteúdo</Label>
        <textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} rows={5} style={{ ...field, resize: "vertical", lineHeight: 1.7 }} />
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}><Label>Data</Label><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={field} /></div>
        <div style={{ flex: 1 }}><Label>Hora</Label><input type="time" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} style={field} /></div>
      </div>
      <div style={{ marginBottom: 18 }}>
        <Label>Tags <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(separadas por vírgula)</span></Label>
        <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="Ex: Trabalho, TCC" style={field} />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ background: "var(--gray-100)", border: "none", borderRadius: "var(--r-full)", padding: "8px 18px", fontSize: 12, fontWeight: 600, color: "var(--gray-500)", cursor: "pointer" }}>Cancelar</button>
        <button onClick={save} disabled={saving} style={{ background: "var(--blue-500)", border: "none", borderRadius: "var(--r-full)", padding: "8px 22px", fontSize: 12, fontWeight: 600, color: "white", cursor: saving ? "default" : "pointer", opacity: saving ? 0.7 : 1 }}>{saving ? "Salvando…" : "Salvar"}</button>
      </div>
    </div>
  );
}

function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: "var(--gray-400)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>{children}</div>;
}

// ─── Chat Input (bottom bar) ─────────────────────────────────
function ChatInput({ onCreated }) {
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
    <div style={{
      background: "#eef2fb", borderTop: "1px solid var(--border)",
      padding: "10px 14px", display: "flex", gap: 10, alignItems: "flex-end",
      flexShrink: 0, position: "relative",
    }}>
      {meta && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          background: meta.bg, border: `1px solid ${meta.border}`,
          borderRadius: "var(--r-full)", padding: "3px 14px",
          fontSize: 11, fontWeight: 700, color: meta.color,
          display: "flex", alignItems: "center", gap: 5,
          boxShadow: "var(--shadow-sm)", animation: "fadeIn 0.15s ease",
          whiteSpace: "nowrap", pointerEvents: "none",
        }}>
          <span>{meta.icon}</span>{meta.label}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={e => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder="Nova nota, evento, lembrete…"
        style={{
          flex: 1, border: "none", outline: "none", resize: "none",
          background: "var(--white)", borderRadius: 22,
          padding: "10px 16px", fontSize: 14, color: "var(--blue-950)", lineHeight: 1.5,
          boxShadow: focused ? "0 0 0 2px rgba(41,112,255,0.2)" : "var(--shadow-xs)",
          maxHeight: 120, overflowY: "auto", transition: "box-shadow 0.15s",
        }}
      />
      <button
        onClick={submit}
        disabled={!text.trim() || loading}
        style={{
          width: 42, height: 42, borderRadius: "50%", flexShrink: 0,
          background: text.trim() ? "var(--blue-500)" : "var(--gray-300)",
          border: "none", color: "white", fontSize: 18, cursor: text.trim() ? "pointer" : "default",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: text.trim() ? "0 2px 8px rgba(41,112,255,0.4)" : "none",
          transition: "all 0.15s",
        }}
      >{loading ? <span style={{ fontSize: 12 }}>…</span> : "↑"}</button>
    </div>
  );
}

// ─── Header button (chat header) ────────────────────────────
function HeaderBtn({ icon, onClick, title, active, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.1)",
        border: "none", borderRadius: "50%", width: 34, height: 34,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14, cursor: "pointer", transition: "all 0.15s",
        color: danger && hov ? "#fca5a5" : active ? "#93bbff" : "rgba(255,255,255,0.85)",
      }}>{icon}</button>
  );
}

// ─── Dark header bar ─────────────────────────────────────────
const HEADER_BG = "linear-gradient(90deg, #091f5c 0%, #0f3399 100%)";

// ─── Home Page ──────────────────────────────────────────────
function HomePage({ onClose, onCreated }) {
  const [lastCreated, setLastCreated] = useState(null);
  function handleCreated(entry) {
    onCreated(entry);
    setLastCreated(TYPE[entry.type]?.label || "Entrada");
    setTimeout(() => setLastCreated(null), 2500);
  }
  return (
    <div className="home-overlay">
      <button className="home-close" onClick={onClose} title="Fechar">×</button>
      <div className="home-card">
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
          <div style={{
            width: 50, height: 50, borderRadius: "var(--r-lg)", flexShrink: 0,
            background: "linear-gradient(135deg, #2970ff, #091f5c)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 16px rgba(41,112,255,0.3)",
          }}><LogoIcon size={22} /></div>
          <div>
            <div style={{ fontFamily: "var(--font-serif)", fontSize: 28, fontWeight: 600, color: "var(--blue-950)", letterSpacing: "-0.02em", lineHeight: 1.1 }}>Fields'</div>
            <div style={{ fontSize: 13, color: "var(--gray-400)", marginTop: 2 }}>Capture tudo. Encontre sempre.</div>
          </div>
        </div>
        <div style={{ height: "1.5px", background: "var(--border)", margin: "10px 0 24px" }} />
        <ChatInput onCreated={handleCreated} />
        {lastCreated && (
          <div className="animate-fadeUp" style={{ marginTop: 10, textAlign: "center", fontSize: 13, color: "var(--blue-500)", fontWeight: 600 }}>
            ✓ {lastCreated} criada
          </div>
        )}
        <div className="home-hints" style={{ marginTop: 14 }}>
          {[
            { p: "evento …",   c: "#0d52c4" }, { p: "lembrete …", c: "#0a3d99" },
            { p: "frances …",  c: "#0055A4" }, { p: "jp …",       c: "#BC002D" },
          ].map(({ p, c }) => (
            <span key={p} style={{ fontSize: 11, fontWeight: 700, color: c, background: `${c}12`, border: `1px solid ${c}28`, padding: "3px 10px", borderRadius: "var(--r-full)" }}>{p}</span>
          ))}
          <span style={{ fontSize: 11, color: "var(--gray-400)", alignSelf: "center", marginLeft: 4 }}>— prefixos de tipo</span>
        </div>
        <button className="home-workspace-btn" onClick={onClose}>Abrir workspace →</button>
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
    setActiveEntry(entry); setEditing(false);
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

  const isLang = filter === "lang_fr" || filter === "lang_jp";
  const showSidebar = !isMobile || !activeEntry;
  const showChat    = !isMobile || !!activeEntry;

  return (
    <div style={{ height: "100vh", display: "flex", overflow: "hidden", background: "var(--gray-100)" }}>
      {showHome && <HomePage onClose={() => setShowHome(false)} onCreated={handleCreated} />}

      {/* ── SIDEBAR ── */}
      {showSidebar && (
        <div style={{
          width: isMobile ? "100%" : 340, flexShrink: 0,
          display: "flex", flexDirection: "column",
          background: "var(--white)",
          borderRight: "1.5px solid var(--border)",
          overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            background: HEADER_BG, padding: "13px 16px",
            display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: "var(--r-md)",
              background: "rgba(255,255,255,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}><LogoIcon size={17} /></div>
            <span style={{ fontFamily: "var(--font-serif)", fontSize: 19, fontWeight: 600, color: "white", letterSpacing: "-0.01em" }}>Fields'</span>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", marginLeft: 2 }}>workspace</span>
          </div>

          {/* Search */}
          <div style={{ padding: "8px 12px", background: "#f4f7ff", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "var(--gray-400)", pointerEvents: "none" }}>⌕</span>
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Buscar entradas…"
                style={{
                  width: "100%", background: "var(--white)", border: "1.5px solid var(--border)",
                  borderRadius: "var(--r-full)", padding: "8px 14px 8px 32px",
                  fontSize: 13, color: "var(--blue-950)", outline: "none", boxSizing: "border-box",
                }}
              />
            </div>
          </div>

          {/* Filter tabs */}
          <div style={{ background: "var(--white)", borderBottom: "1.5px solid var(--border)", flexShrink: 0 }}>
            <div className="filter-tabs" style={{ display: "flex", padding: "0 10px", gap: 0 }}>
              {FILTERS.map(f => (
                <button key={f.key} onClick={() => { setFilter(f.key); setShowLangMenu(false); }} style={{
                  background: "none", border: "none",
                  borderBottom: filter === f.key ? "2.5px solid var(--blue-500)" : "2.5px solid transparent",
                  padding: "8px 10px 9px", fontSize: 12, fontWeight: 600,
                  color: filter === f.key ? "var(--blue-500)" : "var(--gray-400)",
                  cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.15s", flexShrink: 0,
                }}>{f.label}</button>
              ))}
              <button onClick={() => { setShowLangMenu(v => !v); if (!isLang) setFilter("all"); }} style={{
                background: "none", border: "none",
                borderBottom: isLang ? "2.5px solid #0055A4" : "2.5px solid transparent",
                padding: "8px 10px 9px", fontSize: 12, fontWeight: 600,
                color: isLang ? "#0055A4" : "var(--gray-400)",
                cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.15s", flexShrink: 0,
                display: "flex", alignItems: "center", gap: 4,
              }}>Línguas {showLangMenu || isLang ? "▴" : "▾"}</button>
            </div>
            {(showLangMenu || isLang) && (
              <div style={{ display: "flex", gap: 6, padding: "6px 12px 8px" }}>
                {LANG_SUB.map(l => (
                  <button key={l.key} onClick={() => { setFilter(l.key); setShowLangMenu(true); }} style={{
                    background: filter === l.key ? l.bg : "transparent",
                    color: filter === l.key ? l.color : "var(--gray-400)",
                    border: `1.5px solid ${filter === l.key ? l.border : "var(--border)"}`,
                    borderRadius: "var(--r-full)", padding: "3px 12px",
                    fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
                    display: "flex", alignItems: "center", gap: 5,
                  }}><span>{l.flag}</span>{l.label}</button>
                ))}
              </div>
            )}
          </div>

          {/* Entry list */}
          <div className="wa-list" style={{ flex: 1 }}>
            {loading && (
              <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--gray-400)" }}>
                <div style={{ animation: "pulse 1s infinite", fontSize: 22, marginBottom: 10 }}>◈</div>
                <span style={{ fontSize: 13 }}>Carregando…</span>
              </div>
            )}
            {!loading && entries.length === 0 && (
              <div style={{ textAlign: "center", padding: "48px 20px" }}>
                <div style={{ fontSize: 30, color: "var(--blue-200)", marginBottom: 10 }}>✦</div>
                <p style={{ fontSize: 13, color: "var(--gray-400)" }}>Nenhuma entrada.</p>
              </div>
            )}
            {entries.map(e => (
              <EntryListItem key={e.id} entry={e} active={activeEntry?.id === e.id} onClick={() => openEntry(e)} />
            ))}
          </div>
        </div>
      )}

      {/* ── CHAT AREA ── */}
      {showChat && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
          {activeEntry ? (<>

            {/* Chat header */}
            <div style={{
              background: HEADER_BG, padding: "10px 14px",
              display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
            }}>
              {isMobile && (
                <button onClick={() => { setActiveEntry(null); setEditing(false); }} style={{
                  background: "rgba(255,255,255,0.15)", border: "none", borderRadius: "50%",
                  width: 32, height: 32, color: "white", fontSize: 16, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>←</button>
              )}
              {(() => {
                const m = TYPE[activeEntry.type] || TYPE.note;
                const isL = activeEntry.type.startsWith("lang_");
                return (
                  <div style={{
                    width: 38, height: 38, borderRadius: "50%", flexShrink: 0,
                    background: "rgba(255,255,255,0.15)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: isL ? 20 : 15,
                  }}>{m.icon}</div>
                );
              })()}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: "white", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{activeEntry.title}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginTop: 1 }}>
                  {(TYPE[activeEntry.type] || TYPE.note).label}
                  {activeEntry.date ? ` · ${relativeDate(activeEntry.date)}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                {!editing && <>
                  <HeaderBtn icon="✎" title="Editar" onClick={() => setEditing(true)} />
                  <HeaderBtn icon={activeEntry.pinned ? "★" : "☆"} title={activeEntry.pinned ? "Desafixar" : "Fixar"} active={activeEntry.pinned} onClick={() => handlePin(activeEntry.id, !activeEntry.pinned)} />
                  <HeaderBtn icon="✕" title="Excluir" danger onClick={() => handleDelete(activeEntry.id)} />
                </>}
                {editing && (
                  <button onClick={() => setEditing(false)} style={{
                    background: "rgba(255,255,255,0.15)", border: "none", borderRadius: "var(--r-full)",
                    padding: "6px 14px", fontSize: 12, fontWeight: 600, color: "white", cursor: "pointer",
                  }}>Cancelar</button>
                )}
              </div>
            </div>

            {/* Messages / Edit */}
            <div className="chat-bg" style={{ flex: 1, overflowY: "auto", padding: "20px 16px" }}>
              {editing ? (
                <EditForm entry={activeEntry} onSave={handleUpdate} onCancel={() => setEditing(false)} />
              ) : (<>
                <ChatBubble entry={activeEntry} isMain />
                {activeRelated.length > 0 && (
                  <div style={{ textAlign: "center", margin: "6px 0 14px" }}>
                    <span style={{ fontSize: 11, color: "var(--gray-500)", background: "rgba(255,255,255,0.75)", padding: "3px 14px", borderRadius: "var(--r-full)", boxShadow: "var(--shadow-xs)" }}>
                      Relacionadas por tags
                    </span>
                  </div>
                )}
                {activeRelated.map(r => <ChatBubble key={r.id} entry={r} />)}
              </>)}
            </div>
          </>) : (
            /* Empty state */
            <div className="chat-bg" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
              <div style={{
                width: 80, height: 80, borderRadius: "50%",
                background: "rgba(255,255,255,0.85)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "var(--shadow-md)",
              }}><LogoIcon size={32} color="#2970ff" /></div>
              <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: 16, fontWeight: 600, color: "var(--blue-700)", marginBottom: 4 }}>Fields' Workspace</p>
                <p style={{ fontSize: 13, color: "var(--gray-500)" }}>Selecione uma entrada à esquerda</p>
              </div>
            </div>
          )}

          {/* Input bar */}
          <ChatInput onCreated={handleCreated} />
        </div>
      )}

      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
