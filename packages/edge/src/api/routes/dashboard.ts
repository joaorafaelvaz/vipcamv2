import type { DashboardSummary } from "@vipcam/shared";
import { Hono } from "hono";

export interface DashboardDeps {
  summary: () => Promise<DashboardSummary>;
}

/**
 * Endpoints REST do dashboard (Onda 3).
 *
 * - GET /summary  → counts agregados pra topbar (badge matches pendentes,
 *                   última detection, persons total, etc)
 *
 * Auth via apiKeyMiddleware aplicado em /api/dashboard/* no server.ts.
 */
export function createDashboardRoutes(deps: DashboardDeps): Hono {
  const r = new Hono();
  r.get("/summary", async (c) => c.json(await deps.summary()));
  return r;
}
