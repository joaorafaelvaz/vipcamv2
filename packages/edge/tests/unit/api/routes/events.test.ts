import { describe, expect, test } from "bun:test";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { createEventsRoutes } from "../../../../src/api/routes/events.js";

const fakeEvent: LiveDetectionEvent = {
  type: "detection",
  detection: {
    id: "00000000-0000-0000-0000-000000000001",
    detected_at: "2026-05-20T15:00:00Z",
    snapshot_path: null,
    face_attrs: {},
    dominant_emotion: null,
    emotion_confidence: null,
    session_id: null,
    camera_id: "00000000-0000-0000-0000-000000000099",
  },
  person: null,
};

function app(recent: (limit: number) => Promise<LiveDetectionEvent[]>) {
  return createEventsRoutes({ recent });
}

describe("createEventsRoutes GET /recent", () => {
  test("default limit=50 honored, calls deps.recent, returns array", async () => {
    let received: number | undefined;
    const r = await app(async (limit) => {
      received = limit;
      return [fakeEvent];
    }).request("/recent");
    expect(r.status).toBe(200);
    expect(received).toBe(50);
    expect(await r.json()).toEqual([fakeEvent]);
  });

  test("limit=1 boundary OK", async () => {
    let received: number | undefined;
    const r = await app(async (l) => {
      received = l;
      return [];
    }).request("/recent?limit=1");
    expect(r.status).toBe(200);
    expect(received).toBe(1);
  });

  test("limit=200 boundary OK", async () => {
    let received: number | undefined;
    const r = await app(async (l) => {
      received = l;
      return [];
    }).request("/recent?limit=200");
    expect(r.status).toBe(200);
    expect(received).toBe(200);
  });

  test.each([
    ["0", 400],
    ["201", 400],
    ["-5", 400],
    ["abc", 400],
    ["1.5", 400],
  ])("invalid limit=%s → %d", async (raw, expectedStatus) => {
    const r = await app(async () => []).request(`/recent?limit=${raw}`);
    expect(r.status).toBe(expectedStatus);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toContain("limit");
  });

  test("returns [] when deps.recent returns []", async () => {
    const r = await app(async () => []).request("/recent");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});
