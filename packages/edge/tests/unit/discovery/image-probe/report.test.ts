import { describe, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS } from "../../../../src/discovery/image-probe/decision.js";
import {
  buildImageSourceReport,
  renderDecisionMarkdown,
} from "../../../../src/discovery/image-probe/report.js";

describe("buildImageSourceReport", () => {
  test("inconclusive when faceEvents < min_samples; carries decide() output", () => {
    const r = buildImageSourceReport({
      runId: "run-x",
      faceEvents: 5,
      metrics: [
        {
          source: "event",
          samples: 5,
          with_image: 5,
          usable_face: 0,
          median_bbox_px: null,
          median_infer_ms: 10,
          median_delta_ms: null,
        },
      ],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("inconclusive");
    expect(r.run_id).toBe("run-x");
    expect(r.face_events_captured).toBe(5);
    expect(r.thresholds.min_samples).toBe(30);
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(typeof r.generated_at).toBe("string");
  });

  test("renderDecisionMarkdown includes conclusion, recommendation, evidence, cleanup note", () => {
    const r = buildImageSourceReport({
      runId: "run-y",
      faceEvents: 40,
      metrics: [
        {
          source: "event",
          samples: 40,
          with_image: 36,
          usable_face: 32,
          median_bbox_px: 120,
          median_infer_ms: 50,
          median_delta_ms: null,
        },
      ],
      thresholds: DEFAULT_THRESHOLDS,
    });
    const md = renderDecisionMarkdown(r);
    expect(md).toContain("Camera Image-Source Probe");
    expect(md).toContain(r.failover_b_recommendation);
    expect(md).toContain(r.evidence[0]!);
    expect(md.toLowerCase()).toContain("limpeza");
    expect(md).toContain("run-y");
  });
});
