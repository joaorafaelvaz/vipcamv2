import type { HealthCheck, HealthResponse } from "@vipcam/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getEnv } from "../config/env.js";
import { getLatestReport, runDiscovery } from "../discovery/runner.js";
import { logger as appLogger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";

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

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    appLogger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
