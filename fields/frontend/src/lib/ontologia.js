import { createContext, createElement, useContext, useEffect, useMemo, useState } from "react";
import { api, codigoDe } from "../api.js";
import { avisar, avisarUmaVez, camposDoErro } from "./log.js";

// useOntologia(): as listas e os rótulos da tela vêm de GET /api/ontologia — a mesma fonte do
// prompt do agente e do MCP (backend/src/agente/ontologia.js, que lê dominio/enums.js). No
// monólito eram cópias à mão (TYPE, FILTERS, KANBAN_COLS, PROJ_STATUS_LIST, "Concluído" solto), e
// o HolderToggle nem sabia que "" é um valor real.
//
// Três origens, nessa ordem de preferência, e a tela nunca fica sem lista:
//   servidor → o GET desta carga (uma vez por carga da página; guardado em memória e no
//              localStorage);
//   cache    → o último GET bom, do localStorage, enquanto o GET novo não volta (ou se falhar);
//   reserva  → ENUMS_RESERVA, sem rótulo nenhum: a tela mostra o valor cru com a 1ª maiúscula.
//              Feio de propósito, e logado (ONTOLOGIA_RESERVA): é o sinal de que o GET falhou.

export const CHAVE_CACHE = "fields.ontologia.v1";

/**
 * Cópia de backend/src/dominio/enums.js, usada SÓ na origem "reserva". Não é fonte: ontologia.test.js
 * compara as duas listas e falha se alguém mudar uma sem a outra.
 */
export const ENUMS_RESERVA = Object.freeze({
  tipo_entrada: Object.freeze(["note", "event", "reminder", "lang_fr", "lang_jp"]),
  status: Object.freeze(["Em andamento", "Pendente", "Marcado", "Em definição", "Não iniciado", "Concluído"]),
  kanban: Object.freeze(["A fazer", "Fazendo", "Espera", "Feito"]),
  holder: Object.freeze(["Nós", "Eles", ""]),
  alvo_comentario: Object.freeze(["ENTRADA", "TAREFA", "REUNIAO"]),
  status_memoria: Object.freeze(["ATIVA", "ARQUIVADA"]),
});

// Os valores com SEMÂNTICA no código (dominio/enums.js: STATUS_CONCLUIDO, COLUNA_FEITO). A
// ontologia diz quais valores existem, não qual deles é "terminado" — esse saber mora aqui, uma vez,
// em vez de um literal "Concluído" em cada tela.
export const STATUS_CONCLUIDO = "Concluído";
export const COLUNA_FEITO = "Feito";

/** Os tipos de entrada cuja data É um compromisso (dominio/enums.js: TIPOS_AGENDADOS). */
export const TIPOS_AGENDADOS = Object.freeze(["event", "reminder"]);

export const ehConcluido = (status) => status === STATUS_CONCLUIDO;
export const ehColunaFeita = (coluna) => coluna === COLUNA_FEITO;

/** "nota" → "Nota"; "é" → "É". Só a primeira letra; o resto como veio. */
export function capitalizar(texto) {
  const s = String(texto ?? "");
  if (!s) return s;
  return s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1);
}

/**
 * Corpo de GET /api/ontologia → {enums, rotulos}, ou null quando a forma não serve (a tela então
 * fica no cache ou na reserva, em vez de quebrar num .map de undefined).
 */
export function normalizarOntologia(corpo) {
  if (!corpo || typeof corpo !== "object") return null;
  const { enums, rotulos } = corpo;
  if (!enums || typeof enums !== "object" || Array.isArray(enums)) return null;
  if (!rotulos || typeof rotulos !== "object" || Array.isArray(rotulos)) return null;
  for (const valores of Object.values(enums)) {
    if (!Array.isArray(valores) || !valores.every((v) => typeof v === "string")) return null;
  }
  return { enums, rotulos };
}

/**
 * rotulo(enum, valor, {capitalizar = true}) para um mapa de rótulos.
 * Sem rótulo, o próprio valor (o "" de holder TEM rótulo — por isso o hasOwnProperty, e não ||;
 * Object.hasOwn ficaria de fora do Safari 14, que o alvo do Vite ainda cobre). Valor
 * ausente → "". Na reserva (mapa vazio) todo valor sai cru, sem log: a reserva já logou.
 */
export function criarRotulador(rotulos) {
  return function rotulo(enumNome, valor, { capitalizar: cap = true } = {}) {
    if (valor === null || valor === undefined) return "";
    const mapa = rotulos?.[enumNome];
    let texto;
    if (mapa && Object.prototype.hasOwnProperty.call(mapa, valor)) {
      texto = mapa[valor];
    } else {
      texto = String(valor);
      if (mapa) {
        avisarUmaVez("ONTOLOGIA_SEM_ROTULO", "valor sem rótulo na ontologia; exibindo o valor cru", {
          enum: enumNome,
          valor: texto,
        });
      }
    }
    return cap ? capitalizar(texto) : texto;
  };
}

// ─── Cache ───────────────────────────────────────────────────────────

