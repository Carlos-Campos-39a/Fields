import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, scryptSync } from "node:crypto";
import {
  DURACAO_SESSAO_S, emitirCookieSessao, gerarHashSenha, lerCookie, segredosIguais,
  verificarCookieSessao, verificarSenha,
} from "../src/auth/sessao.js";
import { criarLimitador } from "../src/auth/limitador.js";
import { formatoHashValido } from "../src/config.js";

const SEGREDO = "segredo-de-sessao-de-teste-com-mais-de-32";

// ─── Senha ───
test("hash de senha: a certa confere, a errada não", async () => {
  const hash = await gerarHashSenha("correta horse battery");
  assert.ok(formatoHashValido(hash), "o hash gerado tem o formato que a config exige");
  assert.match(hash, /^scrypt\$16384\$8\$5\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verificarSenha("correta horse battery", hash), true);
  assert.equal(await verificarSenha("correta horse batterY", hash), false);
  assert.equal(await verificarSenha("", hash), false);
  assert.equal(await verificarSenha(undefined, hash), false);
  assert.equal(await verificarSenha(12345, hash), false);
});

test("hash de senha malformado nunca lança: só não confere", async () => {
  const sal = Buffer.alloc(16, 1).toString("base64");
  const h64 = Buffer.alloc(64, 2).toString("base64");
  for (const ruim of [
    undefined, "", "scrypt$abc", "bcrypt$a$b", "scrypt$AAAA$AAAA", "scrypt$$$",
    `scrypt$${sal}$${h64}`,                  // formato antigo, sem parâmetros
    `scrypt$1024$8$1$${sal}$${h64}`,         // N abaixo do piso
    `scrypt$16777216$8$1$${sal}$${h64}`,     // N absurdo: travaria o processo a cada login
    `scrypt$20000$8$1$${sal}$${h64}`,        // N que não é potência de 2
    `scrypt$16384$32$1$${sal}$${h64}`,       // r fora do aceito
    `scrypt$16384$8$0$${sal}$${h64}`,        // p zero
  ]) {
    assert.equal(await verificarSenha("qualquer", ruim), false, String(ruim));
    assert.equal(formatoHashValido(ruim), false, String(ruim));
  }
});

test("os parâmetros vêm do próprio hash: um hash com outro custo continua conferindo", async () => {
  const sal = Buffer.from("sal-fixo-de-teste");
  const h = scryptSync("senha-antiga", sal, 64, { N: 16384, r: 8, p: 1 });
  const hash = `scrypt$16384$8$1$${sal.toString("base64")}$${h.toString("base64")}`;
  assert.ok(formatoHashValido(hash));
  assert.equal(await verificarSenha("senha-antiga", hash), true);
  assert.equal(await verificarSenha("senha-errada", hash), false);
});

test("hash de senha usa sal novo a cada geração", async () => {
  assert.notEqual(await gerarHashSenha("mesma"), await gerarHashSenha("mesma"));
});

// ─── Cookie ───
test("cookie válido é aceito e expira em 30 dias", () => {
  const agora = Date.UTC(2026, 9, 3, 12);
  const valor = emitirCookieSessao(SEGREDO, agora);
  const r = verificarCookieSessao(valor, SEGREDO, agora + 1000);
  assert.equal(r.ok, true);
  assert.equal(r.exp, Math.floor(agora / 1000) + DURACAO_SESSAO_S);
});

test("cookie com payload adulterado é recusado por ASSINATURA", () => {
  const [payload, assinatura] = emitirCookieSessao(SEGREDO).split(".");
  const forjado = Buffer.from(JSON.stringify({ exp: 9999999999, n: "x" })).toString("base64url");
  assert.notEqual(forjado, payload);
  assert.deepEqual(verificarCookieSessao(`${forjado}.${assinatura}`, SEGREDO), { ok: false, motivo: "ASSINATURA" });
});

test("cookie com assinatura adulterada é recusado", () => {
  const [payload, assinatura] = emitirCookieSessao(SEGREDO).split(".");
  const trocada = (assinatura[0] === "A" ? "B" : "A") + assinatura.slice(1);
  assert.deepEqual(verificarCookieSessao(`${payload}.${trocada}`, SEGREDO), { ok: false, motivo: "ASSINATURA" });
});

test("cookie assinado com outro segredo é recusado", () => {
  const valor = emitirCookieSessao("outro-segredo-qualquer-com-mais-de-32-caracteres");
  assert.equal(verificarCookieSessao(valor, SEGREDO).motivo, "ASSINATURA");
});

test("cookie expirado é recusado", () => {
  const agora = Date.UTC(2026, 9, 3, 12);
  const valor = emitirCookieSessao(SEGREDO, agora);
  const depois = agora + (DURACAO_SESSAO_S + 1) * 1000;
  assert.deepEqual(verificarCookieSessao(valor, SEGREDO, depois), { ok: false, motivo: "EXPIRADO" });
});

test("assinatura de tamanho diferente não lança (timingSafeEqual exigiria tamanhos iguais)", () => {
  const [payload] = emitirCookieSessao(SEGREDO).split(".");
  for (const assinatura of ["curta", "x".repeat(200), "AAAA"]) {
    assert.doesNotThrow(() => verificarCookieSessao(`${payload}.${assinatura}`, SEGREDO));
    assert.equal(verificarCookieSessao(`${payload}.${assinatura}`, SEGREDO).motivo, "ASSINATURA");
  }
});

