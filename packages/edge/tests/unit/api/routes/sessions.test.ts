import { describe, expect, test } from "bun:test";
import type { DetectionThumbnail } from "@vipcam/shared";
import { Hono } from "hono";
import { type SessionsDeps, createSessionsRoutes } from "../../../../src/api/routes/sessions.js";

const SESS_ID = "33333333-3333-3333-3333-333333333333";
const CAM_ID = "44444444-4444-4444-4444-444444444444";

const stubDet: DetectionThumbnail = {
  id: "55555555-5555-5555-5555-555555555555",
  detected_at: "2026-05-01T10:00:00Z",
  snapshot_path: "/var/lib/vipcam/snapshots/det.jpg",
  face_attrs: {},
  dominant_emotion: "happy",
  emotion_confidence: 0.8,
  session_id: SESS_ID,
  camera_id: CAM_ID,
};

function mountWith(deps: SessionsDeps): Hono {
  const app = new Hono();
  app.route("/api/sessions", createSessionsRoutes(deps));
  return app;
}

describe("GET /api/sessions/:id/detections", () => {
  test("retorna { items: DetectionThumbnail[] }", async () => {
    const app = mountWith({ listDetections: async () => [stubDet] });
    const res = await app.request(`/api/sessions/${SESS_ID}/detections`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: DetectionThumbnail[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(stubDet.id);
  });

  test("retorna { items: [] } quando sessão sem detections (deps decide; sem 404)", async () => {
    const app = mountWith({ listDetections: async () => [] });
    const res = await app.request(`/api/sessions/${SESS_ID}/detections`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
