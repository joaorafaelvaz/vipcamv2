import type { MiddlewareHandler } from "hono";

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
 */
export function apiKeyMiddleware(expectedKey: string): MiddlewareHandler {
  return async (c, next) => {
    const provided = c.req.header("X-API-Key");
    if (!provided || provided !== expectedKey) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
