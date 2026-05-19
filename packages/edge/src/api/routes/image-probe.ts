import type { ImageSourceProbeReport } from "@vipcam/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { Thresholds } from "../../discovery/image-probe/decision.js";

export interface ImageProbeStatusView {
  active: boolean;
  run_id: string | null;
  window_minutes: number;
  max_samples: number;
  samples_captured: number;
  sample_dir: string | null;
  started_at: string | null;
  expires_at: string | null;
}

export interface ImageProbeDeps {
  start: (cfg: { windowMinutes: number; maxSamples: number }) => ImageProbeStatusView;
  stop: () => void;
  status: () => ImageProbeStatusView;
  runValidation: (thresholds: Thresholds) => Promise<ImageSourceProbeReport>;
  defaultThresholds: Thresholds;
}

const startBody = z
  .object({
    window_minutes: z.coerce.number().positive().optional(),
    max_samples: z.coerce.number().int().positive().optional(),
    thresholds: z.record(z.string(), z.number()).optional(),
  })
  .optional();

const validateBody = z
  .object({ thresholds: z.record(z.string(), z.number()).optional() })
  .optional();

/**
 * Controle do camera image-source probe (Onda 6). Montado sob
 * /api/discovery/image-probe — herda o requireKey de /api/discovery/*.
 * start ativa o probe; o tap só engata no PRÓXIMO ciclo de reconexão do
 * listener (poucos segundos) — comunicado no campo `note`.
 */
export function createImageProbeRoutes(deps: ImageProbeDeps): Hono {
  const r = new Hono();

  r.post("/start", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    const p = startBody.safeParse(raw);
    if (!p.success) return c.json({ error: "invalid body", detail: p.error.issues }, 400);
    const b = p.data ?? {};
    const st = deps.start({
      windowMinutes: b.window_minutes ?? 60,
      maxSamples: b.max_samples ?? 300,
    });
    return c.json({
      ...st,
      note: "Probe ativa no próximo ciclo de reconexão do listener (≤ alguns segundos). snapshot.cgi engata por evento imediatamente.",
    });
  });

  r.post("/stop", (c) => {
    deps.stop();
    return c.json(deps.status());
  });

  r.get("/status", (c) => c.json(deps.status()));

  r.post("/validate", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    const p = validateBody.safeParse(raw);
    if (!p.success) return c.json({ error: "invalid body", detail: p.error.issues }, 400);
    const thr: Thresholds = { ...deps.defaultThresholds, ...(p.data?.thresholds ?? {}) } as Thresholds;
    const report = await deps.runValidation(thr);
    return c.json(report);
  });

  return r;
}
