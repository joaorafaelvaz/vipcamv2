import { describe, expect, test } from "bun:test";
import type { SourceMetrics } from "@vipcam/shared";
import { DEFAULT_THRESHOLDS, decide } from "../../../../src/discovery/image-probe/decision.js";

const ev = (o: Partial<SourceMetrics>): SourceMetrics => ({
  source: "event",
  samples: 0,
  with_image: 0,
  usable_face: 0,
  median_bbox_px: null,
  median_infer_ms: null,
  median_delta_ms: null,
  ...o,
});
const sn = (o: Partial<SourceMetrics>): SourceMetrics => ({ ...ev(o), source: "snapshot" });

describe("decide", () => {
  test("<30 face events → inconclusive", () => {
    const r = decide({
      faceEvents: 10,
      metrics: [ev({ samples: 10 })],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("inconclusive");
  });

  test("strong event-embedded → a", () => {
    const r = decide({
      faceEvents: 40,
      metrics: [ev({ samples: 40, with_image: 36, usable_face: 32, median_bbox_px: 120 })],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("a_event_embedded");
  });

  test("event weak, snapshot strong & aligned → b", () => {
    const r = decide({
      faceEvents: 40,
      metrics: [
        ev({ samples: 40, with_image: 2, usable_face: 1 }),
        sn({
          samples: 40,
          with_image: 39,
          usable_face: 32,
          median_delta_ms: 800,
          median_bbox_px: 100,
        }),
      ],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("b_snapshot_cgi");
  });

  test("both weak but images exist w/o usable faces → d", () => {
    const r = decide({
      faceEvents: 40,
      metrics: [
        ev({ samples: 40, with_image: 38, usable_face: 1 }),
        sn({ samples: 40, with_image: 39, usable_face: 0, median_delta_ms: 800 }),
      ],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("d_infeasible");
  });

  test("both weak, no images at all → c (recommend rtsp)", () => {
    const r = decide({
      faceEvents: 40,
      metrics: [ev({ samples: 40, with_image: 0 }), sn({ samples: 40, with_image: 0 })],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("c_recommend_rtsp_followup");
  });

  test("thresholds parametrizable", () => {
    const lax = { ...DEFAULT_THRESHOLDS, min_face_rate: 0.1 };
    const r = decide({
      faceEvents: 40,
      metrics: [ev({ samples: 40, with_image: 36, usable_face: 5, median_bbox_px: 90 })],
      thresholds: lax,
    });
    expect(r.conclusion).toBe("a_event_embedded");
  });
});
