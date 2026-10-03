// Log estruturado: UMA linha JSON por evento — {ts, nivel, evento, ...campos}.
// `evento` é um código estável em UPPER_SNAKE (HTTP_REQ, AUTH_NEGADO…): é por ele que se agrupa,
// então renomear um evento existente quebra qualquer consulta construída em cima dele.
// Valor de pessoa vai em campo nomeado, nunca interpolado. Segredo, cookie, Authorization e corpo
// de request não entram — e, por garantia, chave com cara de segredo sai redigida.

const EVENTO_VALIDO = /^[A-Z][A-Z0-9_]*$/;
// Casa "senha", "api_token", "authorization"… mas não contadores como "input_tokens".
const CHAVE_SECRETA = /senha|segredo|cookie|authorization|password|secret|bearer|^token$|_token$/i;
const RESERVADAS = new Set(["ts", "nivel", "evento"]);

const saidaPadrao = (nivel, linha) =>
  (nivel === "info" ? process.stdout : process.stderr).write(linha + "\n");
let saida = saidaPadrao;

function emitir(nivel, evento, campos = {}) {
  const ts = new Date().toISOString();
  const registro = EVENTO_VALIDO.test(evento)
    ? { ts, nivel, evento }
    : { ts, nivel, evento: "LOG_EVENTO_INVALIDO", evento_original: String(evento) };
  for (const [chave, valor] of Object.entries(campos ?? {})) {
    if (RESERVADAS.has(chave) || valor === undefined) continue;
    registro[chave] = CHAVE_SECRETA.test(chave) ? "[redigido]" : valor;
  }
  let linha;
  try { linha = JSON.stringify(registro); }
  catch { linha = JSON.stringify({ ts, nivel, evento: registro.evento, log_falhou: "NAO_SERIALIZAVEL" }); }
  saida(nivel, linha);
}

export const log = {
  info: (evento, campos) => emitir("info", evento, campos),
  warn: (evento, campos) => emitir("warn", evento, campos),
  erro: (evento, campos) => emitir("erro", evento, campos),
};

// Só para teste: troca o destino das linhas (null restaura stdout/stderr).
export function definirSaida(fn) { saida = fn ?? saidaPadrao; }
