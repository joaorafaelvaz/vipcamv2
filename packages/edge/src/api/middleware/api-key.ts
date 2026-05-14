import type { MiddlewareHandler } from "hono";

export interface ApiKeyMiddlewareOptions {
  /**
   * Path EXATO onde aceitar `?api_key=` query param ao invés do header
   * `X-API-Key`. Único caso de uso legítimo: `/api/events/stream` (SSE com
   * EventSource browser que NÃO suporta headers customizados).
   *
   * Manter restrito a 1 path — query params vazam pra access logs e
   * referers, então NUNCA habilitar em endpoints mutativos.
   */
  allowQueryOn?: string;
}

/**
 * Middleware Hono que exige header `X-API-Key` igual à chave esperada.
 * Retorna 401 se ausente ou inválido.
 *
 * **I3 (review 2026-05-13):** antes do fix, /api/erp/* e /api/matches/*
 * eram totalmente públicos — qualquer um na LAN podia DoS o ERP via
 * /api/erp/sync/checkins ou corromper match histórico via /api/matches/:id/resolve.
 *
 * Aplicar em /api/* exceto /api/health (health check precisa ser anônimo
 * para load balancer/monitoring).
 *
 * Comparação simples por igualdade — não há requisito de timing-attack
 * resistance (chave alta entropia + uso interno LAN). Pra exposição pública
 * usar timingSafeEqual.
 *
 * **Onda 3 Task 3.2.1:** opção `allowQueryOn` aceita `?api_key=` em path
 * EXATO whitelisted (uso: SSE EventSource não passa headers).
 */
export function apiKeyMiddleware(
  expectedKey: string,
  options: ApiKeyMiddlewareOptions = {},
): MiddlewareHandler {
  return async (c, next) => {
    const headerKey = c.req.header("X-API-Key");
    if (headerKey === expectedKey) {
      await next();
      return;
    }

    // Exceção: aceitar query param SOMENTE em path explicitamente whitelisted
    if (options.allowQueryOn && c.req.path === options.allowQueryOn) {
      const queryKey = c.req.query("api_key");
      if (queryKey === expectedKey) {
        await next();
        return;
      }
    }

    return c.json({ error: "unauthorized" }, 401);
  };
}
