// Limite de tentativas de login, em memória (um processo só; reiniciar zera — aceitável para um
// usuário). Duas réguas:
//   - por IP: 5 tentativas em 15 min;
//   - global: 30 tentativas em 1 h — o teto que segura o ataque distribuído, já que req.ip vem do
//     X-Forwarded-For (trust proxy) e um atacante pode variar o IP. O preço: um ataque assim tranca
//     o login por até 1 h; o Bearer (MCP) continua entrando.
// Janela deslizante: guarda o instante de cada tentativa e descarta o que saiu da janela.
//
// A tentativa é RESERVADA antes do scrypt, não contada depois dele. Contar a falha só quando o
// `await verificarSenha` volta deixa uma rajada concorrente passar inteira pela checagem antes de
// a primeira falha entrar na conta: 200 POST simultâneos viravam 200 senhas testadas contra um teto
// de 30, e milhares de jobs scrypt enfileirados no threadpool do libuv — o mesmo do dns.lookup, de
// que dependem as conexões novas do pg. Com a reserva, `bloqueio` + `reservar` rodam no mesmo tique
// (sem await no meio), a tentativa em voo já ocupa a vaga, e o scrypt em voo nunca passa do teto.
// Quem acerta devolve a vaga com `confirmarSucesso`; quem erra não faz nada — já está contado.

export function criarLimitador({
  maxPorIp = 5, janelaIpMs = 15 * 60 * 1000,
  maxGlobal = 30, janelaGlobalMs = 60 * 60 * 1000,
  agora = () => Date.now(),
} = {}) {
  const porIp = new Map();
  let global = [];

  const recentes = (lista, janela, t) => lista.filter((ts) => t - ts < janela);

  function varrer(t) {
    for (const [ip, lista] of porIp) {
      const vivas = recentes(lista, janelaIpMs, t);
      if (vivas.length) porIp.set(ip, vivas); else porIp.delete(ip);
    }
  }

  return {
    /** null se pode tentar; senão {motivo, retryAfterS}. Conta as tentativas ainda em voo. */
    bloqueio(ip) {
      const t = agora();
      global = recentes(global, janelaGlobalMs, t);
      if (global.length >= maxGlobal) {
        return { motivo: "LIMITE_GLOBAL", retryAfterS: Math.ceil((global[0] + janelaGlobalMs - t) / 1000) };
      }
      const lista = recentes(porIp.get(ip) ?? [], janelaIpMs, t);
      if (lista.length >= maxPorIp) {
        return { motivo: "LIMITE_IP", retryAfterS: Math.ceil((lista[0] + janelaIpMs - t) / 1000) };
      }
      return null;
    },
    /**
     * Ocupa a vaga ANTES de verificar a senha — síncrono, chamado logo depois de `bloqueio` e sem
     * await entre os dois. Devolve a marca que `confirmarSucesso` usa para devolver a vaga global.
     * Se a senha estiver errada, não há o que chamar: a tentativa já conta como falha.
     */
    reservar(ip) {
      const t = agora();
      global.push(t);
      porIp.set(ip, [...recentes(porIp.get(ip) ?? [], janelaIpMs, t), t]);
      if (porIp.size > 1000) varrer(t);
      return t;
    },
    /**
     * Login certo: devolve a vaga global da própria tentativa (acerto não consome o teto) e zera
     * as tentativas daquele IP. As globais dos outros continuam contadas.
     */
    confirmarSucesso(ip, marca) {
      const i = global.indexOf(marca); // instantes iguais são intercambiáveis: tirar um basta
      if (i !== -1) global.splice(i, 1);
      porIp.delete(ip);
    },
  };
}
