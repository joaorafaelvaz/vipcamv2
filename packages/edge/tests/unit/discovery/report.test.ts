import { describe, expect, test } from "bun:test";
import type { ProbeResult } from "@vipcam/shared";
import { buildReport, renderMarkdown } from "../../../src/discovery/report.js";

const probes: ProbeResult[] = [
  {
    name: "magicBox.getSystemInfo",
    endpoint: "/cgi-bin/magicBox.cgi?action=getSystemInfo",
    status: "ok",
    http_status: 200,
    duration_ms: 10,
    parsed: { deviceType: "IPC-HFW5442T-ASE", serialNumber: "X" },
  },
  {
    name: "snapshot.fetch",
    endpoint: "/cgi-bin/snapshot.cgi?channel=1",
    status: "ok",
    http_status: 200,
    duration_ms: 80,
  },
  {
    name: "faceInfo.getCount",
    endpoint: "/cgi-bin/FaceInfoManager.cgi?action=getCount",
    status: "not_found",
    http_status: 404,
    duration_ms: 12,
  },
];

describe("buildReport", () => {
  test("agrega probes + capture metadata num DiscoveryReport", () => {
    const report = buildReport({
      cameraIp: "192.168.1.108",
      probes,
      capturedEvents: [
        {
          index: 0,
          received_at: "2026-04-30T12:00:00Z",
          raw: 'Code=FaceDetection;action=Start;index=0;data={"Age":30,"Gender":"Male"}',
          parsed: {
            code: "FaceDetection",
            action: "Start",
            data: { Age: 30, Gender: "Male" },
          },
        },
      ],
      captureDurationSeconds: 120,
    });
    expect(report.camera_ip).toBe("192.168.1.108");
    expect(report.camera_model).toBe("IPC-HFW5442T-ASE");
    expect(report.events_captured).toBe(1);
    expect(report.event_types_seen.FaceDetection).toBe(1);
    expect(report.has_age_attribute).toBe(true);
    expect(report.has_gender_attribute).toBe(true);
    expect(report.has_emotion_attribute).toBe(false);
    expect(report.fork_decision_required.some((s) => s.includes("emoção"))).toBe(true);
  });

  test("recommended_ingest_channel = http_attach_sse quando attach probe funcionou e eventos chegaram", () => {
    const report = buildReport({
      cameraIp: "1.1.1.1",
      probes: [],
      capturedEvents: [
        { index: 0, received_at: "x", raw: "x", parsed: { code: "Foo", action: "Start" } },
      ],
      captureDurationSeconds: 10,
    });
    expect(report.recommended_ingest_channel).toBe("http_attach_sse");
  });
});

describe("renderMarkdown", () => {
  test("produz markdown com seções esperadas", () => {
    const report = buildReport({
      cameraIp: "192.168.1.108",
      probes,
      capturedEvents: [],
      captureDurationSeconds: 60,
    });
    const md = renderMarkdown(report);
    expect(md).toContain("# Discovery Report");
    expect(md).toContain("192.168.1.108");
    expect(md).toContain("## Probes");
    expect(md).toContain("magicBox.getSystemInfo");
    expect(md).toContain("✅");
    expect(md).toContain("❌");
    expect(md).toContain("## Decisões pendentes");
  });
});
