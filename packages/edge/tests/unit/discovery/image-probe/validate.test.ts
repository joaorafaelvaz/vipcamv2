import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetectResult, ProbeSampleMeta } from "@vipcam/shared";
import { DEFAULT_THRESHOLDS } from "../../../../src/discovery/image-probe/decision.js";
import { aggregate } from "../../../../src/discovery/image-probe/validate.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "val-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function meta(m: Partial<ProbeSampleMeta>): ProbeSampleMeta {
  return {
    source: "event",
    seq: 0,
    event_idx: null,
    event_code: "FaceDetection",
    event_ts: null,
    captured_ts: "t",
    delta_ms: null,
    content_type: "image/jpeg",
    http_status: null,
    byte_len: 1,
    file: "0.jpg",
    ...m,
  };
}

describe("aggregate", () => {
  test("computes per-source rates + medians from detect results", () => {
    const samples = [
      {
        meta: meta({ seq: 0, source: "event" }),
        detect: {
          faces: [{ bbox: [0, 0, 120, 120], det_score: 0.9 }],
          width: 640,
          height: 480,
          infer_ms: 50,
        } as DetectResult,
      },
      {
        meta: meta({ seq: 1, source: "event" }),
        detect: { faces: [], width: 640, height: 480, infer_ms: 40 } as DetectResult,
      },
    ];
    const { metrics } = aggregate(samples, 35, DEFAULT_THRESHOLDS);
    const e = metrics.find((m) => m.source === "event")!;
    expect(e.samples).toBe(2);
    expect(e.with_image).toBe(2);
    expect(e.usable_face).toBe(1);
    expect(e.median_infer_ms).toBe(45);
  });
});
