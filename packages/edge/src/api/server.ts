import type { HealthCheck, HealthResponse } from "@vipcam/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getEnv } from "../config/env.js";
import { getLatestReport, runDiscovery } from "../discovery/runner.js";
import { pollCheckins } from "../erp-sync/checkins.js";
import { syncClients } from "../erp-sync/clients.js";
import { syncEmployees } from "../erp-sync/employees.js";
import { logger as appLogger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import {
  detectionsRepo,
  matchAttemptsRepo,
  sessionsRepo,
} from "../persistence/repositories/index.js";
import { erpCheckins, erpClients, erpEmployees } from "../persistence/schema/erp-cache.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import { createErpRoutes } from "./routes/erp.js";
import { createMatchRoutes } from "./routes/matches.js";

export function createServer() {
  const app = new Hono();
  const startedAt = Date.now();
  const env = getEnv();

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

  // Revisão manual de match_attempts ambíguos. resolve() faz 3 mutações em
  // sequência (match_attempt + detection.person_id + session.person_id) — se
  // alguma falhar o estado fica inconsistente, mas não vale envolver em
  // transação porque é raro (operador clica esporadicamente) e logs do erro
  // permitem retry idempotente (resolveAmbiguous é UPDATE com WHERE id=).
  app.route(
    "/api/matches",
    createMatchRoutes({
      listPending: (limit) => matchAttemptsRepo.findPending(limit),
      resolve: async (id, chosenDetectionId, chosenPersonId) => {
        const attempt = await matchAttemptsRepo.findById(id);
        if (!attempt) throw new Error(`match_attempt ${id} not found`);
        await matchAttemptsRepo.resolveAmbiguous(id, chosenDetectionId);
        await detectionsRepo.linkToPerson(chosenDetectionId, chosenPersonId);
        const det = await detectionsRepo.findById(chosenDetectionId);
        if (det?.session_id) {
          await sessionsRepo.linkToPerson(det.session_id, chosenPersonId, attempt.erp_checkin_id);
        }
      },
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
