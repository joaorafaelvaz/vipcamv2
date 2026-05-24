import { describe, expect, test } from "bun:test";
import { faceRecords } from "../../../src/persistence/schema/face-records.js";

describe("face_records schema (Onda 7)", () => {
  test("has new columns model_name, model_revision, det_score", () => {
    type Cols = keyof typeof faceRecords;
    const required: Cols[] = ["model_name", "model_revision", "det_score"] as Cols[];
    for (const col of required) {
      expect(faceRecords[col]).toBeDefined();
    }
  });

  test("embedding is NOT NULL", () => {
    expect((faceRecords.embedding as unknown as { notNull?: boolean }).notNull).toBe(true);
  });

  test("model_name has default 'buffalo_s'", () => {
    expect((faceRecords.model_name as unknown as { default?: string }).default).toBe("buffalo_s");
  });

  test("model_revision has default 'insightface-0.7.3'", () => {
    expect((faceRecords.model_revision as unknown as { default?: string }).default).toBe(
      "insightface-0.7.3",
    );
  });
});
