import type { HealthCheck, HealthResponse } from "@vipcam/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getEnv } from "../config/env.js";
import { getLatestReport, runDiscovery } from "../discovery/runner.js";
import { pollCheckins } from "../erp-sync/checkins.js";
import { syncClients } from "../erp-sync/clients.js";
import { syncEmployees } from "../erp-sync/employees.js";
import { getJobHealth } from "../erp-sync/scheduler-health.js";
import { resolveAmbiguous } from "../match-temp/review.js";
import { logger as appLogger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import { matchAttemptsRepo } from "../persistence/repositories/index.js";
import { erpCheckins, erpClients, erpEmployees } from "../persistence/schema/erp-cache.js";
import { apiKeyMiddleware } from "./middleware/api-key.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import { createErpRoutes } from "./routes/erp.js";
import { createMatchRoutes } from "./routes/matches.js";

export function createServer() {
  const app = new Hono();
  const startedAt = Date.now();
  const env = getEnv();

  // I3: protege rotas mutativas/sensíveis. /api/health fica anônimo
  // (usado por nginx/uptime monitoring).
  const requireKey = apiKeyMiddleware(env.API_KEY);
  app.use("/api/discovery/*", requireKey);
  app.use("/api/erp/*", requireKey);
  app.use("/api/matches/*", requireKey);

  app.get("/api/health", async (c) => {
    const checks: Record<string, HealthCheck> = { edge: { ok: true } };

    if (env.DATABASE_URL) {
      const t0 = Date.now();
      try {
        await getDb().execute(sql`SELECT 1`);
        checks.db = { ok: true, latency_ms: Date.now() - t0 };
      } catch (err) {
        checks.db = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // I4 (review 2026-05-13): expõe estado de cada job do scheduler. Após
    // N failures consecutivas, o check fica ok=false e degrada o overall
    // status pra que monitoring/uptime alerte (ex: schema do ERP mudou em
    // runtime e queries começam a throw a cada 30s).
    for (const job of getJobHealth()) {
      const check: HealthCheck = { ok: job.healthy };
      if (!job.healthy && job.last_error) check.error = job.last_error;
      checks[`scheduler_${job.name}`] = check;
    }

    const allOk = Object.values(checks).every((ck) => ck.ok);
    const status: HealthResponse["status"] = allOk ? "healthy" : "degraded";
    const body: HealthResponse = {
      status,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    };
    return c.json(body, allOk ? 200 : 503);
  });
  app.route(
    "/api/discovery",
    createDiscoveryRoutes({
      env: {
        CAMERA_IP: env.CAMERA_IP,
        CAMERA_USER: env.CAMERA_USER,
        CAMERA_PASS: env.CAMERA_PASS,
      },
      runDiscovery,
      getLatestReport,
    }),
  );

  // ERP sync — botões manuais (cron já roda em background via scheduler).
  // Útil pra forçar re-sync após editar query no .env ou debugar feed.
  app.route(
    "/api/erp",
    createErpRoutes({
      syncEmployees,
      syncClients,
      pollCheckins,
      status: async () => {
        const db = getDb();
        const [emp] = await db.select({ c: sql<number>`count(*)::int` }).from(erpEmployees);
        const [cli] = await db.select({ c: sql<number>`count(*)::int` }).from(erpClients);
        const [chk] = await db
          .select({ max: sql<Date | null>`max(${erpCheckins.occurred_at})` })
          .from(erpCheckins);
        return {
          employees_count: emp?.c ?? 0,
          clients_count: cli?.c ?? 0,
          last_checkin_at: chk?.max ? new Date(chk.max).toISOString() : null,
        };
      },
    }),
  );

  // Revisão manual de match_attempts ambíguos.
  // resolveAmbiguous (match-temp/review.ts) wrappa as writes em db.transaction
  // (C2 fix) e valida semanticamente que detection ∈ window do checkin e que
  // person.erp_client_id (se setado) bate com checkin.erp_client_id.
  // Errors tipados (ResolveError) viram HTTP code apropriado no route handler.
  app.route(
    "/api/matches",
    createMatchRoutes({
      listPending: (limit) => matchAttemptsRepo.findPending(limit),
      resolve: resolveAmbiguous,
      reject: (id, reason) => matchAttemptsRepo.rejectAmbiguous(id, reason).then(() => undefined),
    }),
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    appLogger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
