import type { LiveDetectionEvent } from "@vipcam/shared";
import { Hono } from "hono";

export interface EventsDeps {
  /** Últimas N detecções enriquecidas, em ordem DESC por detected_at. */
  recent: (limit: number) => Promise<LiveDetectionEvent[]>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Endpoints REST do /live (Onda 8 — polling-only).
 *
 * GET /recent?limit=N  →  LiveDetectionEvent[]  (envelope por item, DESC por
 * detected_at, default 50, cap 200). Substitui o antigo /stream (SSE) que
 * era inconsertável sob nginx HTTP/2 (ver onda 8 spec §2 e relatório
 * 2026-05-19/20). Auth via apiKeyMiddleware aplicado em /api/events/* no
 * server.ts (header X-API-Key normal — sem allowQueryOn).
 */
export function createEventsRoutes(deps: EventsDeps): Hono {
  const r = new Hono();
  r.get("/recent", async (c) => {
    const raw = c.req.query("limit");
    let limit: number = DEFAULT_LIMIT;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        return c.json({ error: `limit must be 1..${MAX_LIMIT}` }, 400);
      }
      limit = n;
    }
    return c.json(await deps.recent(limit));
  });
  return r;
}