test("cookie sem formato e payload assinado mas não-JSON são recusados com o motivo certo", () => {
  assert.equal(verificarCookieSessao("", SEGREDO).motivo, "AUSENTE");
  assert.equal(verificarCookieSessao("semponto", SEGREDO).motivo, "FORMATO");
  assert.equal(verificarCookieSessao("a.b.c", SEGREDO).motivo, "FORMATO");
  const lixo = Buffer.from("isto não é json").toString("base64url");
  const sig = createHmac("sha256", SEGREDO).update(lixo).digest("base64url");
  assert.equal(verificarCookieSessao(`${lixo}.${sig}`, SEGREDO).motivo, "PAYLOAD");
  const semExp = Buffer.from(JSON.stringify({ n: "x" })).toString("base64url");
  const sig2 = createHmac("sha256", SEGREDO).update(semExp).digest("base64url");
  assert.equal(verificarCookieSessao(`${semExp}.${sig2}`, SEGREDO).motivo, "PAYLOAD");
});

test("lerCookie acha o cookie pelo nome entre vários", () => {
  assert.equal(lerCookie("a=1; fields_s=abc.def; b=2", "fields_s"), "abc.def");
  assert.equal(lerCookie("fields_sx=1", "fields_s"), null);
  assert.equal(lerCookie(undefined, "fields_s"), null);
});

// ─── Bearer ───
test("comparação de Bearer: igual, diferente e de tamanho diferente (sem lançar)", () => {
  const token = "t".repeat(40);
  assert.equal(segredosIguais(token, token), true);
  assert.equal(segredosIguais("u".repeat(40), token), false);
  assert.doesNotThrow(() => segredosIguais("curto", token));
  assert.equal(segredosIguais("curto", token), false);
  assert.equal(segredosIguais(token + "x", token), false);
  assert.equal(segredosIguais(undefined, token), false);
  assert.equal(segredosIguais(token, ""), false, "token esperado vazio nunca casa");
});

// ─── Limitador ───
test("limitador: 5 falhas por IP bloqueiam por 15 min, e a janela desliza", () => {
  let t = 0;
  const lim = criarLimitador({ agora: () => t });
  for (let i = 0; i < 5; i++) { assert.equal(lim.bloqueio("1.1.1.1"), null); lim.reservar("1.1.1.1"); t += 1000; }
  assert.equal(lim.bloqueio("1.1.1.1").motivo, "LIMITE_IP");
  assert.equal(lim.bloqueio("2.2.2.2"), null, "outro IP segue livre");
  t = 15 * 60 * 1000 + 1;
  assert.equal(lim.bloqueio("1.1.1.1"), null, "a primeira falha saiu da janela");
});

test("limitador: teto global de 30 falhas/h vale para qualquer IP", () => {
  let t = 0;
  const lim = criarLimitador({ agora: () => t });
  for (let i = 0; i < 30; i++) { lim.reservar(`10.0.0.${i}`); t += 10; }
  const b = lim.bloqueio("192.168.0.1");
  assert.equal(b.motivo, "LIMITE_GLOBAL");
  assert.ok(b.retryAfterS > 0);
});

test("limitador: a tentativa em voo já conta — reservas no mesmo instante, sem confirmar, bloqueiam", () => {
  const lim = criarLimitador({ agora: () => 0 });
  let passaram = 0;
  for (let i = 0; i < 50; i++) {
    if (lim.bloqueio("1.1.1.1")) continue;
    lim.reservar("1.1.1.1");
    passaram++;
  }
  assert.equal(passaram, 5, "por IP: só 5 entram, mesmo sem nenhuma ter terminado");
  let globais = 0;
  for (let i = 0; i < 50; i++) {
    if (lim.bloqueio(`10.0.0.${i}`)) continue;
    lim.reservar(`10.0.0.${i}`);
    globais++;
  }
  assert.equal(globais, 25, "global: as 5 do primeiro IP mais 25 de IPs novos fecham as 30");
});

test("limitador: login certo zera as tentativas daquele IP e devolve a própria vaga global", () => {
  let t = 0;
  const lim = criarLimitador({ agora: () => t });
  for (let i = 0; i < 4; i++) { lim.reservar("1.1.1.1"); t += 10; }
  const marca = lim.reservar("1.1.1.1");
  assert.equal(lim.bloqueio("1.1.1.1").motivo, "LIMITE_IP", "a 5ª em voo já fecha o IP");
  lim.confirmarSucesso("1.1.1.1", marca);
  lim.reservar("1.1.1.1");
  assert.equal(lim.bloqueio("1.1.1.1"), null);

  // 29 falhas de outros IPs + 1 acerto: o acerto não ocupa o teto global
  const lim2 = criarLimitador({ agora: () => t });
  for (let i = 0; i < 29; i++) lim2.reservar(`10.0.0.${i}`);
  lim2.confirmarSucesso("9.9.9.9", lim2.reservar("9.9.9.9"));
  assert.equal(lim2.bloqueio("8.8.8.8"), null, "acerto devolveu a vaga: 29 < 30");
  lim2.reservar("8.8.8.8");
  assert.equal(lim2.bloqueio("7.7.7.7").motivo, "LIMITE_GLOBAL");
});
