import { describe, expect, test } from "bun:test";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { Hono } from "hono";
import { createEventsRoutes } from "../../../../src/api/routes/events.js";

/**
 * Tests do SSE são limitados pelo Hono.app.request() que retorna Response
 * direto sem reader real. Validamos: handshake (status + headers) + que
 * subscribe é registrado quando conexão abre.
 *
 * Lifecycle completo (abort → onAbort → unsubscribe) é testado manualmente
 * via curl no smoke test do Chunk 3.2.7.
 */
describe("GET /api/events/stream", () => {
  test("retorna 200 + headers SSE corretos", async () => {
    const app = new Hono();
    app.route(
      "/api/events",
      createEventsRoutes({
        subscribe: () => () => {},
        heartbeatMs: 100_000,
      }),
    );
    const res = await app.request("/api/events/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("registra subscriber assim que conexão abre", async () => {
    let subscribed = 0;
    const app = new Hono();
    app.route(
      "/api/events",
      createEventsRoutes({
        subscribe: (_handler) => {
          subscribed += 1;
          return () => {};
        },
        heartbeatMs: 100_000,
      }),
    );

    // Abre conexão e cancela imediatamente o body reader pra liberar
    const res = await app.request("/api/events/stream");
    await new Promise((r) => setTimeout(r, 30));
    await res.body?.cancel();

    expect(subscribed).toBe(1);
  });

  test("eventos publicados pelo bus são empurrados via writeSSE sem throw", async () => {
    let captured: ((e: LiveDetectionEvent) => void) | null = null;
    const app = new Hono();
    app.route(
      "/api/events",
      createEventsRoutes({
        subscribe: (handler) => {
          captured = handler;
          return () => {};
        },
        heartbeatMs: 100_000,
      }),
    );

    const res = await app.request("/api/events/stream");
    await new Promise((r) => setTimeout(r, 30));

    expect(captured).not.toBeNull();
    // Publish — não throwa, mesmo sem reader real (lossy aceitável)
    expect(() =>
      captured?.({
        type: "detection",
        detection: {
          id: "00000000-0000-0000-0000-000000000001",
          detected_at: "2026-05-14T13:00:00Z",
          snapshot_path: null,
          face_attrs: {},
          dominant_emotion: null,
          emotion_confidence: null,
          session_id: null,
          camera_id: "00000000-0000-0000-0000-000000000099",
        },
        person: null,
      }),
    ).not.toThrow();

    await res.body?.cancel();
  });
});
