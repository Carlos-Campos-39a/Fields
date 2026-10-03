#!/usr/bin/env node
// Gera o valor de FIELDS_SENHA_HASH ("scrypt$<N>$<r>$<p>$<sal>$<hash>") a partir de uma senha.
//
//   node scripts/hash-senha.mjs                      # pergunta a senha (sem eco)
//   printf '%s' 'minha senha' | node scripts/hash-senha.mjs
//   node scripts/hash-senha.mjs 'minha senha'        # cuidado: fica no histórico do shell
//
// O hash tem "$": no shell, use aspas SIMPLES ao exportar; no Railway e no .env, cole como está.

import { gerarHashSenha } from "../src/auth/sessao.js";

function lerStdin() {
  return new Promise((resolve, reject) => {
    let dados = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { dados += c; });
    process.stdin.on("end", () => resolve(dados.replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

function perguntarSemEco(pergunta) {
  return new Promise((resolve) => {
    process.stderr.write(pergunta);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let senha = "";
    const aoTeclar = (tecla) => {
      for (const c of tecla) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", aoTeclar);
          process.stderr.write("\n");
          return resolve(senha);
        }
        if (c === "\u0003") { process.stderr.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") senha = senha.slice(0, -1);
        else senha += c;
      }
    };
    stdin.on("data", aoTeclar);
    stdin.resume();
  });
}

let senha = process.argv[2];
if (senha === undefined) {
  senha = process.stdin.isTTY ? await perguntarSemEco("Senha: ") : await lerStdin();
}
if (!senha) {
  console.error("Senha vazia — nada gerado.");
  process.exit(1);
}
if (senha.length < 12) console.error("Aviso: senha com menos de 12 caracteres.");

console.log(await gerarHashSenha(senha));
