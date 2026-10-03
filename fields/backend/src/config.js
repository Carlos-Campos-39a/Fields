// Configuração lida do ambiente e validada no boot. Falha cedo, com a lista dos NOMES que faltam —
// nunca imprime valor.

import { lerHashSenha } from "./auth/sessao.js";

export class ErroConfig extends Error {
  constructor(problemas) {
    const partes = [];
    if (problemas.faltando.length) partes.push(`faltando: ${problemas.faltando.join(", ")}`);
    if (problemas.curtas.length) partes.push(`curtas demais (mínimo 32 caracteres): ${problemas.curtas.join(", ")}`);
    if (problemas.invalidas.length) partes.push(`formato inválido: ${problemas.invalidas.join(", ")}`);
    super(`Configuração inválida — ${partes.join("; ")}. Veja fields/backend/.env.example.`);
    this.name = "ErroConfig";
    this.problemas = problemas;
  }
}

const OBRIGATORIAS = ["DATABASE_URL", "FIELDS_SENHA_HASH", "FIELDS_SEGREDO_SESSAO", "FIELDS_API_TOKEN"];
const MINIMO_32 = ["FIELDS_SEGREDO_SESSAO", "FIELDS_API_TOKEN"];

/** "scrypt$<N>$<r>$<p>$<sal base64>$<hash base64>" (scripts/hash-senha.mjs). */
export function formatoHashValido(valor) {
  return lerHashSenha(valor) !== null; // a MESMA leitura que o login usa
}

export function carregarConfig(env = process.env) {
  const problemas = { faltando: [], curtas: [], invalidas: [] };
  for (const nome of OBRIGATORIAS) if (!env[nome]) problemas.faltando.push(nome);
  for (const nome of MINIMO_32) if (env[nome] && env[nome].length < 32) problemas.curtas.push(nome);
  if (env.FIELDS_SENHA_HASH && !formatoHashValido(env.FIELDS_SENHA_HASH)) {
    problemas.invalidas.push("FIELDS_SENHA_HASH (gere com: node scripts/hash-senha.mjs)");
  }
  if (problemas.faltando.length || problemas.curtas.length || problemas.invalidas.length) {
    throw new ErroConfig(problemas);
  }

  return Object.freeze({
    porta: Number(env.PORT) || 3001,
    databaseUrl: env.DATABASE_URL,
    // "false" desliga o SSL (Postgres local). O padrão é o de sempre: SSL sem verificar o
    // certificado, que é o que o Postgres do Railway aceita.
    databaseSsl: env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    senhaHash: env.FIELDS_SENHA_HASH,
    segredoSessao: env.FIELDS_SEGREDO_SESSAO,
    apiToken: env.FIELDS_API_TOKEN,
  });
}
