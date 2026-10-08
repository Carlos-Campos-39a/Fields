// Tetos do domínio que mais de uma camada precisa conhecer: o CHECK do banco, o serviço que recusa,
// o schema que o modelo lê e o texto da ontologia. Um número só, aqui — dois "20" em dois arquivos
// divergem no primeiro ajuste, e o prompt passa a prometer um teto que o banco não aplica.

/** Caracteres de uma linha da memória. Curto de propósito: a lista entra no contexto de todo turno. */
export const MEMORIA_TEXTO_MAX = 300;

/**
 * Linhas ATIVAS na memória. Cheia, Lembrar recusa (MEMORIA_CHEIA) em vez de descartar a mais
 * antiga: quem escolhe o que sai é quem pediu para entrar.
 */
export const MEMORIAS_ATIVAS_MAX = 20;
