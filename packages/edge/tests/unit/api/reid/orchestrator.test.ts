import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { EmbedResult } from "@vipcam/shared";
import type { DecideMatchResult } from "../../../../src/api/reid/match-policy.js";

let embedReturn: EmbedResult | Error = new Error("not configured");
let decideReturn: DecideMatchResult = { decision: "new_person" };
let envOverride: Record<string, unknown> = {};

const installMocks = () => {
  mock.module("../../../../src/discovery/image-probe/reid-client.js", () => ({
    embed: async () => {
      if (embedReturn instanceof Error) throw embedReturn;
      return embedReturn;
    },
    ReidError: class extends Error {},
  }));
  mock.module("../../../../src/api/reid/match-policy.js", () => ({
    decideMatch: async () => decideReturn,
  }));
  mock.module("../../../../src/config/env.js", () => ({
    getEnv: () => ({
      REID_ENABLED: true,
      REID_BASE_URL: "http://x",
      REID_DIST_STRICT: 0.35,
      REID_DIST_LOOSE: 0.55,
      SNAPSHOTS_DIR: "/tmp/snaps",
      ...envOverride,
    }),
  }));
};
installMocks();

import { resolvePersonIdViaReid } from "../../../../src/api/reid/orchestrator.js";

const baseInput = {
  cameraId: "cam-1",
  detectionId: "det-1",
  detectedAt: new Date("2026-05-20T14:30:00Z"),
  sessionId: "sess-1",
  bbox: { x: 100, y: 100, w: 200, h: 200 },
  frameBytes: Buffer.from([0xff, 0xd8]),
};

beforeEach(() => {
  embedReturn = new Error("not configured");
  decideReturn = { decision: "new_person" };
  envOverride = {};
  installMocks();
});

describe("resolvePersonIdViaReid", () => {
  test("REID_ENABLED=false → status=disabled, sem embed call", async () => {
    envOverride = { REID_ENABLED: false };
    installMocks();
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("disabled");
    expect(r.personId).toBeNull();
  });

  test("embed throws → status=inherited_session + sessionInheritedPersonId", async () => {
    embedReturn = new Error("ECONNREFUSED");
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: "p-inherited",
    });
    expect(r.status).toBe("inherited_session");
    expect(r.personId).toBe("p-inherited");
    expect(r.reidError).toBeDefined();
  });

  test("embed throws + sem session inheritance → status=unavailable + personId=null", async () => {
    embedReturn = new Error("timeout");
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("unavailable");
    expect(r.personId).toBeNull();
  });

  test("decision=strict → status=matched_strict, personId=candidate.person_id", async () => {
    embedReturn = {
      embedding: Array(512).fill(0.01),
      det_score: 0.9,
      infer_ms: 28,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
      crop_jpeg_b64: "/9j/4AAQ==",
    };
    decideReturn = {
      decision: "strict",
      candidate: { face_record_id: "fr-1", person_id: "p-existing", distance: 0.2 },
    };
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("matched_strict");
    expect(r.personId).toBe("p-existing");
    expect(r.reidDistance).toBe(0.2);
  });

  test("decision=new_person → status=new_person + personId=null", async () => {
    embedReturn = {
      embedding: Array(512).fill(0.01),
      det_score: 0.9,
      infer_ms: 28,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
      crop_jpeg_b64: "/9j/4AAQ==",
    };
    decideReturn = { decision: "new_person" };
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("new_person");
    expect(r.personId).toBeNull();
    expect(r.embedding).toBeDefined();
  });

  test("decision=borderline → status=borderline + candidate exposto", async () => {
    embedReturn = {
      embedding: Array(512).fill(0.01),
      det_score: 0.9,
      infer_ms: 28,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
      crop_jpeg_b64: "/9j/4AAQ==",
    };
    decideReturn = {
      decision: "borderline",
      candidate: { face_record_id: "fr-2", person_id: "p-maybe", distance: 0.45 },
    };
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("borderline");
    expect(r.personId).toBeNull();
    expect(r.borderlineCandidate).toEqual({
      face_record_id: "fr-2",
      person_id: "p-maybe",
      distance: 0.45,
    });
  });
});
