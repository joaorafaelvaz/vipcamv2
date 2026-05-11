import { describe, expect, test } from "bun:test";
import type { CapturedEvent } from "../../../src/discovery/capture.js";
import { normalize } from "../../../src/ingest/normalizer.js";

const cameraId = "cam-uuid-xxx";

/** Fixture real (run-2026-05-11T16-32-34-520Z, FaceDetection action=Start, index 4) */
const realFixture: CapturedEvent = {
  index: 4,
  received_at: "2026-05-11T16:33:02.931Z",
  raw: "Code=FaceDetection;action=Start;index=0;data=...",
  parsed: {
    code: "FaceDetection",
    action: "Start",
    data: {
      CfgRuleId: 3,
      Class: "FaceDetection",
      EventID: 20081,
      Faces: [
        {
          Age: 49,
          Sex: "Man",
          ObjectID: 47898,
          BoundingBox: [2576, 3528, 2808, 3992],
        },
      ],
      Object: {
        Action: "Appear",
        Age: 49,
        Sex: "Man",
        Gender: 2,
        Emotion: "Confused",
        Express: 10,
        Beard: 2,
        Glass: 1,
        Mask: 1,
        Eye: 2,
        Mouth: 1,
        Confidence: 255,
        FaceQuality: 72,
        BoundingBox: [2576, 3528, 2808, 3992],
        Angle: [0, 10, 0],
        ObjectID: 47898,
        ObjectType: "HumanFace",
      },
      RealUTC: 1778517156,
      WithSnap: true,
    },
  },
};

describe("normalize (Dahua nested payload)", () => {
  test("FaceDetection action=Start vira face.detected.start com atributos completos", () => {
    const ev = normalize(realFixture, cameraId);
    expect(ev?.type).toBe("face.detected.start");
    expect(ev?.camera_id).toBe(cameraId);
    expect(ev?.track_id).toBe("47898");
    expect(ev?.face_attrs?.age).toBe(49);
    expect(ev?.face_attrs?.gender).toBe("male");
    expect(ev?.face_attrs?.emotion).toBe("Confused");
    expect(ev?.face_attrs?.emotion_intensity).toBe(10);
    expect(ev?.face_attrs?.glasses).toBe(false); // Glass=1 → No
    expect(ev?.face_attrs?.mask).toBe(false); // Mask=1 → No
    expect(ev?.face_attrs?.beard).toBe(true); // Beard=2 → Yes
    expect(ev?.face_attrs?.eyes_open).toBe(true); // Eye=2 → open
    expect(ev?.face_attrs?.face_quality).toBe(72);
    expect(ev?.face_attrs?.confidence).toBe(255);
    expect(ev?.face_attrs?.pitch_deg).toBe(0);
    expect(ev?.face_attrs?.yaw_deg).toBe(10);
    expect(ev?.face_attrs?.roll_deg).toBe(0);
    // Bbox normalizado 0-1 (8192 fixed-point)
    expect(ev?.bbox?.x).toBeCloseTo(2576 / 8192, 4);
    expect(ev?.bbox?.y).toBeCloseTo(3528 / 8192, 4);
    expect(ev?.bbox?.w).toBeCloseTo((2808 - 2576) / 8192, 4);
    expect(ev?.bbox?.h).toBeCloseTo((3992 - 3528) / 8192, 4);
  });

  test("FaceDetection action=Stop vira face.detected.stop", () => {
    const parsed = realFixture.parsed;
    if (!parsed) throw new Error("fixture parsed missing");
    const stopped: CapturedEvent = {
      ...realFixture,
      parsed: { ...parsed, action: "Stop" },
    };
    const ev = normalize(stopped, cameraId);
    expect(ev?.type).toBe("face.detected.stop");
    expect(ev?.track_id).toBe("47898");
  });

  test("Sex 'Woman' mapeia para 'female'", () => {
    const data = realFixture.parsed?.data as Record<string, unknown>;
    const obj = data.Object as Record<string, unknown>;
    const womanFixture: CapturedEvent = {
      ...realFixture,
      parsed: {
        code: "FaceDetection",
        action: "Start",
        data: { ...data, Object: { ...obj, Sex: "Woman" } },
      },
    };
    const ev = normalize(womanFixture, cameraId);
    expect(ev?.face_attrs?.gender).toBe("female");
  });

  test("retorna null para Code irrelevante (ex: VideoMotion)", () => {
    const ev = normalize(
      {
        ...realFixture,
        parsed: { code: "VideoMotion", action: "Start", data: {} },
      },
      cameraId,
    );
    expect(ev).toBeNull();
  });

  test("retorna null para FaceDetection sem data.Object (payload malformado)", () => {
    const ev = normalize(
      {
        ...realFixture,
        parsed: { code: "FaceDetection", action: "Start", data: { Faces: [] } },
      },
      cameraId,
    );
    expect(ev).toBeNull();
  });

  test("preserva raw_event para auditoria", () => {
    const ev = normalize(realFixture, cameraId);
    expect(ev?.raw_event).toMatchObject({
      Object: { ObjectID: 47898 },
      EventID: 20081,
    });
  });

  test("usa RealUTC quando disponível em vez de received_at", () => {
    const ev = normalize(realFixture, cameraId);
    // RealUTC=1778517156 → 2026-05-11T16:32:36.000Z
    expect(ev?.detected_at).toBe(new Date(1778517156 * 1000).toISOString());
  });
});
