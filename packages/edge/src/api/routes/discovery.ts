import type { DiscoveryReport } from "@vipcam/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../../config/env.js";

const probeBodySchema = z.object({
  capture_seconds: z.number().int().positive().max(3600).optional(),
});

export interface DiscoveryDeps {
  env: Pick<Env, "CAMERA_IP" | "CAMERA_USER" | "CAMERA_PASS">;
  runDiscovery: (args: {
    cameraIp: string;
    cameraUser: string;
    cameraPass: string;
    captureSeconds?: number;
  }) => Promise<{
    report: DiscoveryReport;
    jsonPath: string;
    markdownPath: string;
    capturesDir: string;
  }>;
  getLatestReport: () => Promise<DiscoveryReport | null>;
}

export function createDiscoveryRoutes(deps: DiscoveryDeps): Hono {
  const r = new Hono();

  r.post("/probe", async (c) => {
    const { env } = deps;
    if (!env.CAMERA_IP || !env.CAMERA_USER || !env.CAMERA_PASS) {
      return c.json(
        {
          error: "camera_not_configured",
          hint: "set CAMERA_IP, CAMERA_USER, CAMERA_PASS in .env",
        },
        400,
      );
    }
    const raw = await c.req.json().catch(() => ({}));
    const parsed = probeBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }

    const runArgs: {
      cameraIp: string;
      cameraUser: string;
      cameraPass: string;
      captureSeconds?: number;
    } = {
      cameraIp: env.CAMERA_IP,
      cameraUser: env.CAMERA_USER,
      cameraPass: env.CAMERA_PASS,
    };
    if (parsed.data.capture_seconds !== undefined) {
      runArgs.captureSeconds = parsed.data.capture_seconds;
    }
    const result = await deps.runDiscovery(runArgs);
    return c.json({
      report: result.report,
      artifacts: {
        json: result.jsonPath,
        markdown: result.markdownPath,
        captures_dir: result.capturesDir,
      },
    });
  });

  r.get("/last-report", async (c) => {
    const report = await deps.getLatestReport();
    if (!report) return c.json({ error: "no_report_yet" }, 404);
    return c.json({ report });
  });

  return r;
}
