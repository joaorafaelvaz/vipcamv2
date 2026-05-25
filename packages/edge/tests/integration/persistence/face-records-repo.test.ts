import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getDb } from "../../../src/persistence/db.js";
import { faceRecordsRepo } from "../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";

function vec(seed: number): number[] {
  return Array.from({ length: 512 }, (_, i) => (seed * (i + 1)) / 1e6);
}

let personId: string;
let dstPersonId: string;

beforeEach(async () => {
  const p = await personsRepo.create({ display_name: "Test src" });
  personId = p.id;
  const q = await personsRepo.create({ display_name: "Test dst" });
  dstPersonId = q.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM face_records WHERE person_id IN (${personId}, ${dstPersonId})`);
  await db.execute(sql`DELETE FROM persons WHERE id IN (${personId}, ${dstPersonId})`);
});

describe("faceRecordsRepo.insertAndEvict", () => {
  test("inserts 1st through 5th — all kept", async () => {
    for (let i = 0; i < 5; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: vec(i + 1),
        snapshot_path: `2026-05-20/det-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
    }
    const db = getDb();
    const countRows = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM face_records WHERE person_id = ${personId}`,
    );
    expect(countRows[0]?.c).toBe(5);
  });

  test("6th insert evicts oldest (FIFO via created_at)", async () => {
    const inserts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const fr = await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: vec(i + 1),
        snapshot_path: `2026-05-20/det-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
      inserts.push(fr.id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const db = getDb();
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM face_records WHERE person_id = ${personId} ORDER BY created_at ASC`,
    );
    expect(rows.length).toBe(5);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(inserts[0]!);
    expect(ids).toContain(inserts[5]!);
  });
});

describe("faceRecordsRepo.transferToPerson", () => {
  test("moves face_records de src pra dst e aplica FIFO eviction em dst", async () => {
    for (let i = 0; i < 4; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: dstPersonId,
        embedding: vec(100 + i),
        snapshot_path: `2026-05-20/dst-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    for (let i = 0; i < 3; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: vec(200 + i),
        snapshot_path: `2026-05-20/src-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    await faceRecordsRepo.transferToPerson(personId, dstPersonId);

    const db = getDb();
    const srcRows = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM face_records WHERE person_id = ${personId}`,
    );
    expect(srcRows[0]?.c).toBe(0);
    const dstRows = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM face_records WHERE person_id = ${dstPersonId}`,
    );
    expect(dstRows[0]?.c).toBe(5);
  });
});
