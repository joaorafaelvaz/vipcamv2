import type { HealthResponse } from "@vipcam/shared";
import { Hono } from "hono";
import { logger as appLogger } from "../obs/logger.js";

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

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    appLogger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
