import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getDb } from "../../../src/persistence/db.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";

let cameraId: string;
const createdPersonIds: string[] = [];

beforeEach(async () => {
  const [cam] = await getDb().execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam-staff') RETURNING id
  `);
  if (!cam) throw new Error("camera insert returned no row");
  cameraId = cam.id;
  createdPersonIds.length = 0;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  for (const pid of createdPersonIds) {
    await db.execute(sql`DELETE FROM persons WHERE id = ${pid}`);
  }
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

async function mkPerson(): Promise<string> {
  const p = await personsRepo.create({ display_name: "x" });
  createdPersonIds.push(p.id);
  return p.id;
}

// Datas relativas a Date.now() (não hardcoded) — robusto à data de execução vs now() do Postgres.
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("personsRepo.isStaffLike", () => {
  test("staff-like quando presença em >= minHours slots de hora distintos", async () => {
    const staff = await mkPerson();
    const base = Date.now();
    for (let h = 0; h < 4; h++) {
      await detectionsRepo.create({
        camera_id: cameraId,
        person_id: staff,
        session_id: null,
        face_attrs: {},
        detected_at: new Date(base - h * HOUR), // 4 slots de hora distintos, recentes
        raw_event: {},
      });
    }
    expect(await personsRepo.isStaffLike(staff, 7, 3)).toBe(true);
  });

  test("não staff-like quando presença em poucos slots de hora", async () => {
    const client = await mkPerson();
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: client,
      session_id: null,
      face_attrs: {},
      detected_at: new Date(Date.now() - HOUR),
      raw_event: {},
    });
    expect(await personsRepo.isStaffLike(client, 7, 3)).toBe(false);
  });

  test("respeita lookbackDays (detecções fora da janela não contam)", async () => {
    const old = await mkPerson();
    const base = Date.now() - 8 * DAY; // além do lookback de 7 dias
    for (let h = 0; h < 4; h++) {
      await detectionsRepo.create({
        camera_id: cameraId,
        person_id: old,
        session_id: null,
        face_attrs: {},
        detected_at: new Date(base - h * HOUR),
        raw_event: {},
      });
    }
    expect(await personsRepo.isStaffLike(old, 7, 3)).toBe(false);
  });
});
