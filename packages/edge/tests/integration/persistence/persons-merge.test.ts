import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { faceRecordsRepo } from "../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { getDb } from "../../../src/persistence/db.js";

let srcId: string;
let dstId: string;

function vec(seed: number): number[] {
  return Array.from({ length: 512 }, (_, i) => (seed * (i + 1)) / 1e6);
}

beforeEach(async () => {
  const src = await personsRepo.create({
    display_name: "Source anônima",
    person_type: "anonymous",
    first_seen_at: new Date("2026-05-15T10:00:00Z"),
    last_seen_at: new Date("2026-05-20T14:00:00Z"),
    total_visits: 3,
  });
  srcId = src.id;
  const dst = await personsRepo.create({
    display_name: "Destination cliente",
    person_type: "client",
    first_seen_at: new Date("2026-05-18T08:00:00Z"),
    last_seen_at: new Date("2026-05-19T12:00:00Z"),
    total_visits: 5,
    erp_client_id: "cliente-erp-123",
  });
  dstId = dst.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM person_merge_audit WHERE src_id IN (${srcId}, ${dstId}) OR dst_id IN (${srcId}, ${dstId})`);
  await db.execute(sql`DELETE FROM face_records WHERE person_id IN (${srcId}, ${dstId})`);
  await db.execute(sql`DELETE FROM persons WHERE id IN (${srcId}, ${dstId})`);
});

describe("personsRepo.mergeInto (Onda 7 §5.2)", () => {
  test("hard merge: src some, face_records migram, rollup correto, audit inserido", async () => {
    for (let i = 0; i < 2; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: srcId,
        embedding: vec(100 + i),
        snapshot_path: `2026-05-15/src-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
    }
    for (let i = 0; i < 4; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: dstId,
        embedding: vec(200 + i),
        snapshot_path: `2026-05-18/dst-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
    }

    await personsRepo.mergeInto(srcId, dstId, "user-test");

    const srcAfter = await personsRepo.findById(srcId);
    expect(srcAfter).toBeNull();

    const dstAfter = await personsRepo.findById(dstId);
    expect(dstAfter).not.toBeNull();
    expect(dstAfter!.total_visits).toBe(8);
    expect(dstAfter!.first_seen_at.toISOString()).toBe("2026-05-15T10:00:00.000Z");
    expect(dstAfter!.last_seen_at.toISOString()).toBe("2026-05-20T14:00:00.000Z");

    const db = getDb();
    const frCountRows = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM face_records WHERE person_id = ${dstId}`,
    );
    expect(frCountRows[0]?.c).toBe(5);

    const audit = await db.execute<{ id: string; src_id: string; dst_id: string; merged_by: string }>(
      sql`SELECT id, src_id, dst_id, merged_by FROM person_merge_audit WHERE src_id = ${srcId} AND dst_id = ${dstId}`,
    );
    expect(audit.length).toBe(1);
    expect(audit[0]?.merged_by).toBe("user-test");
  });

  test("merge é idempotente (chamar 2x: a segunda chamada throws 'src já não existe')", async () => {
    await personsRepo.mergeInto(srcId, dstId, "user-1");
    await expect(personsRepo.mergeInto(srcId, dstId, "user-2")).rejects.toThrow(/not found/i);
  });

  test("merge de srcId == dstId é rejeitado (proteção contra self-merge)", async () => {
    await expect(personsRepo.mergeInto(srcId, srcId, "user")).rejects.toThrow(/same/i);
  });
});
