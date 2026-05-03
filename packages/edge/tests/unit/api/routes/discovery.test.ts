import { describe, expect, test } from "bun:test";
import type { DiscoveryReport } from "@vipcam/shared";
import { Hono } from "hono";
import { type DiscoveryDeps, createDiscoveryRoutes } from "../../../../src/api/routes/discovery.js";

function mountWith(deps: DiscoveryDeps): Hono {
  const app = new Hono();
  app.route("/api/discovery", createDiscoveryRoutes(deps));
  return app;
}

const fakeReport: DiscoveryReport = {
  generated_at: "2026-04-30T00:00:00Z",
  camera_ip: "192.168.1.108",
  probes: [],
  events_captured: 0,
  capture_duration_seconds: 0,
  event_types_seen: {},
  attribute_keys_seen: [],
  has_emotion_attribute: false,
  has_age_attribute: false,
  has_gender_attribute: false,
  recommended_ingest_channel: "unknown",
  fork_decision_required: [],
};

describe("POST /api/discovery/probe", () => {
  test("retorna 400 com hint quando câmera não configurada", async () => {
    const app = mountWith({
      env: {},
      runDiscovery: async () => {
        throw new Error("should not be called");
      },
      getLatestReport: async () => null,
    });
    const res = await app.request("/api/discovery/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("camera_not_configured");
  });

  test("invoca runDiscovery e devolve report quando câmera configurada", async () => {
    let calledWith: unknown;
    const app = mountWith({
      env: { CAMERA_IP: "192.168.1.108", CAMERA_USER: "admin", CAMERA_PASS: "secret" },
      runDiscovery: async (args) => {
        calledWith = args;
        return {
          report: fakeReport,
          jsonPath: "/tmp/r.json",
          markdownPath: "/tmp/r.md",
          capturesDir: "/tmp",
        };
      },
      getLatestReport: async () => null,
    });
    const res = await app.request("/api/discovery/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture_seconds: 60 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: DiscoveryReport; artifacts: unknown };
    expect(body.report.camera_ip).toBe("192.168.1.108");
    expect(calledWith).toMatchObject({ cameraIp: "192.168.1.108", captureSeconds: 60 });
  });

  test("rejeita body com capture_seconds inválido", async () => {
    const app = mountWith({
      env: { CAMERA_IP: "1.1.1.1", CAMERA_USER: "a", CAMERA_PASS: "b" },
      runDiscovery: async () => {
        throw new Error("should not be called");
      },
      getLatestReport: async () => null,
    });
    const res = await app.request("/api/discovery/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture_seconds: -1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/discovery/last-report", () => {
  test("retorna 404 quando getLatestReport devolve null", async () => {
    const app = mountWith({
      env: {},
      runDiscovery: async () => {
        throw new Error("ignore");
      },
      getLatestReport: async () => null,
    });
    const res = await app.request("/api/discovery/last-report");
    expect(res.status).toBe(404);
  });

  test("retorna 200 com report quando há relatório anterior", async () => {
    const app = mountWith({
      env: {},
      runDiscovery: async () => {
        throw new Error("ignore");
      },
      getLatestReport: async () => fakeReport,
    });
    const res = await app.request("/api/discovery/last-report");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: DiscoveryReport };
    expect(body.report.camera_ip).toBe("192.168.1.108");
  });
});
