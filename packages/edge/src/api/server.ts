import type { HealthResponse } from "@vipcam/shared";
import { Hono } from "hono";
import { getEnv } from "../config/env.js";
import { getLatestReport, runDiscovery } from "../discovery/runner.js";
import { logger as appLogger } from "../obs/logger.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";

export function createServer() {
  const app = new Hono();
  const startedAt = Date.now();

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      status: "healthy",
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      checks: {
        edge: { ok: true },
      },
    };
    return c.json(body);
  });

  const env = getEnv();
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
