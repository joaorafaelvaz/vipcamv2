import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { sessionsRepo } from "../../../src/persistence/repositories/sessions.repo.js";
import { getDb } from "../../../src/persistence/db.js";

let cameraId: string;
let personId: string;

beforeEach(async () => {
  const db = getDb();
  const [cam] = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam-fw')
    RETURNING id
  `);
  if (!cam) throw new Error("camera insert returned no row");
  cameraId = cam.id;
  const p = await personsRepo.create({ display_name: "Test" });
  personId = p.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM sessions WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${personId}`);
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

describe("detectionsRepo.findInWindow", () => {
  test("retorna ambas detections NULL e non-NULL person_id na janela", async () => {
    const sess = await sessionsRepo.create({
      camera_id: cameraId,
      person_id: null,
      started_at: new Date("2026-05-26T14:00:00Z"),
      last_seen_at: new Date("2026-05-26T14:00:00Z"),
      detection_count: 2,
    });
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: null,                      // anonymous
      session_id: sess.id,
      face_attrs: {},
      detected_at: new Date("2026-05-26T14:00:00Z"),
      raw_event: {},
    });
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: personId,                  // identified
      session_id: sess.id,
      face_attrs: {},
      detected_at: new Date("2026-05-26T14:01:00Z"),
      raw_event: {},
    });

    const rows = await detectionsRepo.findInWindow(
      new Date("2026-05-26T13:55:00Z"),
      new Date("2026-05-26T14:05:00Z"),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const nullCount = rows.filter((r) => r.person_id === null).length;
    const identifiedRows = rows.filter((r) => r.person_id === personId);
    expect(nullCount).toBeGreaterThanOrEqual(1);
    expect(identifiedRows.length).toBeGreaterThanOrEqual(1);
    // session_id deve estar populado no projection (required pelo auto-match
    // session-linkage path do orchestrator — Task 3).
    expect(identifiedRows[0]?.session_id).toBe(sess.id);
  });

  test("fora da janela não retorna", async () => {
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: null,
      session_id: null,
      face_attrs: {},
      detected_at: new Date("2026-05-26T12:00:00Z"),    // 2h antes
      raw_event: {},
    });
    const rows = await detectionsRepo.findInWindow(
      new Date("2026-05-26T13:55:00Z"),
      new Date("2026-05-26T14:05:00Z"),
    );
    const myDet = rows.find((r) => r.detected_at.getTime() === new Date("2026-05-26T12:00:00Z").getTime());
    expect(myDet).toBeUndefined();
  });
});
