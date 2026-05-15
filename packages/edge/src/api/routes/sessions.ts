import type { DetectionThumbnail } from "@vipcam/shared";
import { Hono } from "hono";

export interface SessionsDeps {
  listDetections: (sessionId: string) => Promise<DetectionThumbnail[]>;
}

/**
 * Endpoints REST de sessions (Onda 3).
 *
 * - GET /:id/detections  → todas detections da session (com snapshot_path)
 *
 * Auth via apiKeyMiddleware aplicado em /api/sessions/* no server.ts.
 */
export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const r = new Hono();

  r.get("/:id/detections", async (c) => {
    const id = c.req.param("id");
    const items = await deps.listDetections(id);
    return c.json({ items });
  });

  return r;
}
