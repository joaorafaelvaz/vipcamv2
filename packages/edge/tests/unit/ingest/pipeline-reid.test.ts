// NOTA (bun:test mock.module process-wide): `mock.module` é PROCESS-WIDE,
// então só mockamos os 5 REPOS (paths leaf que nenhum outro suite importa).
// NÃO mockamos:
//   - snapshot-store (snapshot-store.test.ts importa real)
//   - config/env (central — vaza pra todos)
//   - reid/orchestrator (orchestrator.test.ts importa real — vaza pra ele)
// Em vez disso: real saveCrop apontando SNAPSHOTS_DIR via process.env +
// resetEnvCache; e o orchestrator é injetado via `deps.resolveReid`
// (overrride do pipeline). Padrão herdado de tests/unit/scheduler/snapshot-retention.test.ts.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReidOutput } from "../../../src/api/reid/orchestrator.js";

let orchestratorResult: ReidOutput = { personId: null, status: "disabled" };
let capturedFrame: Buffer = Buffer.from([0xff, 0xd8]);
let insertedDetection: Record<string, unknown> | null = null;
let createdPerson: Record<string, unknown> | null = null;
let createdFaceRecord: Record<string, unknown> | null = null;
let createdAmbiguous: Record<string, unknown> | null = null;

const installMocks = () => {
  mock.module("../../../src/persistence/repositories/detections.repo.js", () => ({
    detectionsRepo: {
      create: async (d: Record<string, unknown>) => {
        insertedDetection = d;
        return { id: d.id ?? "det-x", ...d };
      },
    },
  }));
  mock.module("../../../src/persistence/repositories/persons.repo.js", () => ({
    personsRepo: {
      create: async (p: Record<string, unknown>) => {
        createdPerson = p;
        return { id: "p-new", ...p };
      },
      incrementVisitCount: async () => undefined,
    },
  }));
  mock.module("../../../src/persistence/repositories/face-records.repo.js", () => ({
    faceRecordsRepo: {
      insertAndEvict: async (d: Record<string, unknown>) => {
        createdFaceRecord = d;
        return { id: "fr-x", ...d };
      },
    },
  }));
  mock.module("../../../src/persistence/repositories/reid-match-attempts.repo.js", () => ({
    reidMatchAttemptsRepo: {
      createAmbiguous: async (d: Record<string, unknown>) => {
        createdAmbiguous = d;
        return { id: "rma-x", ...d };
      },
    },
  }));
  mock.module("../../../src/persistence/repositories/sessions.repo.js", () => ({
    sessionsRepo: {
      findOpenForTrack: async () => null,
      create: async () => ({ id: "sess-new", person_id: null }),
      appendDetection: async () => undefined,
      recalcDominantEmotion: async () => undefined,
    },
  }));
};
installMocks();

import { resetEnvCache } from "../../../src/config/env.js";
import { processEvent } from "../../../src/ingest/pipeline.js";

function captureSnapshotStub(): Promise<Buffer> {
  return Promise.resolve(capturedFrame);
}

// RealUTC 2026-05-20T14:30:00Z = 1779892200
const REAL_UTC = Math.floor(Date.UTC(2026, 4, 20, 14, 30, 0) / 1000);
const baseRaw = {
  received_at: "2026-05-20T14:30:00Z",
  index: 1,
  parsed: {
    code: "FaceDetection",
    action: "Start" as const,
    data: {
      RealUTC: REAL_UTC,
      Object: { ObjectID: 42, BoundingBox: [100, 100, 300, 300] },
    },
  },
};

let tmpSnapsDir = "";
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  orchestratorResult = { personId: null, status: "disabled" };
  insertedDetection = null;
  createdPerson = null;
  createdFaceRecord = null;
  createdAmbiguous = null;
  tmpSnapsDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipe-reid-test-"));
  originalEnv = {
    SNAPSHOTS_DIR: process.env.SNAPSHOTS_DIR,
    API_KEY: process.env.API_KEY,
    REID_ENABLED: process.env.REID_ENABLED,
  };
  process.env.SNAPSHOTS_DIR = tmpSnapsDir;
  if (!process.env.API_KEY) process.env.API_KEY = "test-key";
  resetEnvCache();
  installMocks();
});

