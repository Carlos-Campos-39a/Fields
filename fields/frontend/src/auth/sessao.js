import { api, ApiError, EVENTO_401 } from "../api.js";

// Encerra a sessão e volta ao login SÓ quando o servidor confirmou. O cookie é httpOnly: o
// front não consegue apagá-lo, quem apaga é o clearCookie da resposta do logout. Se a chamada
// falha por rede ou 5xx (backend fora, 502 do rewrite), o cookie segue válido — mostrar o login
// aí seria mentir: recarregar a página faz o Gate chamar /auth/me, recebe 200 e entra de novo.
// Então a falha fica na tela e o usuário continua dentro, sabendo que não saiu.
// 401 é a exceção: a sessão já estava morta, e req() em api.js já disparou EVENTO_401.
// Fica fora do Gate.jsx para o arquivo do componente só exportar componente (Fast Refresh).
export async function sair() {
  try {
    await api.logout();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return; // req() já levou ao login
    console.warn("logout falhou", e);
    alert("Não foi possível sair. Tente de novo.");
    return;
  }
  window.dispatchEvent(new Event(EVENTO_401));
}
