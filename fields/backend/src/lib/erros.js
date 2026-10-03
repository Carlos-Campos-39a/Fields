// Erros e resultados de domínio.
//
// ErroDominio: recusa de regra de negócio que deve virar resposta HTTP própria. O tratador final
// devolve {error: mensagem, codigo} com o status dela — nunca 500.
//
// sucesso/recusa: o formato de retorno dos serviços que podem dizer "não". Em vez de null mudo,
// o serviço devolve o MOTIVO, e quem chama decide o que fazer com ele (a rota traduz para o
// corpo HTTP de hoje; o log HTTP_REQ leva o motivo).

export class ErroDominio extends Error {
  constructor(codigo, status, mensagem) {
    super(mensagem);
    this.name = "ErroDominio";
    this.codigo = codigo;
    this.status = status;
    this.mensagem = mensagem;
  }
}

export const sucesso = (valor) => ({ ok: true, valor });
export const recusa = (motivo) => ({ ok: false, motivo });
