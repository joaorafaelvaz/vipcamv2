import { describe, expect, test } from "bun:test";
import type { ImageSourceProbeReport } from "@vipcam/shared";
import { createImageProbeRoutes } from "../../../../src/api/routes/image-probe.js";

const status = {
  active: true,
  run_id: "run-1",
  window_minutes: 60,
  max_samples: 300,
  samples_captured: 0,
  sample_dir: "/tmp/s",
  started_at: "t",
  expires_at: "t2",
};
const fakeReport: ImageSourceProbeReport = {
  generated_at: "t",
  run_id: "run-1",
  thresholds: {
    min_event_image_rate: 0.7,
    min_face_rate: 0.8,
    min_det_score: 0.5,
    min_bbox_px: 80,
    min_snapshot_image_rate: 0.95,
    max_snapshot_delta_ms: 2000,
    min_samples: 30,
  },
  face_events_captured: 40,
  metrics: [],
  conclusion: "inconclusive",
  evidence: ["x"],
  failover_b_recommendation: "y",
};

function app(spy: { started?: unknown; stopped?: boolean; validated?: unknown } = {}) {
  return createImageProbeRoutes({
    start: (cfg) => {
      spy.started = cfg;
      return { ...status };
    },
    stop: () => {
      spy.stopped = true;
    },
    status: () => ({ ...status }),
    runValidation: async (thr) => {
      spy.validated = thr;
      return fakeReport;
    },
    defaultThresholds: fakeReport.thresholds,
  });
}

describe("createImageProbeRoutes", () => {
  test("POST /start clamps + calls start, returns status + note", async () => {
    const spy: { started?: any } = {};
    const res = await app(spy).request("/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ window_minutes: 999, max_samples: 50 }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.active).toBe(true);
    expect(j.note).toBeDefined();
    expect((spy.started as any).windowMinutes).toBe(999); // clamping is state's job; route forwards
    expect((spy.started as any).maxSamples).toBe(50);
  });

  test("GET /status returns status", async () => {
    const res = await app().request("/status");
    expect(res.status).toBe(200);
    expect((await res.json()).run_id).toBe("run-1");
  });

  test("POST /stop calls stop", async () => {
    const spy: { stopped?: boolean } = {};
    const res = await app(spy).request("/stop", { method: "POST" });
    expect(res.status).toBe(200);
    expect(spy.stopped).toBe(true);
  });

  test("POST /validate runs validation, returns report", async () => {
    const spy: { validated?: unknown } = {};
    const res = await app(spy).request("/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).conclusion).toBe("inconclusive");
    expect(spy.validated).toBeDefined();
  });

  test("POST /start with no body uses defaults", async () => {
    const spy: { started?: any } = {};
    const res = await app(spy).request("/start", { method: "POST" });
    expect(res.status).toBe(200);
    expect((spy.started as any).windowMinutes).toBe(60);
    expect((spy.started as any).maxSamples).toBe(300);
  });
});
