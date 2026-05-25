import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { decideMatch } from "../../../../src/api/reid/match-policy.js";
import { faceRecordsRepo } from "../../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../../src/persistence/repositories/persons.repo.js";
import { getDb } from "../../../../src/persistence/db.js";

let personId: string;

function vecFromBase(seed: number, jitter = 0): number[] {
  return Array.from({ length: 512 }, (_, i) => {
    const v = ((seed * (i + 1)) % 1000) / 1000;
    return v + (Math.sin(i + jitter) * 0.001);
  });
}

beforeEach(async () => {
  const p = await personsRepo.create({ display_name: "Anchor" });
  personId = p.id;
});
afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM face_records WHERE person_id = ${personId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${personId}`);
});

describe("decideMatch ANN query (DB-deferred)", () => {
  test("empty DB → new_person", async () => {
    const r = await decideMatch({
      embedding: vecFromBase(1),
      modelName: "buffalo_s",
      modelRevision: "insightface-0.7.3",
      strictMax: 0.35,
      looseMax: 0.55,
    });
    expect(r.decision).toBe("new_person");
    expect(r.candidate).toBeUndefined();
  });

  test("model mismatch filter → new_person (zero rows)", async () => {
    await faceRecordsRepo.insertAndEvict({
      person_id: personId,
      embedding: vecFromBase(1),
      snapshot_path: "x.jpg",
      det_score: 0.9,
      model_name: "OUTRO_MODELO",
      model_revision: "y",
    });
    const r = await decideMatch({
      embedding: vecFromBase(1),
      modelName: "buffalo_s",
      modelRevision: "insightface-0.7.3",
      strictMax: 0.35,
      looseMax: 0.55,
    });
    expect(r.decision).toBe("new_person");
  });

  test("strict match — distância ~0 contra embedding idêntico", async () => {
    const emb = vecFromBase(1);
    const fr = await faceRecordsRepo.insertAndEvict({
      person_id: personId,
      embedding: emb,
      snapshot_path: "x.jpg",
      det_score: 0.9,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
    });
    const r = await decideMatch({
      embedding: emb,
      modelName: "buffalo_s",
      modelRevision: "insightface-0.7.3",
      strictMax: 0.35,
      looseMax: 0.55,
    });
    expect(r.decision).toBe("strict");
    expect(r.candidate?.face_record_id).toBe(fr.id);
    expect(r.candidate?.person_id).toBe(personId);
    expect(r.candidate?.distance).toBeLessThanOrEqual(0.001);
  });
});