afterEach(async () => {
  if (tmpSnapsDir) await fs.rm(tmpSnapsDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

describe("processEvent — reid integration", () => {
  test("orchestrator strict match → detection gets person_id + face_record criado", async () => {
    orchestratorResult = {
      personId: "p-existing",
      status: "matched_strict",
      reidDistance: 0.2,
      embedding: {
        embedding: Array(512).fill(0.1),
        det_score: 0.95,
        infer_ms: 28,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
        crop_jpeg_b64: "/9j/4AAQSkZJRgABAQEAYABgAAD/2w==",
      },
    };
    await processEvent(baseRaw as Parameters<typeof processEvent>[0], "cam-1", {
      captureSnapshot: captureSnapshotStub,
      resolveReid: async () => orchestratorResult,
    });
    expect(insertedDetection?.person_id).toBe("p-existing");
    // saveCrop real: path relativo "YYYY-MM-DD/<uuid>.jpg"
    expect(insertedDetection?.snapshot_path).toMatch(/^2026-05-20\/[a-f0-9-]+\.jpg$/);
    expect((insertedDetection?.face_attrs as Record<string, unknown>).reid_status).toBe(
      "matched_strict",
    );
    expect(createdFaceRecord?.person_id).toBe("p-existing");
    expect(createdPerson).toBeNull();
  });

  test("orchestrator new_person → cria person anônima + face_record", async () => {
    orchestratorResult = {
      personId: null,
      status: "new_person",
      embedding: {
        embedding: Array(512).fill(0.1),
        det_score: 0.95,
        infer_ms: 28,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
        crop_jpeg_b64: "/9j/4AAQSkZJRgABAQEAYABgAAD/2w==",
      },
    };
    await processEvent(baseRaw as Parameters<typeof processEvent>[0], "cam-1", {
      captureSnapshot: captureSnapshotStub,
      resolveReid: async () => orchestratorResult,
    });
    expect(createdPerson).toBeDefined();
    expect((createdPerson as Record<string, unknown>).person_type).toBe("anonymous");
    expect(insertedDetection?.person_id).toBe("p-new");
    expect(createdFaceRecord?.person_id).toBe("p-new");
    expect((createdFaceRecord as Record<string, unknown>).is_primary).toBe(true);
  });

  test("orchestrator borderline → INSERT reid_match_attempt(ambiguous)", async () => {
    orchestratorResult = {
      personId: null,
      status: "borderline",
      reidDistance: 0.45,
      embedding: {
        embedding: Array(512).fill(0.1),
        det_score: 0.9,
        infer_ms: 28,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
        crop_jpeg_b64: "/9j/4AAQSkZJRgABAQEAYABgAAD/2w==",
      },
      borderlineCandidate: { face_record_id: "fr-cand", person_id: "p-cand", distance: 0.45 },
    };
    await processEvent(baseRaw as Parameters<typeof processEvent>[0], "cam-1", {
      captureSnapshot: captureSnapshotStub,
      resolveReid: async () => orchestratorResult,
    });
    expect(createdAmbiguous?.candidate_face_record_id).toBe("fr-cand");
    expect(createdAmbiguous?.candidate_person_id).toBe("p-cand");
    expect(createdAmbiguous?.distance).toBe(0.45);
    expect(insertedDetection?.person_id).toBeNull();
    expect(createdFaceRecord).toBeNull();
  });

  test("status=disabled → detection sem person_id; sem face_record; sem capture (deps.captureSnapshot pode ser undefined)", async () => {
    orchestratorResult = { personId: null, status: "disabled" };
    await processEvent(baseRaw as Parameters<typeof processEvent>[0], "cam-1", {
      captureSnapshot: captureSnapshotStub,
      resolveReid: async () => orchestratorResult,
    });
    expect(insertedDetection).toBeDefined();
    expect(insertedDetection?.person_id).toBeNull();
    expect((insertedDetection?.face_attrs as Record<string, unknown>).reid_status).toBe("disabled");
    expect(createdFaceRecord).toBeNull();
  });

  test("event.bbox normalized 0..1 é denormalizado a pixel ints antes do orchestrator", async () => {
    let bboxPassed: { x: number; y: number; w: number; h: number } | null = null;
    // Frame default 2688x1520. event.bbox vem normalizado 0..1.
    // Raw fixed-point [x1,y1,x2,y2] = [1638, 1638, 4915, 4915] over scale 8192
    //   → normalized bbox {x: 0.1999, y: 0.1999, w: 0.40, h: 0.40}
    //   → pixel ints {x: 537, y: 303, w: 1075, h: 608}
    //   → x+w = 1612 ≤ 2688; y+h = 911 ≤ 1520 (dentro do frame).
    const rawWithBbox = {
      received_at: "2026-05-20T14:30:00Z",
      index: 1,
      parsed: {
        code: "FaceDetection",
        action: "Start" as const,
        data: {
          RealUTC: REAL_UTC,
          Object: { ObjectID: 99, BoundingBox: [1638, 1638, 4915, 4915] },
        },
      },
    };
    await processEvent(rawWithBbox as Parameters<typeof processEvent>[0], "cam-1", {
      captureSnapshot: captureSnapshotStub,
      resolveReid: async (input) => {
        bboxPassed = input.bbox;
        return { personId: null, status: "disabled" };
      },
    });
    expect(bboxPassed).not.toBeNull();
    // Todos devem ser inteiros (sidecar /embed espera Form(int))
    expect(Number.isInteger(bboxPassed!.x)).toBe(true);
    expect(Number.isInteger(bboxPassed!.y)).toBe(true);
    expect(Number.isInteger(bboxPassed!.w)).toBe(true);
    expect(Number.isInteger(bboxPassed!.h)).toBe(true);
    // Sanity bounds: dentro do frame 2688x1520
    expect(bboxPassed!.x).toBeGreaterThanOrEqual(0);
    expect(bboxPassed!.y).toBeGreaterThanOrEqual(0);
    expect(bboxPassed!.x + bboxPassed!.w).toBeLessThanOrEqual(2688);
    expect(bboxPassed!.y + bboxPassed!.h).toBeLessThanOrEqual(1520);
  });
});
