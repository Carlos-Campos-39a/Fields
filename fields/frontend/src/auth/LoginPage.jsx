import { useState } from "react";
import { api, ApiError } from "../api.js";

// Tela de senha única do Fields. Estilo provisório, no escuro atual — o redesign (R2) troca.
function mensagemDeErro(e) {
  if (e instanceof ApiError) {
    if (e.status === 401) return "Senha incorreta.";
    if (e.status === 429) return "Muitas tentativas. Aguarde alguns minutos.";
    return "Não foi possível entrar. Tente de novo.";
  }
  return "Sem conexão com o servidor.";
}

export default function LoginPage({ onEntrou }) {
  const [senha, setSenha]       = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro]         = useState("");

  async function entrar(ev) {
    ev.preventDefault();
    if (!senha || enviando) return;
    setEnviando(true);
    setErro("");
    try {
      await api.login(senha);
      setSenha("");
      onEntrou();
    } catch (e) {
      setErro(mensagemDeErro(e));
      setEnviando(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#1a1a1a", padding: 16,
    }}>
      <form onSubmit={entrar} style={{
        width: "100%", maxWidth: 320, display: "flex", flexDirection: "column", gap: 12,
      }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 600, color: "white", marginBottom: 8 }}>
          Fields'
        </span>
        <label htmlFor="fields-senha" style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.5)" }}>
          Senha
        </label>
        <input
          id="fields-senha" type="password" autoComplete="current-password" autoFocus
          value={senha} onChange={e => setSenha(e.target.value)}
          style={{
            background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "white", outline: "none",
          }}
        />
        {erro && (
          <div role="alert" style={{ fontSize: 13, color: "#f0956a" }}>{erro}</div>
        )}
        <button type="submit" disabled={!senha || enviando} style={{
          background: "#E8602C", border: "none", borderRadius: 10, padding: "10px 12px",
          fontSize: 14, fontWeight: 600, color: "white",
          cursor: !senha || enviando ? "default" : "pointer",
          opacity: !senha || enviando ? 0.6 : 1,
        }}>
          {enviando ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
