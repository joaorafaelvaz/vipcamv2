import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { CapturedEvent } from "../../../src/discovery/capture.js";
import { processEvent } from "../../../src/ingest/pipeline.js";
import { closeDb } from "../../../src/persistence/db.js";
import { camerasRepo, detectionsRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

let cameraId: string;

beforeEach(async () => {
  await truncateAll();
  const cam = await camerasRepo.create({ name: "test-cam", ip_address: "1.2.3.4" });
  cameraId = cam.id;
});

afterAll(async () => {
  await closeDb();
});

/** Cria um evento FaceDetection com payload Dahua nested (data.Object.*). */
function rawFaceDetection(trackId: string, atSec: number): CapturedEvent {
  const data = {
    Class: "FaceDetection",
    Faces: [{ ObjectID: Number(trackId), Sex: "Man", Age: 30 }],
    Object: {
      Action: "Appear",
      ObjectID: Number(trackId),
      Sex: "Man",
      Age: 30,
      Emotion: "Happy",
      Express: 80,
      BoundingBox: [1000, 1500, 1500, 2000],
      Angle: [0, 0, 0],
      Confidence: 200,
      FaceQuality: 70,
      Mask: 1,
      Glass: 1,
      Beard: 1,
      Mouth: 1,
      Eye: 2,
    },
    RealUTC: Math.floor(new Date(2026, 4, 1, 12, 0, atSec).getTime() / 1000),
  };
  return {
    index: 0,
    received_at: new Date(2026, 4, 1, 12, 0, atSec).toISOString(),
    raw: `Code=FaceDetection;action=Start;index=0;data=${JSON.stringify(data)}`,
    parsed: { code: "FaceDetection", action: "Start", data },
  };
}

describe("processEvent (pipeline)", () => {
  test("evento face.detected cria detection + session anônima", async () => {
    await processEvent(rawFaceDetection("100", 0), cameraId);
    const dets = await detectionsRepo.recent(10);
    expect(dets).toHaveLength(1);
    expect(dets[0]?.session_id).toBeDefined();
    expect(dets[0]?.person_id).toBeNull(); // anônima sem reid
    expect(dets[0]?.track_id).toBe("100");
    expect(dets[0]?.dominant_emotion).toBe("Happy");
    // emotion_confidence = Express/100 = 0.8
    expect(dets[0]?.emotion_confidence).toBeCloseTo(0.8, 2);
  });

  test("dois eventos do mesmo track dentro do gap reusam a mesma sessão", async () => {
    await processEvent(rawFaceDetection("100", 0), cameraId);
    await processEvent(rawFaceDetection("100", 10), cameraId); // 10s depois (< 30s gap)
    const dets = await detectionsRepo.recent(10);
    expect(dets).toHaveLength(2);
    expect(dets[0]?.session_id).toBe(dets[1]?.session_id);
  });

  test("eventos com gap > 30s criam sessões separadas", async () => {
    await processEvent(rawFaceDetection("100", 0), cameraId);
    await processEvent(rawFaceDetection("100", 60), cameraId); // 60s depois
    const dets = await detectionsRepo.recent(10);
    expect(dets[0]?.session_id).not.toBe(dets[1]?.session_id);
  });

  test("ignora eventos não-relevantes (VideoMotion) sem inserir nada", async () => {
    const raw: CapturedEvent = {
      index: 0,
      received_at: new Date().toISOString(),
      raw: "Code=VideoMotion;action=Start;index=0",
      parsed: { code: "VideoMotion", action: "Start", data: {} },
    };
    await processEvent(raw, cameraId);
    const dets = await detectionsRepo.recent(10);
    expect(dets).toHaveLength(0);
  });

  test("face.detected.stop não cria detection (apenas sinal de tracker)", async () => {
    const raw = rawFaceDetection("100", 0);
    if (raw.parsed) raw.parsed.action = "Stop";
    await processEvent(raw, cameraId);
    const dets = await detectionsRepo.recent(10);
    expect(dets).toHaveLength(0);
  });
});