function storagePadrao() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // acesso ao storage bloqueado (aba privada, política do navegador)
  }
}

/** O último GET bom guardado, ou null (sem storage, vazio, JSON quebrado ou forma inválida). */
export function lerCache(storage = storagePadrao()) {
  try {
    const bruto = storage?.getItem(CHAVE_CACHE);
    if (!bruto) return null;
    return normalizarOntologia(JSON.parse(bruto));
  } catch {
    return null;
  }
}

export function gravarCache(dados, storage = storagePadrao()) {
  try {
    storage?.setItem(CHAVE_CACHE, JSON.stringify(dados));
    return true;
  } catch (erro) {
    avisar("ONTOLOGIA_CACHE_INDISPONIVEL", "não deu para guardar a ontologia; vale só nesta aba", {
      motivo: erro?.name ?? typeof erro,
    });
    return false;
  }
}

// Memória do módulo: o GET acontece uma vez por carga (o StrictMode monta duas vezes, a tela de
// login remonta o app — nenhum dos dois repete a ida ao servidor).
let emMemoria = null;
let pedido = null;

/** O estado de partida: memória → cache → reserva. Pura em relação ao storage dado. */
export function estadoInicial(storage = storagePadrao()) {
  if (emMemoria) return { ...emMemoria, origem: "servidor", carregando: false, erro: null };
  const cache = lerCache(storage);
  if (cache) return { ...cache, origem: "cache", carregando: true, erro: null };
  return { enums: ENUMS_RESERVA, rotulos: {}, origem: "reserva", carregando: true, erro: null };
}

/** GET /api/ontologia uma vez; quem chama depois recebe a mesma promessa. Falha → a próxima tenta de novo. */
export function carregarOntologia(buscar = api.getOntologia) {
  if (emMemoria) return Promise.resolve(emMemoria);
  if (!pedido) {
    pedido = Promise.resolve()
      .then(buscar)
      .then((corpo) => {
        const dados = normalizarOntologia(corpo);
        if (!dados) {
          const erro = new Error("ONTOLOGIA_INVALIDA");
          erro.codigo = "ONTOLOGIA_INVALIDA";
          throw erro;
        }
        emMemoria = dados;
        gravarCache(dados);
        return dados;
      })
      .finally(() => {
        pedido = null;
      });
  }
  return pedido;
}

/** Só para teste: esquece a memória do módulo. */
export function _zerarMemoria() {
  emMemoria = null;
  pedido = null;
}

// ─── React ───────────────────────────────────────────────────────────

function valorDoEstado(estado) {
  return {
    enums: estado.enums,
    rotulo: criarRotulador(estado.rotulos),
    origem: estado.origem,
    carregando: estado.carregando,
    erro: estado.erro,
  };
}

const OntologiaContext = createContext(null);

/** Envolve o app uma vez (dentro do Gate: a rota exige sessão). */
export function OntologiaProvider({ children }) {
  const [estado, setEstado] = useState(() => estadoInicial());

  useEffect(() => {
    if (estado.origem === "servidor") return undefined;
    let vivo = true;
    carregarOntologia()
      .then((dados) => {
        if (vivo) setEstado({ ...dados, origem: "servidor", carregando: false, erro: null });
      })
      .catch((e) => {
        if (!vivo) return;
        const codigo = e?.codigo === "ONTOLOGIA_INVALIDA" ? e.codigo : codigoDe(e);
        // `estado` aqui é o da montagem — e é ele que segue na tela, porque só este efeito o troca.
        const naReserva = estado.origem === "reserva";
        avisar(
          naReserva ? "ONTOLOGIA_RESERVA" : "ONTOLOGIA_FALHOU",
          naReserva
            ? "GET /api/ontologia falhou e não há cache; rótulos = valores crus"
            : "GET /api/ontologia falhou; seguindo com o cache",
          { ...camposDoErro(e), codigo, usando: estado.origem },
        );
        setEstado((s) => ({ ...s, carregando: false, erro: codigo }));
      });
    return () => {
      vivo = false;
    };
    // Uma vez por montagem: a memória do módulo é quem impede a segunda ida ao servidor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const valor = useMemo(() => valorDoEstado(estado), [estado]);
  return createElement(OntologiaContext.Provider, { value: valor }, children);
}

let foraDoProvider = null;

/** { enums, rotulo(enum, valor, {capitalizar}), origem, carregando, erro }. Nunca quebra a tela. */
export function useOntologia() {
  const valor = useContext(OntologiaContext);
  if (valor) return valor;
  avisarUmaVez("ONTOLOGIA_SEM_PROVIDER", "useOntologia fora do OntologiaProvider; usando cache/reserva", {});
  foraDoProvider ??= valorDoEstado(estadoInicial());
  return foraDoProvider;
}

/** O próximo holder da lista, em ciclo — o "" (sem responsável) é um estado como os outros. */
export function proximoHolder(atual, holders) {
  const lista = Array.isArray(holders) && holders.length ? holders : ENUMS_RESERVA.holder;
  const i = lista.indexOf(atual ?? "");
  return lista[(i + 1) % lista.length];
}
