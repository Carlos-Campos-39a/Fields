import { useEffect, useState } from "react";
import { api, ApiError, EVENTO_401 } from "../api.js";
import { Spinner } from "../ui/index.js";
import { avisar, camposDoErro } from "../lib/log.js";
import LoginPage from "./LoginPage.jsx";
import styles from "./Gate.module.css";

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
        if (e instanceof ApiError && e.status === 404) {
          avisar("AUTH_ROTA_AUSENTE", "backend sem /api/auth/me; entrando sem tela de login", camposDoErro(e));
          setEstado("autenticado");
          return;
        }
        // 401 é o caminho normal (sem sessão). Rede fora ou 5xx também caem no login — mas não
        // em silêncio: quem vê o login sem ter saído precisa achar o porquê no console.
        if (!(e instanceof ApiError) || e.status !== 401) {
          avisar("AUTH_ME_FALHOU", "não deu para conferir a sessão; mostrando o login", camposDoErro(e));
        }
        setEstado("anonimo");
      });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    const voltarAoLogin = () => setEstado("anonimo");
    window.addEventListener(EVENTO_401, voltarAoLogin);
    return () => window.removeEventListener(EVENTO_401, voltarAoLogin);
  }, []);

  // Era null: com o backend frio (a primeira ida pode levar segundos), a tela ficava em branco
  // sem dizer nada. O indicador só aparece depois de 400 ms (CSS), para não piscar no caso rápido.
  if (estado === "carregando") {
    return (
      <div className={styles.espera}>
        <Spinner size={20} label="Conferindo a sessão" />
      </div>
    );
  }
  if (estado === "anonimo") return <LoginPage onEntrou={() => setEstado("autenticado")} />;
  return children;
}
