import { useEffect, useState } from "react";
import { api, ApiError, EVENTO_401 } from "../api.js";
import LoginPage from "./LoginPage.jsx";

// Porta de entrada: confere a sessão (GET /api/auth/me) antes de montar o app.
// Qualquer 401 posterior (cookie expirado) dispara EVENTO_401 em api.js e volta para cá.
export default function Gate({ children }) {
  const [estado, setEstado] = useState("carregando"); // carregando | anonimo | autenticado

  useEffect(() => {
    let vivo = true;
    api.me()
      .then(() => { if (vivo) setEstado("autenticado"); })
      .catch(e => {
        if (!vivo) return;
        // 404: backend ainda sem a rota de auth (deploy do front antes do back). Sem auth no
        // servidor não há o que proteger aqui; se ele tiver auth, o primeiro 401 traz o login.
        if (e instanceof ApiError && e.status === 404) { setEstado("autenticado"); return; }
        if (!(e instanceof ApiError) || e.status !== 401) console.warn("auth/me falhou", e);
        setEstado("anonimo");
      });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    const voltarAoLogin = () => setEstado("anonimo");
    window.addEventListener(EVENTO_401, voltarAoLogin);
    return () => window.removeEventListener(EVENTO_401, voltarAoLogin);
  }, []);

  if (estado === "carregando") return null;
  if (estado === "anonimo") return <LoginPage onEntrou={() => setEstado("autenticado")} />;
  return children;
}
