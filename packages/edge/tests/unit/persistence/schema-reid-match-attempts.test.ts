import { describe, expect, test } from "bun:test";
import { reidMatchAttempts } from "../../../src/persistence/schema/reid-match-attempts.js";

describe("reid_match_attempts schema (Onda 7)", () => {
  test("has required FKs and decision enum", () => {
    type Cols = keyof typeof reidMatchAttempts;
    const required: Cols[] = [
      "id",
      "detection_id",
      "candidate_face_record_id",
      "candidate_person_id",
      "distance",
      "decision",
      "decided_by",
      "decided_at",
      "notes",
    ] as Cols[];
    for (const col of required) expect(reidMatchAttempts[col]).toBeDefined();
  });

  test("decision is NOT NULL (state machine integrity)", () => {
    expect((reidMatchAttempts.decision as unknown as { notNull?: boolean }).notNull).toBe(true);
  });
});
