import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { listPendingEnriched } from "../../../src/api/match-pending.js";
import { getDb } from "../../../src/persistence/db.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { matchAttemptsRepo } from "../../../src/persistence/repositories/match-attempts.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";

let cameraId: string;
let wPersonId: string;
let detectionId: string;
let checkinErpId: string;
let attemptId: string;

beforeEach(async () => {
  const db = getDb();
  const [cam] = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam-mp')
    RETURNING id
  `);
  if (!cam) throw new Error("camera insert returned no row");
  cameraId = cam.id;

  await db.execute(sql`
    INSERT INTO erp_clients (erp_id, name, is_active)
    VALUES ('cli-y-mp', 'Maria MP', true)
    ON CONFLICT (erp_id) DO UPDATE SET name = EXCLUDED.name
  `);
  await personsRepo.create({
    display_name: "Maria MP",
    person_type: "client",
    erp_client_id: "cli-y-mp",
  });

  const w = await personsRepo.create({
    display_name: "Wagner W",
    person_type: "client",
    thumbnail_path: "2026-05-20/wagner.jpg",
  });
  wPersonId = w.id;

  const det = await detectionsRepo.create({
    camera_id: cameraId,
    person_id: wPersonId,
    session_id: null,
    face_attrs: {},
    detected_at: new Date("2026-05-26T14:00:00Z"),
    raw_event: {},
  });
  detectionId = det.id;

  checkinErpId = `chk-mp-${Date.now()}`;
  await db.execute(sql`
    INSERT INTO erp_checkins (erp_id, erp_client_id, event_type, occurred_at, metadata)
    VALUES (${checkinErpId}, 'cli-y-mp', 'in', ${new Date("2026-05-26T14:00:30Z")}, '{}')
  `);

  const att = await matchAttemptsRepo.create({
    detection_id: detectionId,
    erp_checkin_id: checkinErpId,
    decision: "ambiguous",
    previous_person_id: wPersonId,
    previous_person_snapshot: { id: wPersonId, display_name: "Wagner W (snap)" },
  });
  attemptId = att.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM match_attempts WHERE erp_checkin_id = ${checkinErpId}`);
  await db.execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${wPersonId} OR erp_client_id = 'cli-y-mp'`);
  await db.execute(sql`DELETE FROM erp_clients WHERE erp_id = 'cli-y-mp'`);
  await db.execute(sql`DELETE FROM erp_checkins WHERE erp_id = ${checkinErpId}`);
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

describe("listPendingEnriched previous_person (Onda 9-A)", () => {
  test("retorna previous_person populado quando previous_person_id != null", async () => {
    const items = await listPendingEnriched(50);
    const ours = items.find((i) => i.match_attempt_id === attemptId);
    expect(ours).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(ours!.previous_person).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(ours!.previous_person!.id).toBe(wPersonId);
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(ours!.previous_person!.display_name).toBe("Wagner W");
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(ours!.previous_person!.person_type).toBe("client");
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(ours!.previous_person!.thumbnail_path).toBe("2026-05-20/wagner.jpg");
  });

  test("clássico (previous_person_id null) → previous_person undefined", async () => {
    const db = getDb();
    const otherCheckin = `chk-classic-${Date.now()}`;
    await db.execute(sql`
      INSERT INTO erp_checkins (erp_id, erp_client_id, event_type, occurred_at, metadata)
      VALUES (${otherCheckin}, 'cli-y-mp', 'in', ${new Date("2026-05-26T15:00:00Z")}, '{}')
    `);
    const classicAtt = await matchAttemptsRepo.create({
      detection_id: null,
      erp_checkin_id: otherCheckin,
      decision: "ambiguous",
    });
    const items = await listPendingEnriched(50);
    const classic = items.find((i) => i.match_attempt_id === classicAtt.id);
    expect(classic).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(classic!.previous_person).toBeUndefined();
    await db.execute(sql`DELETE FROM match_attempts WHERE id = ${classicAtt.id}`);
    await db.execute(sql`DELETE FROM erp_checkins WHERE erp_id = ${otherCheckin}`);
  });
});
