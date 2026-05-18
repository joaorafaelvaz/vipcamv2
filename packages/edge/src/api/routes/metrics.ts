import type { MetricsOverview } from "@vipcam/shared";
import { Hono } from "hono";

export interface MetricsDeps {
  overview: (days: 7 | 30) => Promise<MetricsOverview>;
}

/**
 * Endpoints REST de métricas (Onda 5).
 * - GET /overview?days=7|30 → MetricsOverview (1 request = página inteira)
 * Auth via apiKeyMiddleware aplicado em /api/metrics/* no server.ts.
 */
export function createMetricsRoutes(deps: MetricsDeps): Hono {
  const r = new Hono();
  r.get("/overview", async (c) => {
    const raw = c.req.query("days");
    const days = raw === undefined ? 7 : Number(raw);
    if (days !== 7 && days !== 30) {
      return c.json({ error: "days must be 7 or 30" }, 400);
    }
    return c.json(await deps.overview(days as 7 | 30));
  });
  return r;
}
