import { useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import { Button, Icon, Logo } from "../ui/index.js";
import { avisar, camposDoErro } from "../lib/log.js";
import { ThemeToggle } from "../layout/ThemeToggle.jsx";
import styles from "./LoginPage.module.css";

// Tela de senha única do Fields. Em tokens (claro e escuro seguem o tema): era a última tela
// presa no #1a1a1a fixo. O tema já pode ser trocado aqui — o login também é tela.
function mensagemDeErro(e) {
  if (e instanceof ApiError) {
    if (e.status === 401) return "Senha incorreta.";
    if (e.status === 429) return "Muitas tentativas. Aguarde alguns minutos.";
    return "Não foi possível entrar. Tente de novo.";
  }
  return "Sem conexão com o servidor.";
}

const ID_CAMPO = "fields-senha";
const ID_ERRO = "fields-senha-erro";

export default function LoginPage({ onEntrou }) {
  const [senha, setSenha]       = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro]         = useState("");
  const campoRef = useRef(null);

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
      // Só status e código: a senha nunca chega perto do log.
      avisar("LOGIN_FALHOU", "login não aceito", camposDoErro(e));
      setErro(mensagemDeErro(e));
      setEnviando(false);
      // Quem clicou em Entrar fica com o foco no botão; a correção é no campo.
      campoRef.current?.select();
      campoRef.current?.focus();
    }
  }

  return (
    <div className={styles.tela}>
      <div className={styles.topo}>
        <ThemeToggle />
      </div>
      <main className={styles.centro}>
        <form className={styles.cartao} onSubmit={entrar} aria-labelledby="fields-login-titulo" noValidate>
          <div className={styles.marca}>
            <Logo size={28} className={styles.logo} />
            <h1 id="fields-login-titulo" className={styles.titulo}>Fields'</h1>
          </div>
          <p className={styles.sub}>Entre com a sua senha.</p>

          <div className={styles.grupo}>
            <label htmlFor={ID_CAMPO} className={styles.rotulo}>Senha</label>
            <input
              ref={campoRef}
              id={ID_CAMPO}
              name="senha"
              type="password"
              autoComplete="current-password"
              autoFocus
              className={styles.campo}
              value={senha}
              onChange={e => setSenha(e.target.value)}
              aria-invalid={erro ? true : undefined}
              aria-describedby={erro ? ID_ERRO : undefined}
            />
            {erro && (
              <p id={ID_ERRO} role="alert" className={styles.erro}>
                <Icon name="alert" size={14} />
                <span>{erro}</span>
              </p>
            )}
          </div>

          <Button type="submit" variant="primary" loading={enviando} disabled={!senha} className={styles.entrar}>
            {enviando ? "Entrando…" : "Entrar"}
          </Button>
        </form>
      </main>
    </div>
  );
}
